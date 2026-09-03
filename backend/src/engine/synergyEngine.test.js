import test from 'node:test';
import assert from 'node:assert';
import { createTile } from '../domain/tile.js';
import { createProperty } from '../domain/property.js';
import { archetypeOf, archetypeCount, synergyTier, passThroughEffect } from './synergyEngine.js';

// Real small-board positions/groups (supabase/seed/boards.sql). Built through
// createTile so a field the factory drops (the `color` that
// calculateRentMiddleware still reads, for instance) can never silently pass
// a test that real board data would fail.
const T = (position, groupId, tileType = 'property') =>
  createTile({ id: `t${position}`, boardId: 'small', position, tileType, name: `T${position}`, groupId });

const BOARD = [
  T(1, 'red'), T(3, 'red'),                       // CONTROL
  T(5, 'cyan'), T(7, 'cyan'), T(8, 'cyan'),       // CONTROL
  T(28, 'blue'), T(29, 'blue'), T(31, 'blue'),    // EXECUTION
  T(33, 'darkblue'), T(35, 'darkblue'),           // EXECUTION
  T(14, null, 'transport'), T(32, null, 'transport'), // MOBILITY
  T(11, null, 'utility'),                         // INFRA
];

const own = (position, ownerId, extra = {}) =>
  createProperty({ id: `p${position}`, gameId: 'g', boardTileId: `t${position}`, ownerId, ...extra });

const stateWith = (properties) => ({
  ruleset: 'ASYMMETRIC',
  players: [{ id: 'p1' }, { id: 'p2' }],
  properties,
});

test('archetypeOf maps the real board: colour groups, transport and utility', () => {
  assert.strictEqual(archetypeOf(BOARD.find((t) => t.position === 1)), 'CONTROL');
  assert.strictEqual(archetypeOf(BOARD.find((t) => t.position === 8)), 'CONTROL');
  assert.strictEqual(archetypeOf(BOARD.find((t) => t.position === 35)), 'EXECUTION');
  assert.strictEqual(archetypeOf(BOARD.find((t) => t.position === 14)), 'MOBILITY');
  assert.strictEqual(archetypeOf(BOARD.find((t) => t.position === 11)), 'INFRA');
  assert.strictEqual(archetypeOf(undefined), null);
});

test('set levels count across the whole ARCHETYPE, not per colour group', () => {
  // Both darkblue tiles = a complete colour group, but only 2 of EXECUTION's
  // 5 tiles. This is the exact hole archetype-wide counting was introduced to
  // close: under per-group counting this would be a maxed set for $750.
  const state = stateWith([own(33, 'p2'), own(35, 'p2')]);
  assert.strictEqual(archetypeCount(state, BOARD, 'p2', 'EXECUTION'), 2);
  assert.strictEqual(synergyTier(state, BOARD, 'p2', 'EXECUTION'), 1, 'complete darkblue is only tier 1');

  const maxed = stateWith([own(28, 'p2'), own(29, 'p2'), own(31, 'p2'), own(33, 'p2'), own(35, 'p2')]);
  assert.strictEqual(synergyTier(maxed, BOARD, 'p2', 'EXECUTION'), 3, 'all 5 tiles reaches the top tier');
});

test('MOBILITY tops out at the tier the board can actually supply (small has 2 stations)', () => {
  const state = stateWith([own(14, 'p2'), own(32, 'p2')]);
  assert.strictEqual(synergyTier(state, BOARD, 'p2', 'MOBILITY'), 2, 'both stations = max on this board');
});

test('a mortgaged deed stops feeding its synergy', () => {
  const state = stateWith([own(1, 'p2'), own(3, 'p2', { mortgaged: true })]);
  assert.strictEqual(archetypeCount(state, BOARD, 'p2', 'CONTROL'), 1);
  assert.strictEqual(synergyTier(state, BOARD, 'p2', 'CONTROL'), 0, 'mortgaging out of a tier really drops it');
});

test('passThroughEffect: CONTROL costs a step once the owner is at tier 1', () => {
  const below = stateWith([own(1, 'p2')]); // 1 tile — below the 2-tile threshold
  assert.strictEqual(passThroughEffect(below, BOARD, BOARD[0], 'p1'), null);

  const state = stateWith([own(1, 'p2'), own(3, 'p2')]);
  assert.deepStrictEqual(passThroughEffect(state, BOARD, BOARD[0], 'p1'), { type: 'STEP_LOSS', amount: 1 });
});

test('passThroughEffect: EXECUTION charges per development level, nothing while undeveloped', () => {
  const flat = stateWith([own(33, 'p2'), own(35, 'p2')]);
  const tile33 = BOARD.find((t) => t.position === 33);
  assert.strictEqual(passThroughEffect(flat, BOARD, tile33, 'p1'), null, 'no houses => no toll');

  const built = stateWith([own(33, 'p2', { upgradeLevel: 3 }), own(35, 'p2')]);
  assert.deepStrictEqual(passThroughEffect(built, BOARD, tile33, 'p1'), {
    type: 'TOLL',
    amount: 225, // 3 levels x $75
    ownerId: 'p2',
  });
});

test('passThroughEffect never fires on your own tile, or an unowned one', () => {
  const mine = stateWith([own(1, 'p1'), own(3, 'p1')]);
  assert.strictEqual(passThroughEffect(mine, BOARD, BOARD[0], 'p1'), null);

  const unowned = stateWith([own(1, null), own(3, null)]);
  assert.strictEqual(passThroughEffect(unowned, BOARD, BOARD[0], 'p1'), null);
});
