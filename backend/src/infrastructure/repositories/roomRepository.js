// Supabase-backed Room repository (P10-T02) — replaces Phase 08's
// in-memory Map with the real `rooms`/`room_players` tables
// (DATABASE_DESIGN.md §2/§3, backend/supabase/migrations/0001_core_tables.sql).
//
// `room_players` is a real junction table (room_id, player_id, is_ready,
// joined_at) — it has no display_name/avatar_url/is_host columns of its
// own. Those come from a `profiles` lookup (display_name/avatar_url) and
// from comparing player_id against rooms.host_id (is_host), joined in JS
// rather than via PostgREST's embedded-resource select syntax — same flat
// "one simple query, map the row" style infrastructure/repositories/
// boardRepository.js already established, chosen again here for the same
// reason: simpler to read and to test against a mock client.
//
// supabase is an injected first parameter on every export, not a
// module-level singleton import — same contract boardRepository.js's own
// fetchBoardTiles() already uses, and for the same reason: fully testable
// against a mock client, no real network call.
//
// Every export keeps the exact same name and returned record shape
// (`{ id, joinCode, hostId, status, createdAt, updatedAt, players: [...] }`)
// the old in-memory version had, so room.controller.js's/socketServer.js's
// call sites only need `await` added, not a rewrite — the one deliberate
// exception is that every export is now `async` (real I/O), where the old
// Map-backed version was synchronous.
//
// GameState no longer bolts onto this record (Phase 08's own stated
// follow-on: "will need a real split once persistence exists") — see
// infrastructure/repositories/gameRepository.js for that half.

function requireSupabase(supabase, fnName) {
  if (!supabase) {
    throw new Error(`roomRepository.${fnName}: no Supabase client configured (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY unset)`);
  }
}

/**
 * @typedef {import('../../domain/room.js').Room & { players: object[] }} RoomRecord
 */

async function fetchPlayers(supabase, roomId, hostId) {
  const { data: roomPlayers, error: rpError } = await supabase
    .from('room_players')
    .select('player_id, is_ready, joined_at, zodiac')
    .eq('room_id', roomId);
  if (rpError) {
    throw new Error(`roomRepository: failed to load room_players for room '${roomId}': ${rpError.message}`);
  }

  const playerIds = roomPlayers.map((rp) => rp.player_id);
  let profiles = [];
  if (playerIds.length > 0) {
    const { data, error: profError } = await supabase.from('profiles').select('id, display_name, avatar_url').in('id', playerIds);
    if (profError) {
      throw new Error(`roomRepository: failed to load profiles for room '${roomId}': ${profError.message}`);
    }
    profiles = data;
  }

  const profileById = new Map(profiles.map((p) => [p.id, p]));
  return [...roomPlayers]
    .sort((a, b) => new Date(a.joined_at).getTime() - new Date(b.joined_at).getTime())
    .map((rp) => {
      const profile = profileById.get(rp.player_id);
      return {
        playerId: rp.player_id,
        // Falls back to the raw id if `profiles` has no row yet (e.g. this
        // environment's still-missing live Supabase connection, or a race
        // with P03's profiles-auto-creation trigger) — same "structurally
        // correct, real content pending" posture as boardRepository.js's
        // own placeholder handling, not a silent swallow of a real error.
        displayName: profile?.display_name ?? rp.player_id,
        avatarUrl: profile?.avatar_url ?? null,
        isReady: rp.is_ready,
        isHost: rp.player_id === hostId,
        zodiac: rp.zodiac ?? null,
      };
    });
}

function toRoomRecord(row, players) {
  return {
    id: row.id,
    joinCode: row.join_code,
    hostId: row.host_id,
    status: row.status,
    ruleset: row.ruleset ?? 'CLASSIC',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    players,
  };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {RoomRecord} roomObj
 * @returns {Promise<RoomRecord>}
 */
export async function createRoom(supabase, roomObj) {
  requireSupabase(supabase, 'createRoom');

  const { data: roomRow, error: roomError } = await supabase
    .from('rooms')
    .insert({
      id: roomObj.id,
      join_code: roomObj.joinCode,
      host_id: roomObj.hostId,
      status: roomObj.status ?? 'waiting_for_players',
      created_at: roomObj.createdAt,
      updated_at: roomObj.updatedAt ?? roomObj.createdAt,
    })
    .select()
    .single();
  if (roomError) {
    throw new Error(`roomRepository.createRoom: ${roomError.message}`);
  }

  const playerRows = (roomObj.players ?? []).map((p) => ({
    room_id: roomRow.id,
    player_id: p.playerId,
    is_ready: p.isReady ?? false,
    joined_at: roomObj.createdAt,
    zodiac: p.zodiac ?? null,
  }));
  if (playerRows.length > 0) {
    const { error: rpError } = await supabase.from('room_players').insert(playerRows);
    if (rpError) {
      throw new Error(`roomRepository.createRoom: failed to insert room_players: ${rpError.message}`);
    }
  }

  const players = await fetchPlayers(supabase, roomRow.id, roomRow.host_id);
  return toRoomRecord(roomRow, players);
}

/** @param {import('@supabase/supabase-js').SupabaseClient} supabase @param {string} roomId @returns {Promise<RoomRecord|null>} */
export async function getRoomById(supabase, roomId) {
  requireSupabase(supabase, 'getRoomById');

  const { data: row, error } = await supabase.from('rooms').select('*').eq('id', roomId).single();
  if (error || !row) {
    return null;
  }
  const players = await fetchPlayers(supabase, row.id, row.host_id);
  return toRoomRecord(row, players);
}

/**
 * Joining is by the shareable `joinCode`, not the internal `roomId` —
 * API_CONTRACT.md's own privacy reasoning, unchanged from the in-memory
 * version this replaces.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} joinCode
 * @returns {Promise<RoomRecord|null>}
 */
export async function getRoomByJoinCode(supabase, joinCode) {
  requireSupabase(supabase, 'getRoomByJoinCode');

  const { data: row, error } = await supabase.from('rooms').select('*').eq('join_code', joinCode).single();
  if (error || !row) {
    return null;
  }
  const players = await fetchPlayers(supabase, row.id, row.host_id);
  return toRoomRecord(row, players);
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} roomId
 * @param {RoomRecord} roomObj - the intended replacement record: `status`,
 *   `hostId` (wired 2026-08-21 — was previously ignored even when present,
 *   see below), and `players[]` (isReady/zodiac changes on existing rows,
 *   new joiners inserted, and — also wired 2026-08-21 — any existing member
 *   *absent* from this list is genuinely removed, not just left stale).
 *   `joinCode`/`createdAt` remain immutable, never re-written here even if
 *   present on roomObj.
 * @returns {Promise<RoomRecord|null>} null if no room with this id exists
 */
export async function updateRoom(supabase, roomId, roomObj, knownExisting) {
  requireSupabase(supabase, 'updateRoom');

  // `knownExisting` (2026-09-04): every caller in room.controller.js —
  // setReady, setZodiac, startGame, leaveRoom, kickPlayer — has ALREADY
  // fetched this exact record with getRoomById, for its own membership/status
  // checks, immediately before calling here. Re-fetching it cost three more
  // sequential Supabase round trips per lobby action (rooms, room_players,
  // profiles). Measured 2026-09-04: the deployed backend runs in Render's
  // gcp-us-west1 (Oregon) — confirmed from DNS — while Supabase answers from
  // Asia, so each of those is a Pacific crossing of roughly 180ms. The
  // redundant read alone was over half a second of dead time on every
  // "Sẵn Sàng" click. Optional, so any caller that genuinely has no record
  // still gets the old behaviour.
  const existing = knownExisting ?? (await getRoomById(supabase, roomId));
  if (!existing) {
    return null;
  }

  // hostId, wired 2026-08-21 (leaveRoom's host-transfer, room.controller.js):
  // previously silently ignored even when the caller passed a changed one —
  // real host transfer on leave needs this column to actually move.
  const { data: row, error } = await supabase
    .from('rooms')
    .update({ status: roomObj.status, host_id: roomObj.hostId ?? existing.hostId })
    .eq('id', roomId)
    .select()
    .single();
  if (error) {
    throw new Error(`roomRepository.updateRoom: ${error.message}`);
  }

  const newPlayerIds = new Set((roomObj.players ?? []).map((p) => p.playerId));
  // Real removal, wired 2026-08-21 (leaveRoom/kickPlayer, room.controller.js):
  // previously any existing member missing from roomObj.players was simply
  // never touched — its room_players row stayed forever, so a "leave"/"kick"
  // call would compute the right in-memory result but never actually
  // persist a removal. Deleted before the insert/update loop below, so a
  // removed-then-somehow-still-listed id (shouldn't happen from any real
  // caller) can't race with its own re-insert.
  const removedPlayerIds = existing.players.map((p) => p.playerId).filter((id) => !newPlayerIds.has(id));
  if (removedPlayerIds.length > 0) {
    const { error: delError } = await supabase.from('room_players').delete().eq('room_id', roomId).in('player_id', removedPlayerIds);
    if (delError) {
      throw new Error(`roomRepository.updateRoom: failed to delete room_players: ${delError.message}`);
    }
  }

  // ONE upsert for the whole roster (2026-09-04), not a sequential
  // update-or-insert per player. `room_players`' primary key is
  // (room_id, player_id) — migration 0001 — so an upsert on that conflict
  // target expresses exactly what this loop was doing by hand, and PostgREST
  // applies the whole batch in a single statement. The loop cost one Pacific
  // round trip PER PLAYER: at a 4-player table that was four sequential
  // ~180ms hops for a change that only ever touches one player's own row.
  //
  // `joined_at` is deliberately omitted for existing rows rather than
  // defaulted: sending `new Date()` for every row would rewrite current
  // members' join times on every ready-toggle, and fetchPlayers sorts the
  // roster by exactly that column — so the lobby order would reshuffle on
  // any update. The column has a `DEFAULT now()`, which covers genuinely new
  // rows, so leaving it out both fixes that and keeps inserts correct.
  const existingPlayerIds = new Set(existing.players.map((p) => p.playerId));
  const playerRows = (roomObj.players ?? []).map((p) => ({
    room_id: roomId,
    player_id: p.playerId,
    is_ready: p.isReady ?? false,
    zodiac: p.zodiac ?? null,
    ...(existingPlayerIds.has(p.playerId) ? {} : { joined_at: new Date().toISOString() }),
  }));
  if (playerRows.length > 0) {
    const { error: upsertError } = await supabase
      .from('room_players')
      .upsert(playerRows, { onConflict: 'room_id,player_id' });
    if (upsertError) {
      throw new Error(`roomRepository.updateRoom: failed to upsert room_players: ${upsertError.message}`);
    }
  }

  // The roster is rebuilt from what was just written plus the display data
  // the caller already held, instead of a further two-query re-read
  // (room_players + profiles). Nothing here is a guess: is_ready/zodiac are
  // the values this function just persisted, displayName/avatarUrl come from
  // `existing` (they live in `profiles`, and no room mutation can change
  // them), and isHost is recomputed against the row's own fresh host_id so a
  // host transfer on leave is still reflected. Order follows the caller's
  // roster, which is itself derived from `existing` — i.e. fetchPlayers'
  // joined_at ordering, preserved.
  const knownById = new Map(existing.players.map((p) => [p.playerId, p]));
  const players = (roomObj.players ?? []).map((p) => {
    const known = knownById.get(p.playerId);
    return {
      playerId: p.playerId,
      displayName: p.displayName ?? known?.displayName ?? p.playerId,
      avatarUrl: p.avatarUrl ?? known?.avatarUrl ?? null,
      isReady: p.isReady ?? false,
      isHost: p.playerId === row.host_id,
      zodiac: p.zodiac ?? null,
    };
  });
  return toRoomRecord(row, players);
}

/**
 * Resolves a player's own "active room" — GET /api/v1/auth/me
 * (API_CONTRACT.md, P03-T03, wired 2026-08-21 alongside the frontend
 * session-resume slice this endpoint exists for). A room they currently
 * have a `room_players` seat in, excluding only `abandoned` ones — every
 * other status (`waiting_for_players`/`ready_check`/`starting`/
 * `in_progress`) is something worth resuming into. Picks the
 * most-recently-updated one if a player somehow belongs to more than
 * one — no automatic cleanup removes a `room_players` row for someone who
 * just closes their tab without calling `leave` (see `leaveRoom`'s own
 * docs), so this is a real, if rare, possibility, not a theoretical one.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} playerId
 * @returns {Promise<string|null>}
 */
export async function findActiveRoomIdForPlayer(supabase, playerId) {
  requireSupabase(supabase, 'findActiveRoomIdForPlayer');

  const { data: memberships, error: rpError } = await supabase.from('room_players').select('room_id').eq('player_id', playerId);
  if (rpError) {
    throw new Error(`roomRepository.findActiveRoomIdForPlayer: failed to load room_players for player '${playerId}': ${rpError.message}`);
  }
  const roomIds = memberships.map((m) => m.room_id);
  if (roomIds.length === 0) {
    return null;
  }

  const { data: rooms, error: roomsError } = await supabase.from('rooms').select('id, status, updated_at, games(status)').in('id', roomIds);
  if (roomsError) {
    throw new Error(`roomRepository.findActiveRoomIdForPlayer: failed to load rooms: ${roomsError.message}`);
  }

  // Filter out abandoned rooms AND rooms whose game has already ended
  const active = rooms
    .filter((r) => {
      if (r.status === 'abandoned') return false;
      const gameStatus = Array.isArray(r.games) ? r.games[0]?.status : r.games?.status;
      if (gameStatus === 'finished' || gameStatus === 'aborted') return false;
      return true;
    })
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  return active[0]?.id ?? null;
}
