import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createIdempotencyCache,
  isActionProcessed,
  recordAction,
  applyWithIdempotency,
  IDEMPOTENCY_CACHE_WINDOW_SECONDS,
} from './idempotency.js';
import { transitionTurn } from './turnMachine.js';
import { createGameState, createPlayerGameState } from '../domain/gameState.js';

const T0 = '2026-08-17T00:00:00.000Z';

function fakeGameState(overrides = {}) {
  return { stateVersion: 0, ...overrides };
}

test('createIdempotencyCache returns an empty cache', () => {
  const cache = createIdempotencyCache();
  assert.equal(isActionProcessed(cache, 'any-id', T0), false);
});

test('isActionProcessed is false for an id never recorded', () => {
  const cache = createIdempotencyCache();
  assert.equal(isActionProcessed(cache, 'unseen', T0), false);
});

test('isActionProcessed is true immediately after recordAction, at the same instant', () => {
  const cache = createIdempotencyCache();
  recordAction(cache, 'a1', T0);
  assert.equal(isActionProcessed(cache, 'a1', T0), true);
});

test('isActionProcessed is true just inside the cache window, false once it elapses', () => {
  const cache = createIdempotencyCache();
  recordAction(cache, 'a1', T0);

  const justInside = new Date(new Date(T0).getTime() + (IDEMPOTENCY_CACHE_WINDOW_SECONDS - 1) * 1000).toISOString();
  assert.equal(isActionProcessed(cache, 'a1', justInside), true);

  const justOutside = new Date(new Date(T0).getTime() + (IDEMPOTENCY_CACHE_WINDOW_SECONDS + 1) * 1000).toISOString();
  assert.equal(isActionProcessed(cache, 'a1', justOutside), false);
});

test('applyWithIdempotency applies a fresh action, bumps stateVersion by exactly one, and records the id', () => {
  const cache = createIdempotencyCache();
  const gameState = fakeGameState({ stateVersion: 5 });
  const action = { type: 'PING', clientActionId: 'a1' };
  const transitionFn = (gs, act) => ({
    gameState: { ...gs, lastAction: act.type },
    transactions: [{ id: 't1', idempotencyKey: 'g1:5' }], // realistic applyTransaction.js shape
  });

  const result = applyWithIdempotency(gameState, action, cache, transitionFn, T0);

  assert.equal(result.deduped, false);
  assert.equal(result.gameState.stateVersion, 6);
  assert.equal(result.gameState.lastAction, 'PING');
  // Finding #15/#20/#24, fixed 2026-08-21: idempotencyKey gets a per-
  // transaction index suffix appended — see the dedicated tests below for
  // why (a single transaction still gets ':0', not left bare).
  assert.deepEqual(result.transactions, [{ id: 't1', idempotencyKey: 'g1:5:0' }]);
  assert.equal(isActionProcessed(cache, 'a1', T0), true);
});

// ---- Finding #15/#20/#24: idempotencyKey collision within one action, fixed 2026-08-21 ----
// economy/applyTransaction.js's own idempotencyKey is `${gameId}:${stateVersion}`,
// computed from gameState.stateVersion — which stays this action's OLD
// value for transitionFn's *entire* call, since applyWithIdempotency only
// increments it afterward. A transitionFn that calls applyTransaction more
// than once for one external action (a two-sided trade, auction settlement
// + Near-Miss rewards, ...) used to hand back several transactions sharing
// the exact same key.

test('applyWithIdempotency: multiple transactions from one action get distinct idempotencyKeys, not a shared collision', () => {
  const cache = createIdempotencyCache();
  const gameState = fakeGameState({ stateVersion: 5 });
  const action = { type: 'ACCEPT_TRADE', clientActionId: 'a1' };
  // Mirrors the real collision case exactly: both transactions computed
  // from the same pre-increment stateVersion, same as applyTransaction.js
  // genuinely produces today for a two-sided trade settlement.
  const transitionFn = () => ({
    gameState: { stateVersion: 5 },
    transactions: [
      { fromGamePlayerId: 'gp-a', toGamePlayerId: 'gp-b', amount: 100, idempotencyKey: 'g1:5' },
      { fromGamePlayerId: 'gp-b', toGamePlayerId: 'gp-a', amount: 1, idempotencyKey: 'g1:5' }, // property leg, same key pre-fix
    ],
  });

  const result = applyWithIdempotency(gameState, action, cache, transitionFn, T0);

  assert.equal(result.transactions[0].idempotencyKey, 'g1:5:0');
  assert.equal(result.transactions[1].idempotencyKey, 'g1:5:1');
  assert.notEqual(result.transactions[0].idempotencyKey, result.transactions[1].idempotencyKey); // the actual bug this fixes
});

test('applyWithIdempotency: idempotencyKey suffixes stay unique across distinct actions too, not just within one', () => {
  const cache = createIdempotencyCache();
  let gameState = fakeGameState({ stateVersion: 5 });
  const transitionFn = (gs) => ({ gameState: gs, transactions: [{ idempotencyKey: `g1:${gs.stateVersion}` }] });

  const first = applyWithIdempotency(gameState, { type: 'A', clientActionId: 'a1' }, cache, transitionFn, T0);
  assert.equal(first.transactions[0].idempotencyKey, 'g1:5:0');

  gameState = first.gameState; // stateVersion now 6
  const second = applyWithIdempotency(gameState, { type: 'B', clientActionId: 'a2' }, cache, transitionFn, T0);
  assert.equal(second.transactions[0].idempotencyKey, 'g1:6:0');

  assert.notEqual(first.transactions[0].idempotencyKey, second.transactions[0].idempotencyKey);
});

test('applyWithIdempotency: a deduped repeat still returns an empty transactions array — nothing to suffix', () => {
  const cache = createIdempotencyCache();
  const gameState = fakeGameState({ stateVersion: 0 });
  const action = { type: 'PING', clientActionId: 'a1' };
  const transitionFn = (gs) => ({ gameState: gs, transactions: [{ idempotencyKey: 'g1:0' }] });

  applyWithIdempotency(gameState, action, cache, transitionFn, T0);
  const repeat = applyWithIdempotency(gameState, action, cache, transitionFn, T0);

  assert.equal(repeat.deduped, true);
  assert.deepEqual(repeat.transactions, []);
});

test('applyWithIdempotency: a repeated clientActionId within the cache window is a no-op, not a reapplication', () => {
  // SECURITY_DESIGN.md threat #5's own test case, applied here: send the
  // same clientActionId twice, assert exactly one applied effect.
  const cache = createIdempotencyCache();
  const gameState = fakeGameState({ stateVersion: 0 });
  const action = { type: 'PING', clientActionId: 'a1' };
  let callCount = 0;
  const transitionFn = (gs) => {
    callCount += 1;
    return { gameState: { ...gs }, transactions: [{ id: 't1' }] };
  };

  const first = applyWithIdempotency(gameState, action, cache, transitionFn, T0);
  assert.equal(first.deduped, false);
  assert.equal(first.gameState.stateVersion, 1);
  assert.equal(callCount, 1);

  // Same clientActionId, a moment later, still inside the window.
  const retryAt = new Date(new Date(T0).getTime() + 1000).toISOString();
  const second = applyWithIdempotency(first.gameState, action, cache, transitionFn, retryAt);

  assert.equal(second.deduped, true);
  assert.equal(callCount, 1); // transitionFn was NOT called again
  assert.equal(second.gameState.stateVersion, 1); // unchanged — no second increment
  assert.deepEqual(second.transactions, []); // no reapplied effect
});

test('applyWithIdempotency: stateVersion increases monotonically across distinct actions', () => {
  const cache = createIdempotencyCache();
  let gameState = fakeGameState({ stateVersion: 0 });
  const transitionFn = (gs) => ({ gameState: { ...gs }, transactions: [] });

  ({ gameState } = applyWithIdempotency(gameState, { type: 'A', clientActionId: 'a1' }, cache, transitionFn, T0));
  assert.equal(gameState.stateVersion, 1);

  ({ gameState } = applyWithIdempotency(gameState, { type: 'B', clientActionId: 'a2' }, cache, transitionFn, T0));
  assert.equal(gameState.stateVersion, 2);

  ({ gameState } = applyWithIdempotency(gameState, { type: 'C', clientActionId: 'a3' }, cache, transitionFn, T0));
  assert.equal(gameState.stateVersion, 3);
});

test('applyWithIdempotency: a rejected action (transitionFn throws) leaves stateVersion unchanged and is never recorded', () => {
  const cache = createIdempotencyCache();
  const gameState = fakeGameState({ stateVersion: 3 });
  const action = { type: 'INVALID', clientActionId: 'a1' };
  const transitionFn = () => {
    throw new Error('rejected: not valid in this phase');
  };

  assert.throws(() => applyWithIdempotency(gameState, action, cache, transitionFn, T0), /rejected/);

  assert.equal(gameState.stateVersion, 3); // untouched
  assert.equal(isActionProcessed(cache, 'a1', T0), false); // never recorded — a genuine retry can still succeed

  // A retry with the same clientActionId is NOT deduped, since the failed
  // attempt was never recorded — it should reach transitionFn again.
  let called = false;
  const succeedingFn = (gs) => {
    called = true;
    return { gameState: { ...gs }, transactions: [] };
  };
  const retried = applyWithIdempotency(gameState, action, cache, succeedingFn, T0);
  assert.equal(called, true);
  assert.equal(retried.deduped, false);
  assert.equal(retried.gameState.stateVersion, 4);
});

test('applyWithIdempotency: an expired cache entry is eligible to be reapplied', () => {
  const cache = createIdempotencyCache();
  let gameState = fakeGameState({ stateVersion: 0 });
  const action = { type: 'PING', clientActionId: 'a1' };
  let callCount = 0;
  const transitionFn = (gs) => {
    callCount += 1;
    return { gameState: { ...gs }, transactions: [] };
  };

  ({ gameState } = applyWithIdempotency(gameState, action, cache, transitionFn, T0));
  assert.equal(callCount, 1);
  assert.equal(gameState.stateVersion, 1);

  const afterWindow = new Date(
    new Date(T0).getTime() + (IDEMPOTENCY_CACHE_WINDOW_SECONDS + 1) * 1000
  ).toISOString();
  const result = applyWithIdempotency(gameState, action, cache, transitionFn, afterWindow);

  assert.equal(callCount, 2); // reapplied — the earlier record had already expired
  assert.equal(result.deduped, false);
  assert.equal(result.gameState.stateVersion, 2);
});

test('applyWithIdempotency throws if action.clientActionId is missing', () => {
  const cache = createIdempotencyCache();
  const gameState = fakeGameState();
  const transitionFn = (gs) => ({ gameState: gs, transactions: [] });

  assert.throws(() => applyWithIdempotency(gameState, { type: 'PING' }, cache, transitionFn, T0), TypeError);
});

test('integration: applyWithIdempotency composes with the real transitionTurn, unmodified', () => {
  const gameState = createGameState({
    id: 'g1',
    roomId: 'r1',
    boardId: 'small',
    status: 'in_progress',
    phase: 'TURN_START',
    currentTurnIndex: 0,
    stateVersion: 0,
    players: [
      createPlayerGameState({ id: 'gp-bank', gameId: 'g1', isBank: true, currentBalance: 20000 }),
      createPlayerGameState({
        id: 'gp-alice',
        gameId: 'g1',
        playerId: 'alice',
        turnOrder: 0,
        currentBalance: 1500,
        currentPosition: 0,
      }),
    ],
    properties: [],
    startedAt: T0,
  });

  const cache = createIdempotencyCache();
  const action = { type: 'START_TURN', clientActionId: 'a1' };
  // turnMachine.js's transitionTurn takes (gameState, boardTiles, action, now);
  // boardTiles/now are bound here, exactly as this module's own docs describe
  // a real caller (a future Socket.IO handler) would do.
  const bound = (gs, act) => transitionTurn(gs, [], act, T0);

  const first = applyWithIdempotency(gameState, action, cache, bound, T0);
  assert.equal(first.deduped, false);
  assert.equal(first.gameState.phase, 'ROLLING'); // real transitionTurn output, untouched by this module
  assert.equal(first.gameState.stateVersion, 1); // turnMachine.js itself never touches stateVersion — this module supplied the increment

  const repeat = applyWithIdempotency(first.gameState, action, cache, bound, T0);
  assert.equal(repeat.deduped, true);
  assert.equal(repeat.gameState.stateVersion, 1); // no double-increment on the duplicate
});
