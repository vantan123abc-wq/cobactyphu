import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTradeAction, pruneExpiredTrades, TRADE_ACTION_TYPES } from './tradeMachine.js';
import { InvalidTradeError } from '../engine/trade.js';
import { createTrade } from '../domain/trade.js';
import { createProperty } from '../domain/property.js';
import { createGameState, createPlayerGameState } from '../domain/gameState.js';

function baseGameState(overrides = {}) {
  const players = [
    createPlayerGameState({ id: 'gp-bank', gameId: 'g1', isBank: true, currentBalance: 20000 }),
    createPlayerGameState({ id: 'gp-alice', gameId: 'g1', playerId: 'alice', turnOrder: 0, currentBalance: 1500, currentPosition: 0 }),
    createPlayerGameState({ id: 'gp-bob', gameId: 'g1', playerId: 'bob', turnOrder: 1, currentBalance: 1500, currentPosition: 0 }),
  ];
  const properties = [
    createProperty({ id: 'p1', gameId: 'g1', boardTileId: 't1', ownerId: 'gp-alice' }),
    createProperty({ id: 'p3', gameId: 'g1', boardTileId: 't3', ownerId: 'gp-bob' }),
  ];
  return createGameState({
    id: 'g1',
    roomId: 'r1',
    boardId: 'small',
    status: 'in_progress',
    // Deliberately NOT POST_ACTIONS / a "current player's own window" phase —
    // proves trade actions are genuinely independent of gameState.phase,
    // the core architecture decision this whole file exists to honor.
    phase: 'FLASH_AUCTION_ACTIVE',
    currentTurnIndex: 0,
    players,
    properties,
    startedAt: '2026-08-18T00:00:00.000Z',
  });
}

const NOW = '2026-08-18T00:00:00.000Z';
const LATER = '2026-08-18T00:00:30.000Z'; // 30s later, still within the 60s expiry window
const AFTER_EXPIRY = '2026-08-18T00:02:00.000Z'; // 2 minutes later, past the 60s expiry window

function proposeAction(overrides = {}) {
  return {
    type: 'PROPOSE_TRADE',
    payload: {
      tradeId: 'trade-1',
      playerId: 'gp-alice',
      targetId: 'gp-bob',
      proposerOffer: { properties: ['p1'], money: 100 },
      targetOffer: { properties: ['p3'], money: 0 },
      ...overrides,
    },
  };
}

test('TRADE_ACTION_TYPES lists exactly the five trade actions', () => {
  assert.deepEqual([...TRADE_ACTION_TYPES].sort(), ['ACCEPT_TRADE', 'CANCEL_TRADE', 'COUNTER_TRADE', 'PROPOSE_TRADE', 'REJECT_TRADE']);
});

test('PROPOSE_TRADE succeeds regardless of gameState.phase — no VALID_ACTIONS_BY_PHASE-style gate', () => {
  const { gameState } = applyTradeAction(baseGameState(), proposeAction(), NOW);
  assert.equal(gameState.pendingTrades.length, 1);
  assert.equal(gameState.pendingTrades[0].proposerId, 'gp-alice');
});

test('PROPOSE_TRADE with an invalid offer throws InvalidTradeError, gameState untouched by the caller', () => {
  assert.throws(
    () => applyTradeAction(baseGameState(), proposeAction({ proposerOffer: { properties: [], money: 999999 } }), NOW),
    (err) => err instanceof InvalidTradeError && err.reason === 'INSUFFICIENT_BALANCE'
  );
});

test('COUNTER_TRADE replaces the trade in pendingTrades: old one gone, new one present with flipped roles', () => {
  const { gameState: afterPropose } = applyTradeAction(baseGameState(), proposeAction(), NOW);

  const { gameState: afterCounter } = applyTradeAction(
    afterPropose,
    {
      type: 'COUNTER_TRADE',
      payload: {
        newTradeId: 'trade-2',
        playerId: 'gp-bob', // the original target, countering back
        tradeId: 'trade-1',
        proposerOffer: { properties: ['p3'], money: 50 },
        targetOffer: { properties: ['p1'], money: 0 },
      },
    },
    LATER
  );

  assert.equal(afterCounter.pendingTrades.length, 1);
  const [countered] = afterCounter.pendingTrades;
  assert.equal(countered.id, 'trade-2');
  assert.equal(countered.proposerId, 'gp-bob');
  assert.equal(countered.targetId, 'gp-alice');
  assert.equal(countered.counterDepth, 1);
});

test('COUNTER_TRADE rejects when the actor is not the current trade\'s target (NOT_TARGET)', () => {
  const { gameState: afterPropose } = applyTradeAction(baseGameState(), proposeAction(), NOW);
  assert.throws(
    () =>
      applyTradeAction(
        afterPropose,
        {
          type: 'COUNTER_TRADE',
          payload: {
            newTradeId: 'trade-2',
            playerId: 'gp-alice', // the proposer, not the target — cannot counter their own offer
            tradeId: 'trade-1',
            proposerOffer: { properties: [], money: 0 },
            targetOffer: { properties: [], money: 0 },
          },
        },
        LATER
      ),
    (err) => err instanceof InvalidTradeError && err.reason === 'NOT_TARGET'
  );
});

test('ACCEPT_TRADE atomically swaps money and properties in GameState and clears the trade', () => {
  const { gameState: afterPropose } = applyTradeAction(baseGameState(), proposeAction(), NOW);

  const { gameState: afterAccept, transactions } = applyTradeAction(
    afterPropose,
    { type: 'ACCEPT_TRADE', payload: { tradeId: 'trade-1', playerId: 'gp-bob' } },
    LATER
  );

  assert.equal(afterAccept.pendingTrades.length, 0);
  assert.equal(afterAccept.players.find((p) => p.id === 'gp-alice').currentBalance, 1500 - 100);
  assert.equal(afterAccept.players.find((p) => p.id === 'gp-bob').currentBalance, 1500 + 100);
  assert.equal(afterAccept.properties.find((p) => p.id === 'p1').ownerId, 'gp-bob'); // Alice's offered property -> Bob
  assert.equal(afterAccept.properties.find((p) => p.id === 'p3').ownerId, 'gp-alice'); // Bob's offered property -> Alice
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].transactionType, 'trade');
});

test('ACCEPT_TRADE rejects when the actor is not the trade\'s target (NOT_TARGET)', () => {
  const { gameState: afterPropose } = applyTradeAction(baseGameState(), proposeAction(), NOW);
  assert.throws(
    () => applyTradeAction(afterPropose, { type: 'ACCEPT_TRADE', payload: { tradeId: 'trade-1', playerId: 'gp-alice' } }, LATER),
    (err) => err instanceof InvalidTradeError && err.reason === 'NOT_TARGET'
  );
});

test('REJECT_TRADE by the target clears the trade with no asset movement', () => {
  const { gameState: afterPropose } = applyTradeAction(baseGameState(), proposeAction(), NOW);
  const { gameState: afterReject, transactions } = applyTradeAction(
    afterPropose,
    { type: 'REJECT_TRADE', payload: { tradeId: 'trade-1', playerId: 'gp-bob' } },
    LATER
  );
  assert.equal(afterReject.pendingTrades.length, 0);
  assert.equal(afterReject.players.find((p) => p.id === 'gp-alice').currentBalance, 1500); // untouched
  assert.equal(afterReject.properties.find((p) => p.id === 'p1').ownerId, 'gp-alice'); // untouched
  assert.equal(transactions.length, 0);
});

test('REJECT_TRADE rejects when the actor is not the target (NOT_TARGET) — the proposer cannot reject their own offer', () => {
  const { gameState: afterPropose } = applyTradeAction(baseGameState(), proposeAction(), NOW);
  assert.throws(
    () => applyTradeAction(afterPropose, { type: 'REJECT_TRADE', payload: { tradeId: 'trade-1', playerId: 'gp-alice' } }, LATER),
    (err) => err instanceof InvalidTradeError && err.reason === 'NOT_TARGET'
  );
});

test('CANCEL_TRADE by the proposer clears the trade with no asset movement', () => {
  const { gameState: afterPropose } = applyTradeAction(baseGameState(), proposeAction(), NOW);
  const { gameState: afterCancel } = applyTradeAction(
    afterPropose,
    { type: 'CANCEL_TRADE', payload: { tradeId: 'trade-1', playerId: 'gp-alice' } },
    LATER
  );
  assert.equal(afterCancel.pendingTrades.length, 0);
});

test('CANCEL_TRADE rejects when the actor is not the proposer (NOT_PROPOSER) — the target cannot cancel someone else\'s offer', () => {
  const { gameState: afterPropose } = applyTradeAction(baseGameState(), proposeAction(), NOW);
  assert.throws(
    () => applyTradeAction(afterPropose, { type: 'CANCEL_TRADE', payload: { tradeId: 'trade-1', playerId: 'gp-bob' } }, LATER),
    (err) => err instanceof InvalidTradeError && err.reason === 'NOT_PROPOSER'
  );
});

test('acting on an unknown tradeId throws TRADE_NOT_FOUND', () => {
  assert.throws(
    () => applyTradeAction(baseGameState(), { type: 'ACCEPT_TRADE', payload: { tradeId: 'nonexistent', playerId: 'gp-bob' } }, NOW),
    (err) => err instanceof InvalidTradeError && err.reason === 'TRADE_NOT_FOUND'
  );
});

test('an expired trade is lazily pruned — acting on it after expiresAt throws TRADE_NOT_FOUND, and its locked assets become available again', () => {
  const { gameState: afterPropose } = applyTradeAction(baseGameState(), proposeAction(), NOW);

  // Past the 60s expiry window — accepting the now-stale trade must fail as
  // if it never existed, not silently succeed on a deal nobody responded to
  // in time.
  assert.throws(
    () => applyTradeAction(afterPropose, { type: 'ACCEPT_TRADE', payload: { tradeId: 'trade-1', playerId: 'gp-bob' } }, AFTER_EXPIRY),
    (err) => err instanceof InvalidTradeError && err.reason === 'TRADE_NOT_FOUND'
  );

  // p1/money that were locked by the expired trade are free again — a fresh
  // proposal reusing the same asset succeeds once the old trade has lapsed.
  const { gameState: afterNewProposal } = applyTradeAction(
    afterPropose,
    proposeAction({ tradeId: 'trade-2', proposerOffer: { properties: ['p1'], money: 0 } }),
    AFTER_EXPIRY
  );
  assert.equal(afterNewProposal.pendingTrades.length, 1);
  assert.equal(afterNewProposal.pendingTrades[0].id, 'trade-2');
});

test('pruneExpiredTrades keeps trades not yet past expiresAt and drops ones that are', () => {
  const trade = createTrade({
    id: 't1',
    roomId: 'r1',
    proposerId: 'gp-alice',
    targetId: 'gp-bob',
    proposerOffer: { properties: [], money: 0 },
    targetOffer: { properties: [], money: 0 },
    status: 'PROPOSED',
    createdAt: NOW,
    expiresAt: '2026-08-18T00:01:00.000Z',
  });
  assert.equal(pruneExpiredTrades([trade], LATER).length, 1); // 30s < 60s expiry, still alive
  assert.equal(pruneExpiredTrades([trade], AFTER_EXPIRY).length, 0); // 2min > 60s expiry, pruned
});

test('two independent trades in the same room expire and resolve independently of each other', () => {
  let state = baseGameState();
  ({ gameState: state } = applyTradeAction(state, proposeAction({ tradeId: 'trade-1' }), NOW));
  ({ gameState: state } = applyTradeAction(
    state,
    proposeAction({ tradeId: 'trade-2', proposerOffer: { properties: [], money: 10 }, targetOffer: { properties: [], money: 0 } }),
    LATER
  ));
  assert.equal(state.pendingTrades.length, 2);

  const { gameState: afterAccept } = applyTradeAction(
    state,
    { type: 'ACCEPT_TRADE', payload: { tradeId: 'trade-2', playerId: 'gp-bob' } },
    LATER
  );
  assert.equal(afterAccept.pendingTrades.length, 1);
  assert.equal(afterAccept.pendingTrades[0].id, 'trade-1'); // untouched by resolving the other trade
});
