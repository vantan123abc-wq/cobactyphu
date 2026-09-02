import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transitionRoom, InvalidRoomTransitionError } from './roomMachine.js';
import { createRoom } from '../domain/room.js';

function room(overrides = {}) {
  return { ...createRoom({ id: 'r1', joinCode: 'ABC123', hostId: 'host1', createdAt: '2026-08-17T00:00:00.000Z' }), ...overrides };
}

test('the full happy-path chain: waiting_for_players -> ready_check -> starting -> in_progress', () => {
  let state = room();
  assert.equal(state.status, 'waiting_for_players');

  state = transitionRoom(state, { type: 'ALL_PLAYERS_READY' });
  assert.equal(state.status, 'ready_check');

  state = transitionRoom(state, { type: 'HOST_START' });
  assert.equal(state.status, 'starting');

  state = transitionRoom(state, { type: 'ENGINE_INITIALIZED' });
  assert.equal(state.status, 'in_progress');
});

test('a player un-readying sends ready_check back to waiting_for_players', () => {
  const readyCheck = room({ status: 'ready_check' });
  const result = transitionRoom(readyCheck, { type: 'PLAYER_UNREADY' });
  assert.equal(result.status, 'waiting_for_players');
});

test('the host leaving abandons a room still waiting for players', () => {
  const result = transitionRoom(room(), { type: 'HOST_LEFT' });
  assert.equal(result.status, 'abandoned');
});

test('idle timeout abandons a room still waiting for players', () => {
  const result = transitionRoom(room(), { type: 'IDLE_TIMEOUT' });
  assert.equal(result.status, 'abandoned');
});

test('an illegal transition throws InvalidRoomTransitionError with diagnostic details', () => {
  try {
    transitionRoom(room(), { type: 'HOST_START' }); // HOST_START is only legal from ready_check, not waiting_for_players
    assert.fail('expected transitionRoom to throw');
  } catch (error) {
    assert.ok(error instanceof InvalidRoomTransitionError);
    assert.equal(error.currentStatus, 'waiting_for_players');
    assert.equal(error.eventType, 'HOST_START');
  }
});

test('in_progress and abandoned are terminal — every event is rejected', () => {
  const inProgress = room({ status: 'in_progress' });
  const abandoned = room({ status: 'abandoned' });

  for (const eventType of ['ALL_PLAYERS_READY', 'HOST_START', 'PLAYER_UNREADY', 'ENGINE_INITIALIZED', 'HOST_LEFT', 'IDLE_TIMEOUT']) {
    assert.throws(() => transitionRoom(inProgress, { type: eventType }), InvalidRoomTransitionError);
    assert.throws(() => transitionRoom(abandoned, { type: eventType }), InvalidRoomTransitionError);
  }
});

test('transitionRoom leaves every field except status untouched, including updatedAt', () => {
  const before = room({ updatedAt: '2026-08-17T01:23:45.000Z' });
  const after = transitionRoom(before, { type: 'ALL_PLAYERS_READY' });

  assert.equal(after.id, before.id);
  assert.equal(after.joinCode, before.joinCode);
  assert.equal(after.hostId, before.hostId);
  assert.equal(after.createdAt, before.createdAt);
  assert.equal(after.updatedAt, before.updatedAt); // not bumped here — that's the DB trigger's job
});

test('the original room object is not mutated', () => {
  const before = room();
  transitionRoom(before, { type: 'ALL_PLAYERS_READY' });
  assert.equal(before.status, 'waiting_for_players');
});
