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

// --- INFRA / Hạ Tầng (§2.3), wired 2026-09-04 -------------------------------
//
// This archetype had tiers and a name but no effect anywhere: neither
// passThroughEffect, nor landingEffect, nor this middleware had an INFRA
// branch, so holding both utilities in ASYMMETRIC did nothing beyond classic
// utility rent — two board tiles were inert in this ruleset. Only §2.3's
// "+25% Rent" is implemented; its other two clauses depend on a "Quỹ dự trữ"
// that is defined nowhere, and are deliberately left out.

const utility = (position) =>
  createTile({ id: `t${position}`, boardId: 'small', position, tileType: 'utility', name: `U${position}`, price: 150, mortgageValue: 75 });

test('ASYMMETRIC: INFRA adds +25% on landing from its first utility', () => {
  const board = [utility(6), utility(11)];
  const properties = [prop(6, 'p2')];
  const gameState = { ruleset: 'ASYMMETRIC', players: [{ id: 'p1' }, { id: 'p2' }], properties };
  // Utility rent is diceRoll x 4 for a single-utility owner (calculateRent §11),
  // so 7 x 4 = 28 base, then the rider: floor(28 x 1.25) = 35.
  const rent = calculateFinalRent(gameState, 'p1', 'p2', board[0], properties[0], [{ tile: board[0], property: properties[0] }], undefined, 7, board);
  assert.strictEqual(rent, 35);
});

test('ASYMMETRIC: the second utility raises the BASE 4x -> 10x AND the rider 25% -> 50%', () => {
  const board = [utility(6), utility(11)];
  const properties = [prop(6, 'p2'), prop(11, 'p2')];
  const gameState = { ruleset: 'ASYMMETRIC', players: [{ id: 'p1' }, { id: 'p2' }], properties };
  // 7 x 10 = 70 base, then floor(70 x 1.5) = 105. Both halves move at tier 2:
  // calculateRent's own base rate AND the archetype rider. That is what makes
  // the second utility worth buying for synergy rather than only for the base
  // rate, which is the whole reason the rider scales (see the middleware).
  const rent = calculateFinalRent(gameState, 'p1', 'p2', board[0], properties[0], [{ tile: board[0], property: properties[0] }, { tile: board[1], property: properties[1] }], undefined, 7, board);
  assert.strictEqual(rent, 105);
});

test('CLASSIC: a utility gets no INFRA rider at all', () => {
  const board = [utility(6), utility(11)];
  const properties = [prop(6, 'p2'), prop(11, 'p2')];
  const gameState = { ruleset: 'CLASSIC', players: [{ id: 'p1' }, { id: 'p2' }], properties };
  const rent = calculateFinalRent(gameState, 'p1', 'p2', board[0], properties[0], [{ tile: board[0], property: properties[0] }, { tile: board[1], property: properties[1] }], undefined, 7, board);
  assert.strictEqual(rent, 70, 'the archetype layer must never reach CLASSIC');
});

test('ASYMMETRIC: a mortgaged utility earns its owner no synergy tier, so no rider', () => {
  const board = [utility(6), utility(11)];
  const properties = [prop(6, 'p2', { mortgaged: true })];
  const gameState = { ruleset: 'ASYMMETRIC', players: [{ id: 'p1' }, { id: 'p2' }], properties };
  const rent = calculateFinalRent(gameState, 'p1', 'p2', board[0], properties[0], [{ tile: board[0], property: properties[0] }], undefined, 7, board);
  assert.strictEqual(rent, 28, 'mortgaging must not be a free way to keep the tier');
});

test('ASYMMETRIC: an opponent-owned utility gives the payer no rider of their own', () => {
  const board = [utility(6), utility(11)];
  // p1 (the payer) owns the other utility; the tile being landed on is p2's.
  const properties = [prop(6, 'p2'), prop(11, 'p1')];
  const gameState = { ruleset: 'ASYMMETRIC', players: [{ id: 'p1' }, { id: 'p2' }], properties };
  // The rider is keyed on the OWNER's tier, so p2 holding one utility gives
  // 7 x 4 = 28 base + 25% = 35, not anything derived from p1's holdings.
  const rent = calculateFinalRent(gameState, 'p1', 'p2', board[0], properties[0], [{ tile: board[0], property: properties[0] }], undefined, 7, board);
  assert.strictEqual(rent, 35);
});
