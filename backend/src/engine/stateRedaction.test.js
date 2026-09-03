import test from 'node:test';
import assert from 'node:assert';
import { maskGameState, HIDDEN_CARD, HIDDEN_TRAP } from './stateRedaction.js';

const bank = { id: 'bank', isBank: true, playerId: null };
const alice = { id: 'p-alice', isBank: false, movementHand: ['MOVE_5', 'JUMP_2'], handRevealedTo: [] };
const bob = { id: 'p-bob', isBank: false, movementHand: ['SPRINT_12', 'BACKUP_3'], handRevealedTo: [] };

const state = (overrides = {}) => ({
  ruleset: 'ASYMMETRIC',
  roundNumber: 5,
  players: [bank, alice, bob],
  ...overrides,
});

test('CLASSIC returns the exact same reference — no redaction, no overhead', () => {
  const classic = { ruleset: 'CLASSIC', roundNumber: 5, players: [alice, bob] };
  assert.strictEqual(maskGameState(classic, 'p-alice'), classic);
});

test('the viewer\'s own hand is untouched — same object reference, not just equal content', () => {
  const masked = maskGameState(state(), 'p-alice');
  assert.strictEqual(masked.players.find((p) => p.id === 'p-alice'), alice);
});

test('the Bank row passes through untouched — it has no hand to hide', () => {
  const masked = maskGameState(state(), 'p-alice');
  assert.strictEqual(masked.players.find((p) => p.id === 'bank'), bank);
});

test('an opponent\'s hand is fully hidden by default — same length, every slot HIDDEN_CARD', () => {
  const masked = maskGameState(state(), 'p-alice');
  const maskedBob = masked.players.find((p) => p.id === 'p-bob');
  assert.notStrictEqual(maskedBob, bob, 'a new object — the original must never be mutated');
  assert.deepStrictEqual(maskedBob.movementHand, [HIDDEN_CARD, HIDDEN_CARD]);
  assert.deepStrictEqual(bob.movementHand, ['SPRINT_12', 'BACKUP_3'], 'the source object is untouched');
});

test('a viewer that matches no real player sees every hand hidden — the safe default for an unknown socket', () => {
  const masked = maskGameState(state(), 'this-id-does-not-exist');
  for (const p of masked.players) {
    if (p.isBank) continue;
    assert.ok(p.movementHand.every((c) => c === HIDDEN_CARD));
  }
});

test('DENIAL FULL reveal: the granted viewer sees the whole hand, untouched', () => {
  const revealedBob = { ...bob, handRevealedTo: [{ viewerId: 'p-alice', untilRound: 7, scope: 'FULL' }] };
  const masked = maskGameState(state({ players: [bank, alice, revealedBob] }), 'p-alice');
  assert.strictEqual(masked.players.find((p) => p.id === 'p-bob'), revealedBob);
});

test('DENIAL FULL reveal only applies to the granted viewer — a third player still sees it hidden', () => {
  const revealedBob = { ...bob, handRevealedTo: [{ viewerId: 'p-alice', untilRound: 7, scope: 'FULL' }] };
  const masked = maskGameState(state({ players: [bank, alice, revealedBob] }), 'p-bank-unrelated');
  const maskedBob = masked.players.find((p) => p.id === 'p-bob');
  assert.deepStrictEqual(maskedBob.movementHand, [HIDDEN_CARD, HIDDEN_CARD]);
});

test('DENIAL FULL reveal expires — a lapsed round is treated exactly like no reveal at all', () => {
  const revealedBob = { ...bob, handRevealedTo: [{ viewerId: 'p-alice', untilRound: 3, scope: 'FULL' }] };
  const masked = maskGameState(state({ roundNumber: 5, players: [bank, alice, revealedBob] }), 'p-alice');
  const maskedBob = masked.players.find((p) => p.id === 'p-bob');
  assert.deepStrictEqual(maskedBob.movementHand, [HIDDEN_CARD, HIDDEN_CARD]);
});

test('DENIAL NEXT_CARD reveal exposes only index 0, the rest still hidden', () => {
  const revealedBob = { ...bob, handRevealedTo: [{ viewerId: 'p-alice', untilRound: 7, scope: 'NEXT_CARD' }] };
  const masked = maskGameState(state({ players: [bank, alice, revealedBob] }), 'p-alice');
  const maskedBob = masked.players.find((p) => p.id === 'p-bob');
  assert.deepStrictEqual(maskedBob.movementHand, ['SPRINT_12', HIDDEN_CARD]);
});

test('an empty hand needs no masking and passes through untouched', () => {
  const empty = { id: 'p-carol', isBank: false, movementHand: [] };
  const masked = maskGameState(state({ players: [bank, alice, empty] }), 'p-alice');
  assert.strictEqual(masked.players.find((p) => p.id === 'p-carol'), empty);
});

test('maskGameState only touches players and activeTraps — everything else (properties, etc.) is the same reference', () => {
  const full = state({ properties: [{ id: 'p1' }], activeTraps: [] });
  const masked = maskGameState(full, 'p-alice');
  assert.strictEqual(masked.properties, full.properties);
});

// ── activeTraps redaction (trapEngine.js) ───────────────────────────────────
test('the trap owner sees their own trap in full — real position, type, expiry', () => {
  const trap = { tileIndex: 12, type: 'ROADBLOCK', ownerId: 'p-alice', expiresAtRound: 10 };
  const masked = maskGameState(state({ activeTraps: [trap] }), 'p-alice');
  assert.deepStrictEqual(masked.activeTraps, [trap]);
});

test('everyone else sees an anonymous stub — same array length, no position/type/owner leaked', () => {
  const trap = { tileIndex: 12, type: 'ROADBLOCK', ownerId: 'p-alice', expiresAtRound: 10 };
  const masked = maskGameState(state({ activeTraps: [trap] }), 'p-bob');
  assert.strictEqual(masked.activeTraps.length, 1, 'count is still visible — only content is hidden');
  assert.deepStrictEqual(masked.activeTraps[0], { tileIndex: null, type: HIDDEN_TRAP, ownerId: null, expiresAtRound: null });
});

test('a mixed activeTraps array is masked per-entry, independently', () => {
  const mine = { tileIndex: 3, type: 'TOLL_BOOTH', ownerId: 'p-alice', expiresAtRound: 8 };
  const theirs = { tileIndex: 20, type: 'ROADBLOCK', ownerId: 'p-bob', expiresAtRound: 8 };
  const masked = maskGameState(state({ activeTraps: [mine, theirs] }), 'p-alice');
  assert.deepStrictEqual(masked.activeTraps[0], mine);
  assert.strictEqual(masked.activeTraps[1].tileIndex, null);
});
