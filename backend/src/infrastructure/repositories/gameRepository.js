// GameState repository (P10-T02) — the "real per-game store" Phase 08's
// own roomRepository.js header already flagged as a necessary follow-on
// once persistence existed ("GameState lives bolted onto the room record
// in the same in-memory Map. Works today; will need a real split once
// persistence exists").
//
// Deliberately hybrid, not a pure Supabase pass-through:
// - `liveGameStates` (in-memory Map, keyed by roomId) is the source of
//   truth *during active play* — every C2S_GAME_ACTION reads and writes
//   here, same low-latency synchronous access the old bolted-on-room-record
//   version had. A live match is never round-tripped through Postgres on
//   every single action.
// - `games` + `game_state_snapshots` (DATABASE_DESIGN.md §4/§9,
//   GAME_STATE_MACHINE.md §9 "Recovery") are the *durable* copy, written
//   only at the three documented trigger points — turn end, bankruptcy,
//   game over — matching `game_state_snapshots.reason`'s own CHECK
//   constraint (`'turn_end' | 'bankruptcy' | 'game_over'`), not after every
//   action. Snapshotting on every action isn't just unnecessary, it's
//   schema-impossible: most actions (ROLL_DICE, PLACE_BID, a CHOICE draw)
//   don't correspond to any of the three allowed reasons, and writing one
//   anyway would either violate the CHECK constraint or require loosening
//   it against the approved design. This is the resolution the user chose
//   explicitly when this exact tension was flagged during P10-T02.
//
// One open gap, flagged rather than silently resolved: a brand-new game's
// *first* persistence (room.controller.js's startGame, before any turn has
// ever ended) doesn't correspond to any of the three approved reasons
// either — "game start" isn't in GAME_STATE_MACHINE.md §9's list. This
// repository lets the caller pass any of the three anyway (startGame uses
// 'turn_end' as the closest fit, so a freshly-started game is at least
// recoverable) — a pragmatic choice, not an approved one; worth a real
// decision (e.g. a 4th CHECK value) if this matters beyond this task.

const liveGameStates = new Map(); // roomId -> GameState

function cloneState(state) {
  return state ? structuredClone(state) : state;
}

/** @param {string} roomId @returns {object|null} a copy of the live GameState, or null if not hot-loaded */
export function getGameState(roomId) {
  return cloneState(liveGameStates.get(roomId) ?? null);
}

/** @param {string} roomId @param {object} gameState */
export function setGameState(roomId, gameState) {
  liveGameStates.set(roomId, cloneState(gameState));
}

/** Test-only reset — mirrors roomRepository.js's old _resetForTests, scoped to this module's own in-memory half. */
export function _resetForTests() {
  liveGameStates.clear();
}

export const SNAPSHOT_REASONS = Object.freeze(['turn_end', 'bankruptcy', 'game_over']);

/**
 * Pure decision of whether (and why) a durable snapshot should be written
 * after one action, per GAME_STATE_MACHINE.md §9's documented cadence.
 * Takes only the action type and the before/after GameState — no
 * turnMachine.js changes needed, since transitionTurn's own cascading
 * END_TURN->NEXT_PLAYER->TURN_START (turnMachine.js's file header) already
 * means the *submitted* action type, not the resulting phase, is the
 * reliable "a turn just ended" signal.
 * @param {string} actionType
 * @param {object|null} previousGameState
 * @param {object} nextGameState
 * @returns {(typeof SNAPSHOT_REASONS[number])|null} null when no trigger applies — expected for most actions, not an error
 */
export function deriveSnapshotReason(actionType, previousGameState, nextGameState) {
  if (nextGameState.status === 'finished' || nextGameState.status === 'aborted') {
    return 'game_over';
  }

  const previouslyBankruptIds = new Set((previousGameState?.players ?? []).filter((p) => p.bankrupt).map((p) => p.id));
  const newlyBankrupt = (nextGameState.players ?? []).some((p) => p.bankrupt && !previouslyBankruptIds.has(p.id));
  if (newlyBankrupt) {
    return 'bankruptcy';
  }

  if (actionType === 'END_TURN') {
    return 'turn_end';
  }

  return null;
}

/**
 * Upserts the durable copy: `games` (denormalized/snapshot-cadence fields,
 * DATABASE_DESIGN.md §4 — also required so `game_state_snapshots`' FK has
 * a row to reference) then `game_state_snapshots` itself (the full
 * GameState blob, §9).
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {object} gameState
 * @param {(typeof SNAPSHOT_REASONS[number])} reason
 */
export async function saveSnapshot(supabase, gameState, reason) {
  if (!supabase) {
    throw new Error('gameRepository.saveSnapshot: no Supabase client configured (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY unset)');
  }
  if (!SNAPSHOT_REASONS.includes(reason)) {
    throw new TypeError(`gameRepository.saveSnapshot: reason must be one of ${SNAPSHOT_REASONS.join(', ')}, got '${reason}'`);
  }

  const { error: gameError } = await supabase.from('games').upsert(
    {
      id: gameState.id,
      room_id: gameState.roomId,
      board_id: gameState.boardId,
      status: gameState.status,
      current_turn_index: gameState.currentTurnIndex,
      state_version: gameState.stateVersion,
      started_at: gameState.startedAt,
      ended_at: gameState.endedAt,
    },
    { onConflict: 'id' }
  );
  if (gameError) {
    throw new Error(`gameRepository.saveSnapshot: failed to upsert games: ${gameError.message}`);
  }

  const { error: snapshotError } = await supabase.from('game_state_snapshots').upsert(
    {
      game_id: gameState.id,
      state: gameState,
      reason,
      created_at: new Date().toISOString(),
    },
    { onConflict: 'game_id' }
  );
  if (snapshotError) {
    throw new Error(`gameRepository.saveSnapshot: failed to upsert game_state_snapshots: ${snapshotError.message}`);
  }
}

// Win Condition design (2026-08-19), wired 2026-08-21 — GameState.endReason
// ('elimination'|'final_phase', domain/gameState.js) is the only source for
// match_results.result_type; 'aborted' has no endReason mapping because
// nothing sets it yet (GAME_DESIGN_SPEC.md §18's "Abandoned" match-ending
// condition is still [OPEN DESIGN DECISION]/unbuilt) — saveMatchResult
// below throws rather than guesses if it's ever asked to save an unmapped
// endReason, same "fail loud on a real gap, don't silently paper over it"
// posture saveSnapshot's own reason validation already uses.
export const RESULT_TYPES_BY_END_REASON = Object.freeze({
  elimination: 'elimination_win',
  final_phase: 'net_worth_win',
});

/**
 * Writes the terminal `match_results` row (DATABASE_DESIGN.md §13) — a
 * one-time, game-over-only counterpart to saveSnapshot's every-trigger-point
 * writes. Called once, from persistAndBroadcast (socketServer.js), at the
 * exact moment deriveSnapshotReason first returns 'game_over' for a real
 * game — the new GAME_ALREADY_FINISHED guard in handleGameAction makes a
 * second call for the same game structurally unreachable in production, but
 * `onConflict: 'game_id'` keeps this safely re-runnable anyway, matching
 * saveSnapshot's own idempotent-upsert posture rather than a plain insert
 * that would throw on match_results' own UNIQUE(game_id) constraint.
 * winner_game_player_id is nullable on the table itself, so a genuinely
 * winnerless outcome (not reachable today — every ranked player always gets
 * a finalRank) would still write a valid row rather than fail.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {object} gameState - status must already be 'finished'; players must already carry finalRank (settleGameEnd's own job, turnMachine.js)
 */
export async function saveMatchResult(supabase, gameState) {
  if (!supabase) {
    throw new Error('gameRepository.saveMatchResult: no Supabase client configured (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY unset)');
  }
  const resultType = RESULT_TYPES_BY_END_REASON[gameState.endReason];
  if (!resultType) {
    throw new TypeError(`gameRepository.saveMatchResult: no result_type mapping for endReason '${gameState.endReason}'`);
  }
  const winner = gameState.players.find((p) => p.finalRank === 1);

  const { error } = await supabase.from('match_results').upsert(
    {
      game_id: gameState.id,
      result_type: resultType,
      winner_game_player_id: winner?.id ?? null,
      ended_at: gameState.endedAt,
    },
    { onConflict: 'game_id' }
  );
  if (error) {
    throw new Error(`gameRepository.saveMatchResult: failed to upsert match_results: ${error.message}`);
  }
}

/**
 * Cold-load path: resolves `games` by `room_id` (the only FK from a room
 * to its game — `games.room_id` is UNIQUE, a room has at most one game
 * across its lifetime), then the latest snapshot for that game. Used when
 * `getGameState(roomId)` misses (server restart, or a room whose game was
 * never hot-loaded into this process).
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} roomId
 * @returns {Promise<object|null>} the full GameState blob, or null if this room has no game / no snapshot yet
 */
export async function loadGameStateFromSupabase(supabase, roomId) {
  if (!supabase) {
    throw new Error('gameRepository.loadGameStateFromSupabase: no Supabase client configured (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY unset)');
  }

  const { data: game, error: gameError } = await supabase.from('games').select('*').eq('room_id', roomId).single();
  if (gameError || !game) {
    return null;
  }

  const { data: snapshot, error: snapshotError } = await supabase
    .from('game_state_snapshots')
    .select('state')
    .eq('game_id', game.id)
    .single();
  if (snapshotError || !snapshot) {
    return null;
  }

  return snapshot.state;
}

/**
 * The "get whatever live GameState exists for this room, however it needs
 * to get loaded" composition — hot store first, then a best-effort cold
 * load from the durable snapshot, mirroring it back into the hot store so
 * subsequent calls in this process hit the fast path. Extracted (P10-T03)
 * so `handleGameAction` and the new `C2S_RECONNECT` handler
 * (infrastructure/websocket/socketServer.js) don't each reimplement the
 * same hot/cold fallback — a cold-load failure (no Supabase configured, a
 * transient query error) collapses to the same "not found" `null` a caller
 * already has to handle, not a thrown error a caller must remember to
 * catch a second time.
 * @param {string} roomId
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @returns {Promise<object|null>}
 */
/**
 * Resolves whether a room currently has a genuinely in-progress game —
 * GET /api/v1/auth/me (API_CONTRACT.md, P03-T03, wired 2026-08-21). Takes
 * the player's already-resolved `activeRoomId` (roomRepository.js's
 * `findActiveRoomIdForPlayer`), not a playerId directly.
 *
 * **A real bug, found live not by review, fixed here**: the first version
 * of this function queried `game_players` directly (`.eq('player_id', ...)`)
 * — structurally reasonable given the schema, but wrong in practice,
 * because *nothing in this entire backend ever writes to that table*.
 * Confirmed by grepping every source file: `saveSnapshot()` below is the
 * only writer touching `games` at all, and no code path anywhere inserts
 * into `game_players`, `properties`, `game_transactions`, `game_actions`,
 * or `game_events` — every real `PlayerGameState` only ever exists in the
 * in-memory hot store (`liveGameStates`) and, at snapshot time, inside
 * `game_state_snapshots.state`'s own JSONB blob (this file's own header
 * already documents *why*: "GameState lives in an in-memory hot Map during
 * play, durably snapshotted... only at the three approved trigger points" —
 * that snapshot is the *only* per-game persistence this design ever
 * produces). A `game_players`-keyed query was therefore structurally
 * guaranteed to return zero rows for every real game that has ever been
 * played — caught by actually reconnecting into a genuinely in-progress
 * match after a page reload and finding `activeGameId` still `null`, not
 * by inspecting the query itself. Fixed by querying `games.room_id`
 * instead — `games` itself *is* reliably written, and `games.room_id` is
 * `UNIQUE` (a room has at most one game across its whole lifetime), so this
 * sidesteps the empty table entirely rather than working around it.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} roomId
 * @returns {Promise<string|null>}
 */
export async function findActiveGameIdForRoom(supabase, roomId) {
  if (!supabase) {
    throw new Error('gameRepository.findActiveGameIdForRoom: no Supabase client configured (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY unset)');
  }

  const { data: game, error } = await supabase.from('games').select('id, status').eq('room_id', roomId).single();
  if (error || !game || game.status !== 'in_progress') {
    return null;
  }
  return game.id;
}

export async function resolveLiveGameState(roomId, supabase) {
  const hot = getGameState(roomId);
  if (hot) {
    return hot;
  }

  let cold = null;
  try {
    cold = await loadGameStateFromSupabase(supabase, roomId);
  } catch (err) {
    console.error(`gameRepository.resolveLiveGameState: failed to cold-load game state for room '${roomId}':`, err.message);
    return null;
  }
  if (cold) {
    setGameState(roomId, cold);
  }
  return cold;
}
