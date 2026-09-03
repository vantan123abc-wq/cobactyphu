import test from 'node:test';
import assert from 'node:assert';
import { createTile } from '../domain/tile.js';
import { createProperty } from '../domain/property.js';
import { calculateFinalRent, MAX_RENT_MULTIPLIER } from './calculateRentMiddleware.js';

// Everything goes through the real domain factories. The version of this
// suite that shipped before 2026-09-03 hand-built `{ baseRent: 100, color:
// 'BLUE' }` object literals, which is why it passed green for weeks against
// a `targetTile.color === 'BLUE'` branch that no real board tile could ever
// satisfy — Tile has no `color` field and createTile drops unknown keys.
const tile = (position, groupId, extra = {}) =>
  createTile({
    id: `t${position}`, boardId: 'small', position, tileType: 'property',
    name: `T${position}`, groupId, baseRent: 100, price: 200, houseCost: 50,
    rentTable: [10, 30, 90, 160, 250], ...extra,
  });

const prop = (position, ownerId, extra = {}) =>
  createProperty({ id: `p${position}`, gameId: 'g', boardTileId: `t${position}`, ownerId, ...extra });

test('CLASSIC returns calculateRent verbatim — no archetype can touch it', () => {
  const red = tile(1, 'red');
  const gameState = { ruleset: 'CLASSIC', players: [{ id: 'p1' }, { id: 'p2' }], properties: [prop(1, 'p2')] };
  const rent = calculateFinalRent(gameState, 'p1', 'p2', red, prop(1, 'p2'), [], [red], 7, [red]);
  assert.strictEqual(rent, 100);
});

test('ASYMMETRIC: CONTROL adds +50% on landing once its owner is at tier 1', () => {
  const board = [tile(1, 'red'), tile(3, 'red')];
  const properties = [prop(1, 'p2'), prop(3, 'p2')];
  const gameState = { ruleset: 'ASYMMETRIC', players: [{ id: 'p1' }, { id: 'p2' }], properties };
  // groupTiles omitted so calculateRent doesn't also apply its own
  // full-set doubling — this asserts the middleware's own contribution.
  const rent = calculateFinalRent(gameState, 'p1', 'p2', board[0], properties[0], [], undefined, 7, board);
  assert.strictEqual(rent, 150);
});

test('ASYMMETRIC: one CONTROL tile is below the 2-tile threshold and adds nothing', () => {
  const board = [tile(1, 'red'), tile(3, 'red')];
  const properties = [prop(1, 'p2')];
  const gameState = { ruleset: 'ASYMMETRIC', players: [{ id: 'p1' }, { id: 'p2' }], properties };
  const rent = calculateFinalRent(gameState, 'p1', 'p2', board[0], properties[0], [], undefined, 7, board);
  assert.strictEqual(rent, 100);
});

test('ASYMMETRIC: a non-CONTROL archetype gets no rent rider', () => {
  const board = [tile(28, 'blue'), tile(29, 'blue')];
  const properties = [prop(28, 'p2'), prop(29, 'p2')];
  const gameState = { ruleset: 'ASYMMETRIC', players: [{ id: 'p1' }, { id: 'p2' }], properties };
  const rent = calculateFinalRent(gameState, 'p1', 'p2', board[0], properties[0], [], undefined, 7, board);
  assert.strictEqual(rent, 100, 'EXECUTION is paid on crossings, not on a rent multiplier');
});

test('the multiplier is clamped, so no future stack of archetypes can run away', () => {
  assert.strictEqual(MAX_RENT_MULTIPLIER, 3);
});
