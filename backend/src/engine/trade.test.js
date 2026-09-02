import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposeTrade, counterTrade, acceptTrade, InvalidTradeError } from './trade.js';
import { createTrade, MAX_COUNTER_DEPTH } from '../domain/trade.js';
import { createProperty } from '../domain/property.js';
import { createGameState, createPlayerGameState } from '../domain/gameState.js';

function baseGameState() {
  const players = [
    createPlayerGameState({ id: 'gp-bank', gameId: 'g1', isBank: true, currentBalance: 20000 }),
    createPlayerGameState({ id: 'gp-alice', gameId: 'g1', playerId: 'alice', turnOrder: 0, currentBalance: 1500, currentPosition: 0 }),
    createPlayerGameState({ id: 'gp-bob', gameId: 'g1', playerId: 'bob', turnOrder: 1, currentBalance: 1500, currentPosition: 0 }),
  ];
  const properties = [
    createProperty({ id: 'p1', gameId: 'g1', boardTileId: 't1', ownerId: 'gp-alice' }),
    createProperty({ id: 'p2', gameId: 'g1', boardTileId: 't2', ownerId: 'gp-alice' }),
    createProperty({ id: 'p3', gameId: 'g1', boardTileId: 't3', ownerId: 'gp-bob' }),
    createProperty({ id: 'p4', gameId: 'g1', boardTileId: 't4' }), // unowned
  ];
  return createGameState({
    id: 'g1',
    roomId: 'r1',
    boardId: 'small',
    status: 'in_progress',
    phase: 'ROLLING', // deliberately not POST_ACTIONS — trade is phase-independent, tests below never check/depend on phase
    currentTurnIndex: 0,
    players,
    properties,
    startedAt: '2026-08-18T00:00:00.000Z',
  });
}

const NOW = '2026-08-18T00:00:00.000Z';

function propose(gameState, pendingTrades, overrides = {}) {
  return proposeTrade({
    id: 'trade-1',
    roomId: 'r1',
    gameState,
    pendingTrades,
    proposerId: 'gp-alice',
    targetId: 'gp-bob',
    proposerOffer: { properties: ['p1'], money: 100 },
    targetOffer: { properties: ['p3'], money: 0 },
    now: NOW,
    ...overrides,
  });
}

// --- proposeTrade ---

test('proposeTrade: valid offer on both sides creates a PROPOSED trade at counterDepth 0', () => {
  const trade = propose(baseGameState(), []);
  assert.equal(trade.status, 'PROPOSED');
  assert.equal(trade.counterDepth, 0);
  assert.equal(trade.previousTradeId, null);
  assert.equal(trade.proposerId, 'gp-alice');
  assert.equal(trade.targetId, 'gp-bob');
});

test('proposeTrade: rejects trading with yourself (SELF_TRADE)', () => {
  assert.throws(
    () => propose(baseGameState(), [], { targetId: 'gp-alice' }),
    (err) => err instanceof InvalidTradeError && err.reason === 'SELF_TRADE'
  );
});

test('proposeTrade: rejects targeting the Bank (NOT_A_PARTICIPANT)', () => {
  assert.throws(
    () => propose(baseGameState(), [], { targetId: 'gp-bank' }),
    (err) => err instanceof InvalidTradeError && err.reason === 'NOT_A_PARTICIPANT'
  );
});

// 2026-08-25: bankrupt players are eliminated/spectator-only. Every other
// route was already closed (advanceTurn skips them, startAuction excludes
// them, applyBankruptcy drops their pending trades) — trades were the one
// real hole, since they're deliberately turn- AND phase-independent, so a
// solvent player could gift assets to an eliminated one and resurrect them.
test('proposeTrade: rejects a bankrupt PROPOSER (PLAYER_BANKRUPT)', () => {
  const gameState = baseGameState();
  const bankrupted = {
    ...gameState,
    players: gameState.players.map((p) => (p.id === 'gp-alice' ? { ...p, bankrupt: true } : p)),
  };
  assert.throws(
    () => propose(bankrupted, []),
    (err) => err instanceof InvalidTradeError && err.reason === 'PLAYER_BANKRUPT'
  );
});

test('proposeTrade: rejects a bankrupt TARGET too — a solvent player cannot gift assets to an eliminated one (PLAYER_BANKRUPT)', () => {
  const gameState = baseGameState();
  const bankrupted = {
    ...gameState,
    players: gameState.players.map((p) => (p.id === 'gp-bob' ? { ...p, bankrupt: true } : p)),
  };
  // Bob's own side of the deal offers nothing at all — a pure one-way gift,
  // which is exactly the resurrection case this guard exists to stop, and
  // the case an owner-only or offer-non-empty check would have missed.
  assert.throws(
    () => propose(bankrupted, [], { targetOffer: { properties: [], money: 0 } }),
    (err) => err instanceof InvalidTradeError && err.reason === 'PLAYER_BANKRUPT'
  );
});

test('acceptTrade: rejects when a counterparty went bankrupt between proposing and accepting (PLAYER_BANKRUPT)', () => {
  const gameState = baseGameState();
  const trade = propose(gameState, []); // both solvent at propose time
  const bankrupted = {
    ...gameState,
    players: gameState.players.map((p) => (p.id === 'gp-alice' ? { ...p, bankrupt: true } : p)),
  };
  assert.throws(
    () => acceptTrade({ gameState: bankrupted, pendingTrades: [trade], trade, actorId: 'gp-bob' }),
    (err) => err instanceof InvalidTradeError && err.reason === 'PLAYER_BANKRUPT'
  );
});

test('proposeTrade: rejects offering a property the proposer does not own (NOT_OWNER)', () => {
  assert.throws(
    () => propose(baseGameState(), [], { proposerOffer: { properties: ['p3'], money: 0 } }), // p3 is Bob's
    (err) => err instanceof InvalidTradeError && err.reason === 'NOT_OWNER'
  );
});

test('proposeTrade: rejects offering more money than the proposer has (INSUFFICIENT_BALANCE)', () => {
  assert.throws(
    () => propose(baseGameState(), [], { proposerOffer: { properties: [], money: 2000 } }),
    (err) => err instanceof InvalidTradeError && err.reason === 'INSUFFICIENT_BALANCE'
  );
});

test('proposeTrade: double-spend — a property already offered in another active trade cannot be offered again (ASSET_LOCKED)', () => {
  const gameState = baseGameState();
  const firstTrade = propose(gameState, [], { id: 'trade-1' }); // locks p1 (Alice) and p3 (Bob)

  assert.throws(
    () =>
      proposeTrade({
        id: 'trade-2',
        roomId: 'r1',
        gameState,
        pendingTrades: [firstTrade],
        proposerId: 'gp-alice',
        targetId: 'gp-bob',
        proposerOffer: { properties: ['p1'], money: 0 }, // p1 already locked in trade-1
        targetOffer: { properties: [], money: 0 },
        now: NOW,
      }),
    (err) => err instanceof InvalidTradeError && err.reason === 'ASSET_LOCKED'
  );
});

test('proposeTrade: double-spend — money already committed to another active trade cannot be offered again (INSUFFICIENT_BALANCE)', () => {
  const gameState = baseGameState(); // Alice has 1500
  const firstTrade = propose(gameState, [], { id: 'trade-1', proposerOffer: { properties: [], money: 1000 } }); // locks 1000 of Alice's 1500

  // Alice only has 500 unlocked left; offering 600 more (1000 + 600 = 1600 > 1500) must fail
  // even though 600 alone is well under her total balance.
  assert.throws(
    () =>
      proposeTrade({
        id: 'trade-2',
        roomId: 'r1',
        gameState,
        pendingTrades: [firstTrade],
        proposerId: 'gp-alice',
        targetId: 'gp-bob',
        proposerOffer: { properties: [], money: 600 },
        targetOffer: { properties: [], money: 0 },
        now: NOW,
      }),
    (err) => err instanceof InvalidTradeError && err.reason === 'INSUFFICIENT_BALANCE'
  );
});

test('proposeTrade: a second, non-overlapping trade proposes fine while the first is still active', () => {
  const gameState = baseGameState();
  const firstTrade = propose(gameState, [], { id: 'trade-1' }); // locks p1, p3

  const secondTrade = proposeTrade({
    id: 'trade-2',
    roomId: 'r1',
    gameState,
    pendingTrades: [firstTrade],
    proposerId: 'gp-alice',
    targetId: 'gp-bob',
    proposerOffer: { properties: ['p2'], money: 0 }, // different property, not locked
    targetOffer: { properties: [], money: 0 },
    now: NOW,
  });
  assert.equal(secondTrade.proposerOffer.properties[0], 'p2');
});

// --- counterTrade ---

test('counterTrade: flips proposer/target, increments counterDepth, links previousTradeId', () => {
  const gameState = baseGameState();
  const original = propose(gameState, []);

  const countered = counterTrade({
    id: 'trade-2',
    gameState,
    pendingTrades: [], // caller (tradeMachine.js) already removed the original before calling this in real flow
    existingTrade: original,
    counterOffer: { proposerOffer: { properties: ['p3'], money: 50 }, targetOffer: { properties: ['p1'], money: 0 } },
    now: NOW,
  });

  assert.equal(countered.proposerId, 'gp-bob'); // the original target counters back
  assert.equal(countered.targetId, 'gp-alice');
  assert.equal(countered.counterDepth, 1);
  assert.equal(countered.previousTradeId, 'trade-1');
});

test('counterTrade: rejects once the existing trade is already at MAX_COUNTER_DEPTH', () => {
  const gameState = baseGameState();
  const atMax = createTrade({
    id: 'trade-5',
    roomId: 'r1',
    proposerId: 'gp-alice',
    targetId: 'gp-bob',
    proposerOffer: { properties: [], money: 0 },
    targetOffer: { properties: [], money: 0 },
    status: 'PROPOSED',
    createdAt: NOW,
    expiresAt: '2026-08-18T00:01:00.000Z',
    counterDepth: MAX_COUNTER_DEPTH,
  });

  assert.throws(
    () =>
      counterTrade({
        id: 'trade-6',
        gameState,
        pendingTrades: [],
        existingTrade: atMax,
        counterOffer: { proposerOffer: { properties: [], money: 0 }, targetOffer: { properties: [], money: 0 } },
        now: NOW,
      }),
    (err) => err instanceof InvalidTradeError && err.reason === 'MAX_COUNTER_DEPTH_EXCEEDED'
  );
});

test('counterTrade: the counter-offer itself is validated (NOT_OWNER if the counterer offers something they do not own)', () => {
  const gameState = baseGameState();
  const original = propose(gameState, []);

  assert.throws(
    () =>
      counterTrade({
        id: 'trade-2',
        gameState,
        pendingTrades: [],
        existingTrade: original,
        counterOffer: { proposerOffer: { properties: ['p1'], money: 0 }, targetOffer: { properties: [], money: 0 } }, // p1 is Alice's, not Bob's (the new proposer)
        now: NOW,
      }),
    (err) => err instanceof InvalidTradeError && err.reason === 'NOT_OWNER'
  );
});

// --- acceptTrade ---

test('acceptTrade: only the trade\'s targetId may accept (NOT_TARGET)', () => {
  const gameState = baseGameState();
  const trade = propose(gameState, []);
  assert.throws(
    () => acceptTrade({ gameState, pendingTrades: [trade], trade, actorId: 'gp-alice' }), // the proposer, not the target
    (err) => err instanceof InvalidTradeError && err.reason === 'NOT_TARGET'
  );
});

test('acceptTrade: returns direct player-to-player transfers covering both directions of money and property', () => {
  const gameState = baseGameState();
  const trade = propose(gameState, [], {
    proposerOffer: { properties: ['p1'], money: 100 },
    targetOffer: { properties: ['p3'], money: 50 },
  });

  const { moneyTransfers, propertyTransfers } = acceptTrade({ gameState, pendingTrades: [trade], trade, actorId: 'gp-bob' });

  assert.deepEqual(moneyTransfers, [
    { fromPlayerId: 'gp-alice', toPlayerId: 'gp-bob', amount: 100 },
    { fromPlayerId: 'gp-bob', toPlayerId: 'gp-alice', amount: 50 },
  ]);
  assert.deepEqual(propertyTransfers, [
    { propertyId: 'p1', toPlayerId: 'gp-bob' },
    { propertyId: 'p3', toPlayerId: 'gp-alice' },
  ]);
});

test('acceptTrade: omits a money transfer entirely for a side offering 0', () => {
  const gameState = baseGameState();
  const trade = propose(gameState, [], {
    proposerOffer: { properties: ['p1'], money: 0 },
    targetOffer: { properties: [], money: 0 },
  });
  const { moneyTransfers, propertyTransfers } = acceptTrade({ gameState, pendingTrades: [trade], trade, actorId: 'gp-bob' });
  assert.deepEqual(moneyTransfers, []);
  assert.deepEqual(propertyTransfers, [{ propertyId: 'p1', toPlayerId: 'gp-bob' }]);
});

test('acceptTrade: re-validates ownership at accept time — rejects if it changed since the offer was made', () => {
  const gameState = baseGameState();
  const trade = propose(gameState, []); // Alice offers p1, owned by her at propose-time

  // Simulate p1 changing hands between propose and accept (e.g. some other
  // mechanism transferred it) — acceptTrade must not blindly trust the
  // trade record's own snapshot of what was offered.
  const laterGameState = {
    ...gameState,
    properties: gameState.properties.map((p) => (p.id === 'p1' ? { ...p, ownerId: 'gp-bob' } : p)),
  };

  assert.throws(
    () => acceptTrade({ gameState: laterGameState, pendingTrades: [trade], trade, actorId: 'gp-bob' }),
    (err) => err instanceof InvalidTradeError && err.reason === 'NOT_OWNER'
  );
});
