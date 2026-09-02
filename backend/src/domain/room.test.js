import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoom, ROOM_STATUSES } from './room.js';

test('createRoom always starts at waiting_for_players, never room_created', () => {
  const room = createRoom({ id: 'r1', joinCode: 'ABC123', hostId: 'host1', createdAt: '2026-08-17T00:00:00.000Z' });

  assert.equal(room.status, 'waiting_for_players');
  assert.equal(room.id, 'r1');
  assert.equal(room.joinCode, 'ABC123');
  assert.equal(room.hostId, 'host1');
});

test('updatedAt defaults to createdAt when not supplied', () => {
  const room = createRoom({ id: 'r1', joinCode: 'ABC123', hostId: 'host1', createdAt: '2026-08-17T00:00:00.000Z' });
  assert.equal(room.updatedAt, room.createdAt);
});

test('ROOM_STATUSES matches rooms.status\'s real CHECK constraint exactly (5 values, includes in_progress)', () => {
  assert.deepEqual(ROOM_STATUSES, ['waiting_for_players', 'ready_check', 'starting', 'in_progress', 'abandoned']);
});
