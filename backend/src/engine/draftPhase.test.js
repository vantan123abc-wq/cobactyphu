import test from 'node:test';
import assert from 'node:assert';
import { createTile } from '../domain/tile.js';
import { buildSnakeOrder, offerDraftTiles, initialDraftState, advanceDraftState, draftRoundsFor, DRAFT_ROUNDS, DRAFT_OFFER_SIZE } from './draftPhase.js';

const T = (position, tileType) =>
  createTile({ id: `t${position}`, boardId: 'small', position, tileType, name: `T${position}` });

// 6 property tiles + 1 transport + 1 utility. All eight are draftable as of
// 2026-09-07 (DRAFTABLE_TILE_TYPES) — the transport/utility exclusion this
// fixture was originally built to prove was reversed after it measured as the
// reason MOBILITY and INFRA specialists activated no tier at all in ~half of
// 4-player matches. One non-property of each kind is kept here precisely so
// the INCLUSION stays covered.
const BOARD = [
  T(1, 'property'), T(2, 'property'), T(3, 'property'),
  T(4, 'property'), T(5, 'property'), T(6, 'property'),
  T(7, 'transport'), T(8, 'utility'),
];

test('buildSnakeOrder: odd rounds ascend, EVERY even round reverses', () => {
  const order = ['a', 'b', 'c', 'd'];
  assert.deepStrictEqual(buildSnakeOrder(order, 1), ['a', 'b', 'c', 'd']);
  assert.deepStrictEqual(buildSnakeOrder(order, 2), ['d', 'c', 'b', 'a']);
  // Rounds 3 and 4 only exist since draftRoundsFor() started scaling with the
  // seat count. The rule used to be a literal `round === 2`, which would have
  // run rounds 3 AND 4 ascending and handed seat 'a' the first pick three
  // times out of four — the exact compounding advantage snake order prevents.
  assert.deepStrictEqual(buildSnakeOrder(order, 3), ['a', 'b', 'c', 'd']);
  assert.deepStrictEqual(buildSnakeOrder(order, 4), ['d', 'c', 'b', 'a']);
  assert.deepStrictEqual(order, ['a', 'b', 'c', 'd'], 'the input array itself is never mutated');
});

test('draftRoundsFor: scales with the seat count — 2 seats keep 2 rounds, 4 seats get 4', () => {
  assert.strictEqual(draftRoundsFor(2), 2);
  assert.strictEqual(draftRoundsFor(3), 3);
  assert.strictEqual(draftRoundsFor(4), 4);
  assert.strictEqual(draftRoundsFor(6), 4, 'the large board seats 5-6; the ladder tops out at 4 rounds');
});

test('advanceDraftState: a 4-seat draft runs FOUR rounds, not two', () => {
  const seats = ['p1', 'p2', 'p3', 'p4'];
  // Round 2 used to be the last one for every seat count. At 4 seats it is
  // now the halfway point: the draft must roll into round 3.
  const endOfRound2 = { round: 2, pickOrder: [...seats].reverse(), currentPickIndex: 3, availableTileIds: [] };
  const rolled = advanceDraftState(endOfRound2, seats, BOARD, new Set(), () => 0.5);
  assert.strictEqual(rolled.done, false);
  assert.strictEqual(rolled.draftState.round, 3);
  assert.deepStrictEqual(rolled.draftState.pickOrder, seats, 'round 3 is odd, so ascending again');

  const endOfRound4 = { round: 4, pickOrder: [...seats].reverse(), currentPickIndex: 3, availableTileIds: [] };
  assert.deepStrictEqual(advanceDraftState(endOfRound4, seats, BOARD, new Set(), () => 0.5), { done: true, draftState: null });
});

test('offerDraftTiles: offers stations and utilities too, not just property', () => {
  const offer = offerDraftTiles(BOARD, new Set(), () => 0.5);
  assert.strictEqual(offer.length, DRAFT_OFFER_SIZE);
  for (const id of offer) {
    assert.ok(['property', 'transport', 'utility'].includes(BOARD.find((t) => t.id === id).tileType));
  }

  // The reachability guarantee the reversal exists for: with every property
  // already taken, the two non-property tiles must still be offerable. Under
  // the old property-only rule this returned an empty offer, which is exactly
  // how a MOBILITY or INFRA specialist ended up unable to draft toward their
  // own archetype at all.
  const propertiesGone = new Set(['t1', 't2', 't3', 't4', 't5', 't6']);
  assert.deepStrictEqual(offerDraftTiles(BOARD, propertiesGone, () => 0.5).sort(), ['t7', 't8']);
});

test('offerDraftTiles: excludes already-owned tile ids', () => {
  const owned = new Set(['t1', 't2', 't3']);
  const offer = offerDraftTiles(BOARD, owned, () => 0.5);
  assert.strictEqual(offer.length, DRAFT_OFFER_SIZE, 't4/t5/t6 plus the station and utility remain');
  assert.ok(offer.every((id) => !owned.has(id)));
});

test('offerDraftTiles: degrades gracefully (fewer than `count`) instead of throwing when the pool runs low', () => {
  const owned = new Set(['t1', 't2', 't3', 't4', 't5', 't6', 't7']);
  const offer = offerDraftTiles(BOARD, owned, () => 0.5);
  assert.deepStrictEqual(offer, ['t8']);
});

test('offerDraftTiles: an empty pool returns an empty offer, not an error', () => {
  const owned = new Set(BOARD.map((t) => t.id));
  assert.deepStrictEqual(offerDraftTiles(BOARD, owned, () => 0.5), []);
});

test('offerDraftTiles: a fixed randomSource is fully deterministic — same input, same output every call', () => {
  const a = offerDraftTiles(BOARD, new Set(), () => 0.3);
  const b = offerDraftTiles(BOARD, new Set(), () => 0.3);
  assert.deepStrictEqual(a, b);
});

test('initialDraftState: round 1, index 0, a fresh 4-tile offer from an empty board', () => {
  const state = initialDraftState(['p1', 'p2'], BOARD, () => 0.5);
  assert.strictEqual(state.round, 1);
  assert.strictEqual(state.currentPickIndex, 0);
  assert.deepStrictEqual(state.pickOrder, ['p1', 'p2']);
  assert.strictEqual(state.availableTileIds.length, DRAFT_OFFER_SIZE);
});

test('advanceDraftState: mid-round just moves to the next index, same round, same offer', () => {
  const state = initialDraftState(['p1', 'p2', 'p3'], BOARD, () => 0.5);
  const { done, draftState } = advanceDraftState(state, ['p1', 'p2', 'p3'], BOARD, new Set(), () => 0.5);
  assert.strictEqual(done, false);
  assert.strictEqual(draftState.round, 1);
  assert.strictEqual(draftState.currentPickIndex, 1);
  assert.deepStrictEqual(draftState.availableTileIds, state.availableTileIds, 'unchanged until the round actually ends');
});

test('advanceDraftState: round 1\'s last pick rolls into round 2 — snake-reversed order, index reset, fresh offer excluding what was drafted', () => {
  const state = { round: 1, pickOrder: ['p1', 'p2'], currentPickIndex: 1, availableTileIds: [] };
  const owned = new Set(['t1', 't2']); // drafted during round 1
  const { done, draftState } = advanceDraftState(state, ['p1', 'p2'], BOARD, owned, () => 0.5);
  assert.strictEqual(done, false);
  assert.strictEqual(draftState.round, 2);
  assert.strictEqual(draftState.currentPickIndex, 0);
  assert.deepStrictEqual(draftState.pickOrder, ['p2', 'p1']);
  assert.ok(!draftState.availableTileIds.includes('t1'));
  assert.ok(!draftState.availableTileIds.includes('t2'));
});

test('advanceDraftState: round 2\'s last pick ends the draft — done, draftState null', () => {
  const state = { round: DRAFT_ROUNDS, pickOrder: ['p1', 'p2'], currentPickIndex: 1, availableTileIds: [] };
  const result = advanceDraftState(state, ['p1', 'p2'], BOARD, new Set(), () => 0.5);
  assert.deepStrictEqual(result, { done: true, draftState: null });
});
