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


// ── INFRA / Hạ Tầng (wired 2026-09-04) ────────────────────────────────────
// The one archetype that had no arm anywhere: owning both utilities granted
// nothing at all. Its rent half is portfolio-WIDE — unlike every other
// modifier in this file it does not care which tile was landed on.

const utility = (position) =>
  createTile({ id: `t${position}`, boardId: 'small', position, tileType: 'utility', name: `U${position}`, price: 150 });

test('ASYMMETRIC: INFRA at tier 1 adds +10% to rent on a tile of a DIFFERENT archetype', () => {
  const board = [tile(1, 'red'), utility(6)];
  const properties = [prop(1, 'p2'), prop(6, 'p2')];
  const gameState = { ruleset: 'ASYMMETRIC', players: [{ id: 'p1' }, { id: 'p2' }], properties };
  // One red tile is below CONTROL's own 2-tile threshold, so the only
  // modifier in play here is INFRA's — earned on a utility, collected on a
  // property. That cross-archetype reach is the whole point of the effect.
  const rent = calculateFinalRent(gameState, 'p1', 'p2', board[0], properties[0], [], undefined, 7, board);
  assert.strictEqual(rent, 110);
});

test('ASYMMETRIC: INFRA at tier 2 (both utilities) raises that to +25%', () => {
  const board = [tile(1, 'red'), utility(6), utility(28)];
  const properties = [prop(1, 'p2'), prop(6, 'p2'), prop(28, 'p2')];
  const gameState = { ruleset: 'ASYMMETRIC', players: [{ id: 'p1' }, { id: 'p2' }], properties };
  const rent = calculateFinalRent(gameState, 'p1', 'p2', board[0], properties[0], [], undefined, 7, board);
  assert.strictEqual(rent, 125);
});

test('ASYMMETRIC: INFRA stacks additively with CONTROL, never multiplicatively', () => {
  const board = [tile(1, 'red'), tile(3, 'red'), utility(6), utility(28)];
  const properties = [prop(1, 'p2'), prop(3, 'p2'), prop(6, 'p2'), prop(28, 'p2')];
  const gameState = { ruleset: 'ASYMMETRIC', players: [{ id: 'p1' }, { id: 'p2' }], properties };
  const rent = calculateFinalRent(gameState, 'p1', 'p2', board[0], properties[0], [], undefined, 7, board);
  // 1 + 0.5 (CONTROL tier 1) + 0.25 (INFRA tier 2) = x1.75, not 1.5 x 1.25.
  assert.strictEqual(rent, 175);
});

test('ASYMMETRIC: a MORTGAGED utility does not feed INFRA, same rule as every other archetype', () => {
  const board = [tile(1, 'red'), utility(6), utility(28)];
  const properties = [prop(1, 'p2'), prop(6, 'p2'), prop(28, 'p2', { mortgaged: true })];
  const gameState = { ruleset: 'ASYMMETRIC', players: [{ id: 'p1' }, { id: 'p2' }], properties };
  const rent = calculateFinalRent(gameState, 'p1', 'p2', board[0], properties[0], [], undefined, 7, board);
  assert.strictEqual(rent, 110, 'back down to tier 1');
});

test('CLASSIC is untouched by INFRA — utilities grant no rent bonus there', () => {
  const board = [tile(1, 'red'), utility(6), utility(28)];
  const properties = [prop(1, 'p2'), prop(6, 'p2'), prop(28, 'p2')];
  const gameState = { ruleset: 'CLASSIC', players: [{ id: 'p1' }, { id: 'p2' }], properties };
  const rent = calculateFinalRent(gameState, 'p1', 'p2', board[0], properties[0], [], [board[0]], 7, board);
  assert.strictEqual(rent, 100);
});

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
