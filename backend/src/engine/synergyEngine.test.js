import test from 'node:test';
import assert from 'node:assert';
import { createTile } from '../domain/tile.js';
import { createProperty } from '../domain/property.js';
import { archetypeOf, archetypeCount, synergyTier, passThroughEffect, landingEffect } from './synergyEngine.js';

// Real small-board positions/groups (supabase/seed/boards.sql). Built through
// createTile so any field the factory drops can never silently pass a test
// that real board data would fail — the exact way the old
// calculateRentMiddleware test hid a dead `targetTile.color` check.
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

// INFRA / Hạ Tầng (2026-09-04). BOARD above carries only one utility, and
// INFRA's top tier needs both, so this builds its own two-utility board
// rather than reshaping a fixture five other tests depend on.
const INFRA_BOARD = [
  createTile({ id: 'u1', boardId: 'small', position: 11, tileType: 'utility', name: 'U1', price: 150 }),
  createTile({ id: 'u2', boardId: 'small', position: 27, tileType: 'utility', name: 'U2', price: 150 }),
];
const ownUtil = (id, ownerId, extra = {}) =>
  createProperty({ id: `p-${id}`, gameId: 'g', boardTileId: id, ownerId, ...extra });
const infraState = (properties) => ({ ruleset: 'ASYMMETRIC', players: [{ id: 'p1' }, { id: 'p2' }], properties });

test('passThroughEffect: INFRA charges a crossing fee only once BOTH utilities are held', () => {
  const one = infraState([ownUtil('u1', 'p2')]);
  assert.strictEqual(
    passThroughEffect(one, INFRA_BOARD, INFRA_BOARD[0], 'p1'),
    null,
    'tier 1 is rent support only — nothing happens walking past'
  );

  const both = infraState([ownUtil('u1', 'p2'), ownUtil('u2', 'p2')]);
  assert.deepStrictEqual(passThroughEffect(both, INFRA_BOARD, INFRA_BOARD[0], 'p1'), {
    type: 'TOLL',
    amount: 25,
    ownerId: 'p2',
  });
});

test('passThroughEffect: INFRA never charges the owner for crossing their own utility', () => {
  const both = infraState([ownUtil('u1', 'p2'), ownUtil('u2', 'p2')]);
  assert.strictEqual(passThroughEffect(both, INFRA_BOARD, INFRA_BOARD[0], 'p2'), null);
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

test('ECONOMY pass-through is a REROLL, not a confiscation — the mechanic that keeps a 2-card hand playable', () => {
  const board = [T(10, 'purple'), T(12, 'purple'), T(13, 'purple')];
  const state = { ruleset: 'ASYMMETRIC', players: [{ id: 'p1' }, { id: 'p2' }], properties: [own(10, 'p2'), own(12, 'p2')] };
  assert.deepStrictEqual(passThroughEffect(state, board, board[0], 'p1'), { type: 'CARD_REROLL', ownerId: 'p2' });
});

test('ECONOMY landing lets the owner draw 2; DENIAL landing records a 2-round reveal', () => {
  const board = [T(10, 'purple'), T(12, 'purple'), T(19, 'yellow'), T(21, 'yellow')];
  const economy = { ruleset: 'ASYMMETRIC', players: [{ id: 'p1' }, { id: 'p2' }], properties: [own(10, 'p2'), own(12, 'p2')] };
  assert.deepStrictEqual(landingEffect(economy, board, board[0], 'p1'), { type: 'OWNER_DRAWS', ownerId: 'p2', amount: 2 });

  const denial = { ruleset: 'ASYMMETRIC', players: [{ id: 'p1' }, { id: 'p2' }], properties: [own(19, 'p2'), own(21, 'p2')] };
  assert.deepStrictEqual(landingEffect(denial, board, board[2], 'p1'), { type: 'REVEAL_HAND', ownerId: 'p2', rounds: 2 });
});

test('landingEffect stays silent for CONTROL/EXECUTION — rent is calculateRentMiddleware\'s job, not a rider', () => {
  const board = [T(1, 'red'), T(3, 'red')];
  const state = { ruleset: 'ASYMMETRIC', players: [{ id: 'p1' }, { id: 'p2' }], properties: [own(1, 'p2'), own(3, 'p2')] };
  assert.strictEqual(landingEffect(state, board, board[0], 'p1'), null);
});

test('MOBILITY pass-through is a no-op when the owner holds no property to aim at', () => {
  const board = [T(14, null, 'transport'), T(32, null, 'transport')];
  const state = {
    ruleset: 'ASYMMETRIC',
    players: [{ id: 'p1', currentPosition: 15 }, { id: 'p2', currentPosition: 0 }],
    properties: [own(14, 'p2'), own(32, 'p2')],
  };
  assert.strictEqual(passThroughEffect(state, board, board[0], 'p1'), null, 'stations alone give nothing to be shoved toward');
});

test('teleport ranks by CURRENT rent, so a developed cheap street beats an empty expensive one', () => {
  const board = [
    T(14, null, 'transport'), T(32, null, 'transport'),
    createTile({ id: 't1', boardId: 'small', position: 1, tileType: 'property', name: 'T1', groupId: 'red', baseRent: 2, rentTable: [10, 30, 90, 160, 250] }),
    createTile({ id: 't35', boardId: 'small', position: 35, tileType: 'property', name: 'T35', groupId: 'darkblue', baseRent: 50, rentTable: [200, 600, 1400, 1700, 2000] }),
  ];
  const state = {
    ruleset: 'ASYMMETRIC',
    players: [{ id: 'p1', currentPosition: 14 }, { id: 'p2', currentPosition: 0 }],
    // ô1 has a hotel (250); ô35 is bare land (50).
    properties: [own(14, 'p2'), own(32, 'p2'), own(1, 'p2', { upgradeLevel: 5 }), own(35, 'p2')],
  };
  assert.strictEqual(landingEffect(state, board, board[0], 'p1').targetPosition, 1);
});

test('a station is never a teleport destination, which is what makes the throw non-recursive', () => {
  const board = [T(14, null, 'transport'), T(32, null, 'transport')];
  const state = {
    ruleset: 'ASYMMETRIC',
    players: [{ id: 'p1', currentPosition: 14 }, { id: 'p2', currentPosition: 0 }],
    properties: [own(14, 'p2'), own(32, 'p2')],
  };
  assert.strictEqual(landingEffect(state, board, board[0], 'p1'), null);
});

// A full 36-tile board. nudgeDirection measures distance modulo
// boardTiles.length, so a sparse fixture silently reports a board the size of
// the fixture — the two tests below failed exactly that way before this.
const FULL = Array.from({ length: 36 }, (_, i) => {
  const groups = { 1: 'red', 3: 'red', 5: 'cyan', 7: 'cyan', 8: 'cyan', 10: 'purple', 13: 'purple', 15: 'orange', 17: 'orange', 28: 'blue', 33: 'darkblue', 35: 'darkblue' };
  if (i === 14 || i === 32) return T(i, null, 'transport');
  if (!groups[i]) return T(i, null, 'free_parking');
  return createTile({
    id: `t${i}`, boardId: 'small', position: i, tileType: 'property', name: `T${i}`,
    groupId: groups[i], baseRent: 10 * i, rentTable: [10 * i, 30 * i, 90 * i, 160 * i, 250 * i],
  });
});

test('MOBILITY pass-through shoves the victim toward the owner\'s nearest property — deterministic, never a prompt', () => {
  // p2 owns station ô14 and property ô17. Crossing ô14, forward distance to
  // ô17 only shrinks by continuing forward, so the shove is +1.
  const state = {
    ruleset: 'ASYMMETRIC',
    players: [{ id: 'p1', currentPosition: 0 }, { id: 'p2', currentPosition: 0 }],
    properties: [own(14, 'p2'), own(17, 'p2')],
  };
  assert.deepStrictEqual(passThroughEffect(state, FULL, FULL[14], 'p1', 14), { type: 'NUDGE', ownerId: 'p2', amount: 1 });
});

test('MOBILITY pass-through shoves backward only when the property sits exactly one tile behind the crossing', () => {
  // NUDGE only ever trims or extends the CURRENT forward walk by one tile —
  // it never reverses direction. So amount=-1 only helps when the owner's
  // property is the tile immediately behind the one being crossed (ô13,
  // crossing ô14): pulling the walk one tile short lands squarely on it. A
  // property further back (ô10, tested above as "shoves forward") is
  // unreachable by trimming one tile either way, so the flatter distance
  // (continuing forward) wins instead — that is not a bug, it's what a
  // single-tile shove can and can't do.
  const state = {
    ruleset: 'ASYMMETRIC',
    players: [{ id: 'p1', currentPosition: 0 }, { id: 'p2', currentPosition: 0 }],
    properties: [own(14, 'p2'), own(13, 'p2')],
  };
  // fromPosition = 14 (the station itself, mid-walk) — passed explicitly the
  // same way movementMiddleware's own walk loop does, not read off
  // gameState.players[].currentPosition (that field is stale mid-walk; see
  // passThroughEffect's own doc comment for why the two must never be
  // conflated — a real bug this test line exists to pin down).
  assert.deepStrictEqual(passThroughEffect(state, FULL, FULL[14], 'p1', 14), { type: 'NUDGE', ownerId: 'p2', amount: -1 });
});

test('passThroughEffect must be given the LIVE crossing position, not gameState\'s stale one, for a multi-tile move', () => {
  // Player started this move at ô0 (gameState.players[].currentPosition) and
  // is now mid-walk, currently crossing ô14. Calling without fromPosition
  // falls back to the stale ô0 — wrong tile entirely — and must not be
  // confused with the correct, explicit ô14 the walk loop actually passes.
  const state = {
    ruleset: 'ASYMMETRIC',
    players: [{ id: 'p1', currentPosition: 0 }, { id: 'p2', currentPosition: 0 }],
    properties: [own(14, 'p2'), own(13, 'p2')],
  };
  const stale = passThroughEffect(state, FULL, FULL[14], 'p1'); // no fromPosition — uses stale ô0
  const live = passThroughEffect(state, FULL, FULL[14], 'p1', 14); // correct, as movementMiddleware sends it
  assert.notDeepStrictEqual(stale, live, 'the stale and live reference points must disagree here, or this test proves nothing');
  assert.deepStrictEqual(live, { type: 'NUDGE', ownerId: 'p2', amount: -1 });
});

test('MOBILITY teleport needs BOTH stations, and aims at the owner\'s highest-rent tile', () => {
  const oneStation = {
    ruleset: 'ASYMMETRIC',
    players: [{ id: 'p1', currentPosition: 14 }, { id: 'p2', currentPosition: 0 }],
    properties: [own(14, 'p2'), own(1, 'p2'), own(35, 'p2')],
  };
  assert.strictEqual(landingEffect(oneStation, FULL, FULL[14], 'p1'), null, 'tier 1 does not unlock the throw');

  const bothStations = { ...oneStation, properties: [own(14, 'p2'), own(32, 'p2'), own(1, 'p2'), own(35, 'p2')] };
  assert.deepStrictEqual(landingEffect(bothStations, FULL, FULL[14], 'p1'), {
    type: 'TELEPORT', ownerId: 'p2', targetPosition: 35,
  });
});
