import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSupabase } from '../../testUtils/fakeSupabase.js';
import { createGameState, createPlayerGameState } from '../../domain/gameState.js';
import {
  getGameState,
  setGameState,
  _resetForTests,
  deriveSnapshotReason,
  saveSnapshot,
  saveMatchResult,
  RESULT_TYPES_BY_END_REASON,
  loadGameStateFromSupabase,
  SNAPSHOT_REASONS,
  findActiveGameIdForRoom,
} from './gameRepository.js';

beforeEach(() => {
  _resetForTests();
});

function makeGameState(fields = {}) {
  return createGameState({
    id: 'game-1',
    roomId: 'room-1',
    boardId: 'small',
    status: 'in_progress',
    phase: 'TURN_START',
    players: [createPlayerGameState({ id: 'gp-1', gameId: 'game-1', playerId: 'user-1', currentBalance: 1500 })],
    startedAt: '2026-01-01T00:00:00.000Z',
    ...fields,
  });
}

// ---- in-memory hot store ----

test('getGameState/setGameState: round-trips through the in-memory store, returning copies not references', () => {
  const state = makeGameState();
  setGameState('room-1', state);

  const loaded = getGameState('room-1');
  assert.deepEqual(loaded, state);

  loaded.phase = 'ROLLING'; // mutating the returned copy must not corrupt the store
  assert.equal(getGameState('room-1').phase, 'TURN_START');
});

test('getGameState: returns null when nothing is hot-loaded for this roomId', () => {
  assert.equal(getGameState('no-such-room'), null);
});

// ---- deriveSnapshotReason ----

test('deriveSnapshotReason: END_TURN action -> turn_end', () => {
  const before = makeGameState({ phase: 'POST_ACTIONS' });
  const after = makeGameState({ phase: 'TURN_START', currentTurnIndex: 1 });
  assert.equal(deriveSnapshotReason('END_TURN', before, after), 'turn_end');
});

test('deriveSnapshotReason: a player newly going bankrupt -> bankruptcy, even mid-turn', () => {
  const before = makeGameState({ players: [createPlayerGameState({ id: 'gp-1', gameId: 'game-1', playerId: 'user-1', currentBalance: 0, bankrupt: false })] });
  const after = makeGameState({ players: [createPlayerGameState({ id: 'gp-1', gameId: 'game-1', playerId: 'user-1', currentBalance: 0, bankrupt: true })] });
  assert.equal(deriveSnapshotReason('PAY_DEBT', before, after), 'bankruptcy');
});

test('deriveSnapshotReason: a player already bankrupt before this action does not re-trigger bankruptcy', () => {
  const bankruptPlayer = createPlayerGameState({ id: 'gp-1', gameId: 'game-1', playerId: 'user-1', currentBalance: 0, bankrupt: true });
  const before = makeGameState({ players: [bankruptPlayer] });
  const after = makeGameState({ players: [bankruptPlayer] });
  assert.equal(deriveSnapshotReason('ROLL_DICE', before, after), null);
});

test('deriveSnapshotReason: status finished -> game_over, even overriding a same-action turn_end signal', () => {
  const before = makeGameState({ status: 'in_progress' });
  const after = makeGameState({ status: 'finished', phase: null });
  assert.equal(deriveSnapshotReason('END_TURN', before, after), 'game_over');
});

test('deriveSnapshotReason: an ordinary mid-turn action with none of the three triggers -> null', () => {
  const before = makeGameState({ phase: 'ROLLING' });
  const after = makeGameState({ phase: 'MOVING' });
  assert.equal(deriveSnapshotReason('ROLL_DICE', before, after), null);
});

// ---- Supabase durability half ----

test('saveSnapshot: rejects a reason outside the schema-approved set', async () => {
  const supabase = createFakeSupabase();
  await assert.rejects(() => saveSnapshot(supabase, makeGameState(), 'game_start'), TypeError);
  assert.deepEqual(SNAPSHOT_REASONS, ['turn_end', 'bankruptcy', 'game_over']);
});

test('saveSnapshot: upserts games then game_state_snapshots, keyed correctly', async () => {
  const supabase = createFakeSupabase();
  const state = makeGameState();

  await saveSnapshot(supabase, state, 'turn_end');

  const gamesRows = supabase._tables.get('games');
  assert.equal(gamesRows.length, 1);
  assert.equal(gamesRows[0].id, 'game-1');
  assert.equal(gamesRows[0].room_id, 'room-1');

  const snapshotRows = supabase._tables.get('game_state_snapshots');
  assert.equal(snapshotRows.length, 1);
  assert.equal(snapshotRows[0].game_id, 'game-1');
  assert.equal(snapshotRows[0].reason, 'turn_end');
  assert.deepEqual(snapshotRows[0].state, state);
});

test('saveSnapshot: a second call for the same game upserts in place (latest-only, DATABASE_DESIGN.md §9)', async () => {
  const supabase = createFakeSupabase();
  await saveSnapshot(supabase, makeGameState({ stateVersion: 1 }), 'turn_end');
  await saveSnapshot(supabase, makeGameState({ stateVersion: 2 }), 'bankruptcy');

  const snapshotRows = supabase._tables.get('game_state_snapshots');
  assert.equal(snapshotRows.length, 1);
  assert.equal(snapshotRows[0].state.stateVersion, 2);
  assert.equal(snapshotRows[0].reason, 'bankruptcy');
});

// ---- match_results (Win Condition design, wired 2026-08-21) ----

function finishedGameState(fields = {}) {
  return makeGameState({
    status: 'finished',
    phase: null,
    endReason: 'elimination',
    endedAt: '2026-08-21T01:00:00.000Z',
    players: [
      createPlayerGameState({ id: 'gp-1', gameId: 'game-1', playerId: 'user-1', currentBalance: 3000, finalRank: 1, finalNetWorth: 3000, finalCash: 3000, finalPropertyValue: 0 }),
      createPlayerGameState({ id: 'gp-2', gameId: 'game-1', playerId: 'user-2', currentBalance: 0, bankrupt: true, finalRank: 2, finalNetWorth: 0, finalCash: 0, finalPropertyValue: 0 }),
    ],
    ...fields,
  });
}

test('saveMatchResult: elimination -> elimination_win, winner is the player with finalRank 1', async () => {
  const supabase = createFakeSupabase();
  await saveMatchResult(supabase, finishedGameState());

  const rows = supabase._tables.get('match_results');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].game_id, 'game-1');
  assert.equal(rows[0].result_type, 'elimination_win');
  assert.equal(rows[0].winner_game_player_id, 'gp-1');
  assert.equal(rows[0].ended_at, '2026-08-21T01:00:00.000Z');
});

test('saveMatchResult: final_phase -> net_worth_win', async () => {
  const supabase = createFakeSupabase();
  await saveMatchResult(supabase, finishedGameState({ endReason: 'final_phase' }));

  const rows = supabase._tables.get('match_results');
  assert.equal(rows[0].result_type, 'net_worth_win');
});

test('saveMatchResult: RESULT_TYPES_BY_END_REASON has exactly the two currently-reachable endReason values', () => {
  assert.deepEqual(RESULT_TYPES_BY_END_REASON, { elimination: 'elimination_win', final_phase: 'net_worth_win' });
});

test('saveMatchResult: rejects an endReason with no result_type mapping (defensive — no code sets one today)', async () => {
  const supabase = createFakeSupabase();
  await assert.rejects(() => saveMatchResult(supabase, finishedGameState({ endReason: 'aborted' })), TypeError);
  assert.equal(supabase._tables.get('match_results'), undefined); // never wrote a row
});

test('saveMatchResult: a second call for the same game upserts in place, not a duplicate row', async () => {
  const supabase = createFakeSupabase();
  await saveMatchResult(supabase, finishedGameState());
  await saveMatchResult(supabase, finishedGameState({ endReason: 'final_phase' }));

  const rows = supabase._tables.get('match_results');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].result_type, 'net_worth_win');
});

test('saveMatchResult: throws a clear error with no Supabase client configured', async () => {
  await assert.rejects(() => saveMatchResult(null, finishedGameState()));
});

test('loadGameStateFromSupabase: round-trips a previously saved snapshot by roomId', async () => {
  const supabase = createFakeSupabase();
  const state = makeGameState();
  await saveSnapshot(supabase, state, 'game_over');

  const loaded = await loadGameStateFromSupabase(supabase, 'room-1');
  assert.deepEqual(loaded, state);
});

test('loadGameStateFromSupabase: returns null when this room has no game yet', async () => {
  const supabase = createFakeSupabase();
  assert.equal(await loadGameStateFromSupabase(supabase, 'no-such-room'), null);
});

test('saveSnapshot/loadGameStateFromSupabase: throw a clear error with no Supabase client configured', async () => {
  await assert.rejects(() => saveSnapshot(null, makeGameState(), 'turn_end'));
  await assert.rejects(() => loadGameStateFromSupabase(null, 'room-1'));
  await assert.rejects(() => findActiveGameIdForRoom(null, 'room-1'));
});

// ---- findActiveGameIdForRoom (GET /api/v1/auth/me, wired 2026-08-21) ----
// Keyed by room_id, not player_id — see this function's own header for the
// real bug (game_players is never actually written by this backend) that
// made a player_id-keyed version always return null against a real game.

test('findActiveGameIdForRoom: null when this room has no games row at all (still in the lobby)', async () => {
  const supabase = createFakeSupabase();
  assert.equal(await findActiveGameIdForRoom(supabase, 'room-1'), null);
});

test('findActiveGameIdForRoom: returns the game id when its games row is genuinely in_progress', async () => {
  const supabase = createFakeSupabase({
    games: [{ id: 'game-1', room_id: 'room-1', status: 'in_progress', started_at: '2026-01-01T00:00:00.000Z' }],
  });
  assert.equal(await findActiveGameIdForRoom(supabase, 'room-1'), 'game-1');
});

test('findActiveGameIdForRoom: null once the room\'s game has finished — rooms.status has no \'finished\' value, so only the game\'s own status can tell', async () => {
  const supabase = createFakeSupabase({
    games: [{ id: 'game-1', room_id: 'room-1', status: 'finished', started_at: '2026-01-01T00:00:00.000Z' }],
  });
  assert.equal(await findActiveGameIdForRoom(supabase, 'room-1'), null);
});
