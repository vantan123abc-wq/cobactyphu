import test from 'node:test';
import assert from 'node:assert';
import { createTile } from '../domain/tile.js';
import { buildSnakeOrder, offerDraftTiles, initialDraftState, advanceDraftState, DRAFT_ROUNDS, DRAFT_OFFER_SIZE } from './draftPhase.js';

const T = (position, tileType) =>
  createTile({ id: `t${position}`, boardId: 'small', position, tileType, name: `T${position}` });

// 6 property tiles + 1 transport + 1 utility, mirroring the real board's own
// exclusion rule (transport/utility are never draftable — file header).
const BOARD = [
  T(1, 'property'), T(2, 'property'), T(3, 'property'),
  T(4, 'property'), T(5, 'property'), T(6, 'property'),
  T(7, 'transport'), T(8, 'utility'),
];

test('buildSnakeOrder: round 1 is ascending order as given, round 2 reverses it', () => {
  const order = ['a', 'b', 'c', 'd'];
  assert.deepStrictEqual(buildSnakeOrder(order, 1), ['a', 'b', 'c', 'd']);
  assert.deepStrictEqual(buildSnakeOrder(order, 2), ['d', 'c', 'b', 'a']);
  assert.deepStrictEqual(order, ['a', 'b', 'c', 'd'], 'the input array itself is never mutated');
});

test('offerDraftTiles: never offers transport/utility, only property tiles', () => {
  const offer = offerDraftTiles(BOARD, new Set(), () => 0.5);
  assert.strictEqual(offer.length, DRAFT_OFFER_SIZE);
  for (const id of offer) {
    assert.strictEqual(BOARD.find((t) => t.id === id).tileType, 'property');
  }
});

test('offerDraftTiles: excludes already-owned tile ids', () => {
  const owned = new Set(['t1', 't2', 't3']);
  const offer = offerDraftTiles(BOARD, owned, () => 0.5);
  assert.strictEqual(offer.length, 3, 'only t4/t5/t6 remain');
  assert.deepStrictEqual(offer.sort(), ['t4', 't5', 't6']);
});

test('offerDraftTiles: degrades gracefully (fewer than `count`) instead of throwing when the pool runs low', () => {
  const owned = new Set(['t1', 't2', 't3', 't4', 't5']);
  const offer = offerDraftTiles(BOARD, owned, () => 0.5);
  assert.deepStrictEqual(offer, ['t6']);
});

test('offerDraftTiles: an empty pool returns an empty offer, not an error', () => {
  const owned = new Set(['t1', 't2', 't3', 't4', 't5', 't6']);
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
