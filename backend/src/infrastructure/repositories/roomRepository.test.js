import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSupabase } from '../../testUtils/fakeSupabase.js';
import { createRoom, getRoomById, getRoomByJoinCode, updateRoom, findActiveRoomIdForPlayer } from './roomRepository.js';

function seededSupabase(overrides = {}) {
  return createFakeSupabase({
    profiles: [
      { id: 'user-host', display_name: 'Host Player', avatar_url: null },
      { id: 'user-guest', display_name: 'Guest Player', avatar_url: 'https://example.com/a.png' },
    ],
    ...overrides,
  });
}

test('createRoom: inserts rooms + room_players, returns the composed record with real profile names', async () => {
  const supabase = seededSupabase();
  const record = await createRoom(supabase, {
    id: 'room-1',
    joinCode: 'ABC123',
    hostId: 'user-host',
    status: 'waiting_for_players',
    createdAt: '2026-01-01T00:00:00.000Z',
    players: [{ playerId: 'user-host', isReady: false }],
  });

  assert.equal(record.id, 'room-1');
  assert.equal(record.joinCode, 'ABC123');
  assert.equal(record.hostId, 'user-host');
  assert.equal(record.players.length, 1);
  assert.deepEqual(record.players[0], {
    playerId: 'user-host',
    displayName: 'Host Player', // from profiles, not a placeholder
    avatarUrl: null,
    isReady: false,
    isHost: true,
    zodiac: null, // 2026-08-22 — not supplied above, defaults null
  });
});

// ── ruleset persistence (2026-09-04) ───────────────────────────────────────
// A real user report: "tạo chế độ mới chơi tôi chẳng thấy gì khác chế độ cũ".
// createRoom simply never wrote the column, so every room came back Classic
// from the database and room.controller.js was covering for it with an
// in-PROCESS Map — which a restart between creating the room and starting it
// silently empties. On the free Render plan that is a 15-minute idle
// spindown, and the match then starts Classic with no error anywhere.

test('createRoom: PERSISTS the ruleset, so it survives a backend restart', async () => {
  const supabase = seededSupabase();
  await createRoom(supabase, {
    id: 'room-asym',
    joinCode: 'ASYM01',
    hostId: 'user-host',
    ruleset: 'ASYMMETRIC',
    status: 'waiting_for_players',
    createdAt: '2026-01-01T00:00:00.000Z',
    players: [{ playerId: 'user-host', isReady: false }],
  });

  // Read back through a completely separate call, the way a restarted process
  // would: nothing in memory, everything from the database.
  const reloaded = await getRoomById(supabase, 'room-asym');
  assert.equal(reloaded.ruleset, 'ASYMMETRIC');
});

test('createRoom: defaults to CLASSIC when no ruleset is given', async () => {
  const supabase = seededSupabase();
  await createRoom(supabase, {
    id: 'room-classic',
    joinCode: 'CLS001',
    hostId: 'user-host',
    status: 'waiting_for_players',
    createdAt: '2026-01-01T00:00:00.000Z',
    players: [{ playerId: 'user-host', isReady: false }],
  });
  assert.equal((await getRoomById(supabase, 'room-classic')).ruleset, 'CLASSIC');
});

test('a rooms row with NO ruleset column maps to null, not CLASSIC', async () => {
  // The distinction the controller's fallback depends on: null means
  // "migration 0006 is not applied here", which is a different fact from
  // "this is a Classic room" and is the only thing that tells it to consult
  // its in-process cache. Simulated by seeding a row without the column at
  // all, exactly as an un-migrated database would return it.
  const supabase = seededSupabase({
    rooms: [
      { id: 'room-old', join_code: 'OLD001', host_id: 'user-host', status: 'waiting_for_players', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
    ],
    room_players: [{ room_id: 'room-old', player_id: 'user-host', is_ready: false, joined_at: '2026-01-01T00:00:00.000Z', zodiac: null }],
  });

  const record = await getRoomById(supabase, 'room-old');
  assert.equal(record.ruleset, null, 'null so the caller can tell "column absent" from "Classic room"');
});

test('getRoomById: reconstructs players via room_players + profiles join, isHost derived from host_id', async () => {
  const supabase = seededSupabase();
  const created = await createRoom(supabase, {
    id: 'room-2',
    joinCode: 'DEF456',
    hostId: 'user-host',
    createdAt: '2026-01-01T00:00:00.000Z',
    players: [{ playerId: 'user-host', isReady: false }],
  });

  await supabase.from('room_players').insert({
    room_id: created.id,
    player_id: 'user-guest',
    is_ready: false,
    joined_at: '2026-01-01T00:05:00.000Z',
  });

  const record = await getRoomById(supabase, 'room-2');
  assert.equal(record.players.length, 2);
  const guest = record.players.find((p) => p.playerId === 'user-guest');
  assert.equal(guest.displayName, 'Guest Player');
  assert.equal(guest.avatarUrl, 'https://example.com/a.png');
  assert.equal(guest.isHost, false);
});

test('getRoomById: returns null for a non-existent room', async () => {
  const supabase = seededSupabase();
  assert.equal(await getRoomById(supabase, 'no-such-room'), null);
});

test('getRoomByJoinCode: resolves by join_code, not internal id', async () => {
  const supabase = seededSupabase();
  await createRoom(supabase, {
    id: 'room-3',
    joinCode: 'ZZZ999',
    hostId: 'user-host',
    createdAt: '2026-01-01T00:00:00.000Z',
    players: [{ playerId: 'user-host', isReady: false }],
  });

  const record = await getRoomByJoinCode(supabase, 'ZZZ999');
  assert.equal(record.id, 'room-3');
  assert.equal(await getRoomByJoinCode(supabase, 'NOPE00'), null);
});

test('updateRoom: syncs is_ready for an existing player without touching others', async () => {
  const supabase = seededSupabase();
  const created = await createRoom(supabase, {
    id: 'room-4',
    joinCode: 'RDY001',
    hostId: 'user-host',
    createdAt: '2026-01-01T00:00:00.000Z',
    players: [{ playerId: 'user-host', isReady: false }],
  });
  await supabase.from('room_players').insert({ room_id: created.id, player_id: 'user-guest', is_ready: false, joined_at: '2026-01-01T00:05:00.000Z' });

  const updated = await updateRoom(supabase, 'room-4', {
    status: 'waiting_for_players',
    players: [
      { playerId: 'user-host', isReady: false },
      { playerId: 'user-guest', isReady: true },
    ],
  });

  const guest = updated.players.find((p) => p.playerId === 'user-guest');
  const host = updated.players.find((p) => p.playerId === 'user-host');
  assert.equal(guest.isReady, true);
  assert.equal(host.isReady, false);
});

test('updateRoom: syncs zodiac for an existing player, same round-trip as is_ready (2026-08-22)', async () => {
  const supabase = seededSupabase();
  const created = await createRoom(supabase, {
    id: 'room-zodiac',
    joinCode: 'ZOD001',
    hostId: 'user-host',
    createdAt: '2026-01-01T00:00:00.000Z',
    players: [{ playerId: 'user-host', isReady: false, zodiac: null }],
  });
  assert.equal(created.players[0].zodiac, null);

  const updated = await updateRoom(supabase, 'room-zodiac', {
    status: 'waiting_for_players',
    players: [{ playerId: 'user-host', isReady: false, zodiac: 'mui' }], // Dê (goat)
  });

  assert.equal(updated.players[0].zodiac, 'mui');
});

test('updateRoom: inserts a room_players row for a newly-joined player not already present', async () => {
  const supabase = seededSupabase();
  await createRoom(supabase, {
    id: 'room-5',
    joinCode: 'JOIN01',
    hostId: 'user-host',
    createdAt: '2026-01-01T00:00:00.000Z',
    players: [{ playerId: 'user-host', isReady: false }],
  });

  const updated = await updateRoom(supabase, 'room-5', {
    status: 'waiting_for_players',
    players: [
      { playerId: 'user-host', isReady: false },
      { playerId: 'user-guest', isReady: false },
    ],
  });

  assert.equal(updated.players.length, 2);
});

test('updateRoom: updates rooms.status', async () => {
  const supabase = seededSupabase();
  await createRoom(supabase, {
    id: 'room-6',
    joinCode: 'STA001',
    hostId: 'user-host',
    createdAt: '2026-01-01T00:00:00.000Z',
    players: [{ playerId: 'user-host', isReady: false }],
  });

  const updated = await updateRoom(supabase, 'room-6', {
    status: 'ready_check',
    players: [{ playerId: 'user-host', isReady: false }],
  });

  assert.equal(updated.status, 'ready_check');
});

test('updateRoom: returns null for a non-existent room id', async () => {
  const supabase = seededSupabase();
  assert.equal(await updateRoom(supabase, 'no-such-room', { status: 'waiting_for_players', players: [] }), null);
});

test('every export throws a clear error when no Supabase client is configured', async () => {
  await assert.rejects(() => createRoom(null, {}));
  await assert.rejects(() => getRoomById(null, 'x'));
  await assert.rejects(() => getRoomByJoinCode(null, 'x'));
  await assert.rejects(() => updateRoom(null, 'x', {}));
  await assert.rejects(() => findActiveRoomIdForPlayer(null, 'x'));
});

// ---- findActiveRoomIdForPlayer (GET /api/v1/auth/me, wired 2026-08-21) ----

test('findActiveRoomIdForPlayer: null when the player has no room_players rows at all', async () => {
  const supabase = seededSupabase();
  assert.equal(await findActiveRoomIdForPlayer(supabase, 'user-host'), null);
});

test('findActiveRoomIdForPlayer: returns the room id for a single non-abandoned membership', async () => {
  const supabase = seededSupabase({
    rooms: [{ id: 'room-1', join_code: 'AAA111', host_id: 'user-host', status: 'waiting_for_players', updated_at: '2026-01-01T00:00:00.000Z' }],
    room_players: [{ room_id: 'room-1', player_id: 'user-host', is_ready: false, joined_at: '2026-01-01T00:00:00.000Z' }],
  });
  assert.equal(await findActiveRoomIdForPlayer(supabase, 'user-host'), 'room-1');
});

test('findActiveRoomIdForPlayer: null when the player\'s only membership is to an abandoned room', async () => {
  const supabase = seededSupabase({
    rooms: [{ id: 'room-1', join_code: 'AAA111', host_id: 'user-host', status: 'abandoned', updated_at: '2026-01-01T00:00:00.000Z' }],
    room_players: [{ room_id: 'room-1', player_id: 'user-host', is_ready: false, joined_at: '2026-01-01T00:00:00.000Z' }],
  });
  assert.equal(await findActiveRoomIdForPlayer(supabase, 'user-host'), null);
});

test('findActiveRoomIdForPlayer: with more than one non-abandoned membership (no automatic cleanup on a closed tab), picks the most recently updated room', async () => {
  const supabase = seededSupabase({
    rooms: [
      { id: 'room-old', join_code: 'AAA111', host_id: 'user-host', status: 'waiting_for_players', updated_at: '2026-01-01T00:00:00.000Z' },
      { id: 'room-new', join_code: 'BBB222', host_id: 'user-host', status: 'in_progress', updated_at: '2026-01-02T00:00:00.000Z' },
    ],
    room_players: [
      { room_id: 'room-old', player_id: 'user-host', is_ready: false, joined_at: '2026-01-01T00:00:00.000Z' },
      { room_id: 'room-new', player_id: 'user-host', is_ready: false, joined_at: '2026-01-02T00:00:00.000Z' },
    ],
  });
  assert.equal(await findActiveRoomIdForPlayer(supabase, 'user-host'), 'room-new');
});
