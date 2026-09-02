import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMe } from './auth.controller.js';
import { createFakeSupabase } from '../../testUtils/fakeSupabase.js';

// Same minimal Express-shaped mocks as room.controller.test.js/
// board.controller.test.js.
function mockReq({ user, supabase }) {
  return { user, app: { get: (key) => (key === 'supabase' ? supabase : undefined) } };
}

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test('getMe: returns the real profile plus null activeRoomId/activeGameId when the player has neither', async () => {
  const supabase = createFakeSupabase({
    profiles: [{ id: 'user-1', display_name: 'Real Name', avatar_url: 'https://example.com/a.png' }],
  });
  const req = mockReq({ user: { id: 'user-1' }, supabase });
  const res = mockRes();

  await getMe(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    id: 'user-1',
    displayName: 'Real Name',
    avatarUrl: 'https://example.com/a.png',
    activeRoomId: null,
    activeGameId: null,
  });
});

test('getMe: falls back to the raw auth id when no profiles row exists yet, same posture as roomRepository.js\'s own fetchPlayers()', async () => {
  const supabase = createFakeSupabase();
  const req = mockReq({ user: { id: 'user-no-profile' }, supabase });
  const res = mockRes();

  await getMe(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.displayName, 'user-no-profile');
  assert.equal(res.body.avatarUrl, null);
});

test('getMe: reports a real activeRoomId (lobby, no game started yet)', async () => {
  const supabase = createFakeSupabase({
    profiles: [{ id: 'user-1', display_name: 'Real Name', avatar_url: null }],
    rooms: [{ id: 'room-1', join_code: 'AAA111', host_id: 'user-1', status: 'ready_check', updated_at: '2026-01-01T00:00:00.000Z' }],
    room_players: [{ room_id: 'room-1', player_id: 'user-1', is_ready: true, joined_at: '2026-01-01T00:00:00.000Z' }],
  });
  const req = mockReq({ user: { id: 'user-1' }, supabase });
  const res = mockRes();

  await getMe(req, res);

  assert.equal(res.body.activeRoomId, 'room-1');
  assert.equal(res.body.activeGameId, null);
});

test('getMe: reports both activeRoomId and activeGameId once a match is genuinely in progress', async () => {
  // Deliberately no game_players fixture row — findActiveGameIdForRoom
  // resolves activeGameId from games.room_id, never from game_players
  // (which this backend's real runtime never actually writes to at all —
  // see gameRepository.js's own findActiveGameIdForRoom header for the
  // real bug this replaced). A test that seeded game_players here would
  // have kept passing even with that bug, since the fake client would
  // happily answer a query real Supabase would too — it just wouldn't
  // have proven activeGameId comes from the right place.
  const supabase = createFakeSupabase({
    profiles: [{ id: 'user-1', display_name: 'Real Name', avatar_url: null }],
    rooms: [{ id: 'room-1', join_code: 'AAA111', host_id: 'user-1', status: 'in_progress', updated_at: '2026-01-01T00:00:00.000Z' }],
    room_players: [{ room_id: 'room-1', player_id: 'user-1', is_ready: true, joined_at: '2026-01-01T00:00:00.000Z' }],
    games: [{ id: 'game-1', room_id: 'room-1', status: 'in_progress', started_at: '2026-01-01T00:00:00.000Z' }],
  });
  const req = mockReq({ user: { id: 'user-1' }, supabase });
  const res = mockRes();

  await getMe(req, res);

  assert.equal(res.body.activeRoomId, 'room-1');
  assert.equal(res.body.activeGameId, 'game-1');
});

test('getMe: a finished match reports no activeGameId, even though the room itself still reads in_progress (rooms.status has no \'finished\' value)', async () => {
  const supabase = createFakeSupabase({
    profiles: [{ id: 'user-1', display_name: 'Real Name', avatar_url: null }],
    rooms: [{ id: 'room-1', join_code: 'AAA111', host_id: 'user-1', status: 'in_progress', updated_at: '2026-01-01T00:00:00.000Z' }],
    room_players: [{ room_id: 'room-1', player_id: 'user-1', is_ready: true, joined_at: '2026-01-01T00:00:00.000Z' }],
    games: [{ id: 'game-1', room_id: 'room-1', status: 'finished', started_at: '2026-01-01T00:00:00.000Z' }],
  });
  const req = mockReq({ user: { id: 'user-1' }, supabase });
  const res = mockRes();

  await getMe(req, res);

  assert.equal(res.body.activeRoomId, 'room-1');
  assert.equal(res.body.activeGameId, null);
});

test('getMe: no activeGameId lookup at all when there is no activeRoomId (a game can\'t outlive its own room)', async () => {
  const supabase = createFakeSupabase({
    profiles: [{ id: 'user-1', display_name: 'Real Name', avatar_url: null }],
  });
  const req = mockReq({ user: { id: 'user-1' }, supabase });
  const res = mockRes();

  await getMe(req, res);

  assert.equal(res.body.activeRoomId, null);
  assert.equal(res.body.activeGameId, null);
});
