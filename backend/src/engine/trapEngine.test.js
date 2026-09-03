import test from 'node:test';
import assert from 'node:assert';
import {
  isTrapActive,
  activeTrapsOf,
  validateTrapPlacement,
  createTrap,
  MAX_TRAPS_PER_PLAYER,
  TRAP_DURATION_ROUNDS,
} from './trapEngine.js';

const BOARD_SIZE = 36;
const gs = (activeTraps, roundNumber = 0) => ({ activeTraps, roundNumber });

test('isTrapActive: still active exactly through its expiresAtRound, expired the round after', () => {
  const trap = { expiresAtRound: 5 };
  assert.strictEqual(isTrapActive(trap, 5), true);
  assert.strictEqual(isTrapActive(trap, 6), false);
});

test('activeTrapsOf filters out expired entries but keeps live ones', () => {
  const live = { tileIndex: 1, expiresAtRound: 5 };
  const expired = { tileIndex: 2, expiresAtRound: 3 };
  assert.deepStrictEqual(activeTrapsOf(gs([live, expired], 5)), [live]);
});

test('activeTrapsOf tolerates a missing activeTraps field entirely (a CLASSIC-shaped or pre-migration snapshot)', () => {
  assert.deepStrictEqual(activeTrapsOf({ roundNumber: 0 }), []);
});

test('createTrap stamps expiresAtRound as placement round + TRAP_DURATION_ROUNDS', () => {
  const trap = createTrap('p1', 5, 'ROADBLOCK', 10);
  assert.deepStrictEqual(trap, { tileIndex: 5, type: 'ROADBLOCK', ownerId: 'p1', expiresAtRound: 10 + TRAP_DURATION_ROUNDS });
});

test('validateTrapPlacement: a well-formed placement on an empty board is legal', () => {
  assert.strictEqual(validateTrapPlacement(gs([]), 'p1', 5, 'ROADBLOCK', BOARD_SIZE), null);
});

test('validateTrapPlacement rejects an unknown trap type', () => {
  assert.strictEqual(validateTrapPlacement(gs([]), 'p1', 5, 'LANDMINE', BOARD_SIZE), 'UNKNOWN_TRAP_TYPE');
});

test('validateTrapPlacement rejects a position outside the board', () => {
  assert.strictEqual(validateTrapPlacement(gs([]), 'p1', -1, 'ROADBLOCK', BOARD_SIZE), 'INVALID_POSITION');
  assert.strictEqual(validateTrapPlacement(gs([]), 'p1', BOARD_SIZE, 'ROADBLOCK', BOARD_SIZE), 'INVALID_POSITION');
  assert.strictEqual(validateTrapPlacement(gs([]), 'p1', 3.5, 'ROADBLOCK', BOARD_SIZE), 'INVALID_POSITION');
});

test('validateTrapPlacement rejects a tile that already has an active trap — including someone ELSE\'s', () => {
  const existing = { tileIndex: 5, type: 'ROADBLOCK', ownerId: 'p2', expiresAtRound: 10 };
  assert.strictEqual(validateTrapPlacement(gs([existing]), 'p1', 5, 'TOLL_BOOTH', BOARD_SIZE), 'TILE_OCCUPIED');
});

test('validateTrapPlacement allows placing once an occupying trap has expired', () => {
  const expired = { tileIndex: 5, type: 'ROADBLOCK', ownerId: 'p2', expiresAtRound: 2 };
  assert.strictEqual(validateTrapPlacement(gs([expired], 5), 'p1', 5, 'TOLL_BOOTH', BOARD_SIZE), null);
});

test(`validateTrapPlacement rejects the (${MAX_TRAPS_PER_PLAYER + 1})th simultaneous trap from the same owner`, () => {
  const mine = Array.from({ length: MAX_TRAPS_PER_PLAYER }, (_, i) => ({
    tileIndex: i, type: 'ROADBLOCK', ownerId: 'p1', expiresAtRound: 10,
  }));
  assert.strictEqual(validateTrapPlacement(gs(mine), 'p1', 20, 'ROADBLOCK', BOARD_SIZE), 'TRAP_LIMIT_REACHED');
});

test('the per-owner cap does not count another player\'s traps against you', () => {
  const theirs = Array.from({ length: MAX_TRAPS_PER_PLAYER }, (_, i) => ({
    tileIndex: i, type: 'ROADBLOCK', ownerId: 'p2', expiresAtRound: 10,
  }));
  assert.strictEqual(validateTrapPlacement(gs(theirs), 'p1', 20, 'ROADBLOCK', BOARD_SIZE), null);
});
