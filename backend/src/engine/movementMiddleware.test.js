import test from 'node:test';
import assert from 'node:assert';
import { createTile } from '../domain/tile.js';
import { createProperty } from '../domain/property.js';
import { resolveMovement } from './movementMiddleware.js';

const T = (position, groupId, tileType = 'property') =>
  createTile({ id: `t${position}`, boardId: 'small', position, tileType, name: `T${position}`, groupId });

// Positions 1..8 are CONTROL (red 1/3, cyan 5/7/8) and 28..35 EXECUTION on
// the real small board; everything else here is filler so `position` lookups
// resolve for all 36 tiles.
const BOARD = Array.from({ length: 36 }, (_, i) => {
  const groups = { 1: 'red', 3: 'red', 5: 'cyan', 7: 'cyan', 8: 'cyan', 20: 'purple', 28: 'blue', 29: 'blue', 31: 'blue', 33: 'darkblue', 35: 'darkblue' };
  if (i === 10 || i === 14) return T(i, null, 'transport');
  return T(i, groups[i] ?? null, groups[i] ? 'property' : 'free_parking');
});

const own = (position, ownerId, extra = {}) =>
  createProperty({ id: `p${position}`, gameId: 'g', boardTileId: `t${position}`, ownerId, ...extra });

const asym = (pos, properties, traps = []) => ({
  ruleset: 'ASYMMETRIC',
  players: [{ id: 'p1', currentPosition: pos }, { id: 'p2', currentPosition: 0 }],
  properties,
  activeTraps: traps,
});

test('CLASSIC is untouched — no pass-through, no step loss, same shape as before', () => {
  const state = { ruleset: 'CLASSIC', players: [{ id: 'p1', currentPosition: 0 }], properties: [] };
  const r = resolveMovement(state, 'p1', 5, 1, 36);
  assert.strictEqual(r.newPosition, 5);
  assert.strictEqual(r.passedGo, false);
  assert.strictEqual(r.stepsLost, 0);
  assert.deepStrictEqual(r.tolls, []);
});

test('ASYMMETRIC still stops dead at a ROADBLOCK', () => {
  const state = asym(0, [], [{ tileIndex: 3, type: 'ROADBLOCK', ownerId: 'p2' }]);
  const r = resolveMovement(state, 'p1', 5, 1, 36, { boardTiles: BOARD });
  assert.strictEqual(r.newPosition, 3);
  assert.strictEqual(r.stoppedByTrap, true);
});

test('CONTROL takes a step per owned tile crossed, so the player stops short', () => {
  // p2 owns both red tiles (CONTROL tier 1). Moving 0 -> 5 crosses ô1 and ô3.
  const state = asym(0, [own(1, 'p2'), own(3, 'p2')]);
  const r = resolveMovement(state, 'p1', 5, 1, 36, { boardTiles: BOARD });
  assert.strictEqual(r.stepsLost, 2, 'one step for each of the two crossed CONTROL tiles');
  assert.strictEqual(r.newPosition, 3, '5 steps minus 2 lands the player inside the control zone');
});

test('EXECUTION tolls are returned per crossed tile, not aggregated, and never for the landing tile', () => {
  const state = asym(27, [
    own(28, 'p2', { upgradeLevel: 2 }),
    own(29, 'p2', { upgradeLevel: 1 }),
    own(31, 'p2', { upgradeLevel: 4 }), // EXECUTION tier 2 (4 tiles) once 33 is added
    own(33, 'p2', { upgradeLevel: 5 }),
  ]);
  // 27 -> 31: crosses 28, 29, 30; lands on 31.
  const r = resolveMovement(state, 'p1', 4, 1, 36, { boardTiles: BOARD });
  assert.strictEqual(r.newPosition, 31);
  assert.deepStrictEqual(
    r.tolls.map((t) => t.amount),
    [150, 75],
    'ô28 (2 levels) and ô29 (1 level); ô31 is the landing tile and is billed by resolveLanding instead'
  );
  assert.ok(r.tolls.every((t) => t.ownerId === 'p2'));
});

test('a JUMP card crosses everything immune — no toll, no step loss', () => {
  const state = asym(0, [own(1, 'p2'), own(3, 'p2')]);
  const r = resolveMovement(state, 'p1', 5, 1, 36, { boardTiles: BOARD, ignorePassThrough: true });
  assert.strictEqual(r.stepsLost, 0);
  assert.deepStrictEqual(r.tolls, []);
  assert.strictEqual(r.newPosition, 5, 'full distance, unlike the -2 the same move costs without immunity');
});

test('an owner is never charged by their own zone', () => {
  const state = asym(0, [own(1, 'p1'), own(3, 'p1')]);
  const r = resolveMovement(state, 'p1', 5, 1, 36, { boardTiles: BOARD });
  assert.strictEqual(r.stepsLost, 0);
  assert.strictEqual(r.newPosition, 5);
});

test('passedGo still fires when the loop wraps, and backwards movement never grants it', () => {
  const forward = resolveMovement(asym(34, []), 'p1', 4, 1, 36, { boardTiles: BOARD });
  assert.strictEqual(forward.newPosition, 2);
  assert.strictEqual(forward.passedGo, true);

  const backward = resolveMovement(asym(2, []), 'p1', 4, -1, 36, { boardTiles: BOARD });
  assert.strictEqual(backward.newPosition, 34);
  assert.strictEqual(backward.passedGo, false, 'reversing past GO must not pay a salary');
});

test('step loss cannot spin the loop forever', () => {
  // Every crossable tile is an opponent CONTROL tile: each step forward costs
  // an extra step, so remaining drains twice as fast and must terminate.
  const properties = [1, 3, 5, 7, 8].map((p) => own(p, 'p2'));
  const state = asym(0, properties);
  const r = resolveMovement(state, 'p1', 9, 1, 36, { boardTiles: BOARD });
  assert.ok(r.newPosition >= 0 && r.newPosition < 36);
  assert.ok(r.stepsLost > 0);
});

test('MOBILITY NUDGE uses the LIVE crossing position for every tile in a multi-tile walk, not the move\'s starting tile', () => {
  // p2 owns station ô14 and property ô20. p1 starts a long move at ô0 (far
  // from both), walking through ô14 mid-route on the way to ô25.
  //
  // This is the regression case for the fromPosition bug found while writing
  // synergyEngine's own tests: NUDGE was computed from p1's move-start
  // position (ô0) for every crossing, rather than from ô14 — the tile
  // actually being crossed — which is a different geometry problem entirely
  // and would silently mis-shove on every multi-tile move.
  const state = asym(0, [own(14, 'p2'), own(20, 'p2')]);
  const r = resolveMovement(state, 'p1', 25, 1, 36, { boardTiles: BOARD });
  // Forward distance from the crossing (ô14) to ô20 is 6, shrinking as the
  // walk continues forward, so the live-position shove is +1. Landing
  // position reflects that extra step (25 steps + 1 nudge = 26 from ô0 = ô26,
  // not ô25).
  assert.strictEqual(r.newPosition, 26);
});
