import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  transitionTurn,
  getCurrentPlayer,
  InvalidTurnActionError,
  InvalidPropertyActionError,
  InvalidInventoryActionError,
  InvalidForfeitError,
  InvalidDraftActionError,
  InvalidTrapActionError,
} from './turnMachine.js';
import { createTile } from '../domain/tile.js';
import { createProperty } from '../domain/property.js';
import { createGameState, createPlayerGameState } from '../domain/gameState.js';
import { EventChoiceError } from '../engine/eventResolver.js';
import { InvalidBidError, startAuction, placeBid } from '../engine/auction.js';
import { FINAL_PHASE_TRIGGER_ROUND, FINAL_PHASE_DURATION_ROUNDS } from './gameEndMachine.js';

// movement.js only accepts the two locked board sizes (36/44) — a real
// 36-tile board is built here rather than a handful of ad hoc fixtures,
// since ROLL_DICE exercises movePlayer() directly.
function buildSmallBoard() {
  const fixed = [
    { position: 0, tileType: 'go', name: 'GO' },
    {
      position: 1,
      tileType: 'property',
      name: 'Brown Ave 1',
      groupId: 'brown',
      price: 60,
      baseRent: 2,
      rentTable: [10, 30, 90, 160, 250],
      houseCost: 50,
      mortgageValue: 30,
    },
    { position: 2, tileType: 'transport', name: 'Station A', price: 200, baseRent: 25, mortgageValue: 100 },
    { position: 3, tileType: 'chance', name: 'Chance' },
    { position: 4, tileType: 'jail', name: 'Jail (Just Visiting)' },
    { position: 5, tileType: 'tax', name: 'Income Tax', taxAmount: 100 },
    { position: 6, tileType: 'utility', name: 'Electric Co', price: 150, mortgageValue: 75 },
    { position: 7, tileType: 'fortune', name: 'Fortune' },
    { position: 8, tileType: 'go_to_jail', name: 'Go To Jail' },
    { position: 9, tileType: 'free_parking', name: 'Free Parking' },
    {
      position: 10,
      tileType: 'property',
      name: 'Owned Property',
      // No groupId — deliberately ungrouped, so the rent test below
      // exercises plain unimproved rent, not the group-bonus branch
      // (already covered thoroughly in calculateRent.test.js).
      price: 100,
      baseRent: 6,
      rentTable: [30, 90, 270, 400, 550],
      houseCost: 50,
      mortgageValue: 50,
    },
  ];

  const tiles = fixed.map((f) => createTile({ id: `t${f.position}`, boardId: 'small', ...f }));
  for (let position = fixed.length; position < 36; position++) {
    tiles.push(
      createTile({
        id: `t${position}`,
        boardId: 'small',
        position,
        tileType: 'property',
        name: `Filler ${position}`,
        price: 80,
        baseRent: 4,
        rentTable: [20, 60, 180, 320, 450],
        houseCost: 50,
        mortgageValue: 40,
      })
    );
  }
  return tiles;
}

function baseGameState(overrides = {}) {
  const players = [
    createPlayerGameState({ id: 'gp-bank', gameId: 'g1', isBank: true, currentBalance: 20000 }),
    createPlayerGameState({
      id: 'gp-alice',
      gameId: 'g1',
      playerId: 'alice',
      turnOrder: 0,
      currentBalance: 1500,
      currentPosition: 0,
    }),
    createPlayerGameState({
      id: 'gp-bob',
      gameId: 'g1',
      playerId: 'bob',
      turnOrder: 1,
      currentBalance: 1500,
      currentPosition: 0,
    }),
  ];
  const properties = [
    createProperty({ id: 'p1', gameId: 'g1', boardTileId: 't1' }), // unowned
    createProperty({ id: 'p10', gameId: 'g1', boardTileId: 't10', ownerId: 'gp-bob' }), // owned by Bob, unmortgaged
    createProperty({ id: 'p2', gameId: 'g1', boardTileId: 't2' }), // unowned transport
    createProperty({ id: 'p6', gameId: 'g1', boardTileId: 't6' }), // unowned utility
  ];
  for (let position = 11; position < 36; position++) {
    properties.push(createProperty({ id: `p${position}`, gameId: 'g1', boardTileId: `t${position}` }));
  }

  return createGameState({
    id: 'g1',
    roomId: 'r1',
    boardId: 'small',
    status: 'in_progress',
    phase: 'TURN_START',
    currentTurnIndex: 0,
    players,
    properties,
    // Default draw order for DRAWING_CARD tests: DIVIDEND_50 (INSTANT) first,
    // then INVESTMENT_OPPORTUNITY (CHOICE) — override per-test to force the
    // other order.
    eventDeck: ['DIVIDEND_50', 'INVESTMENT_OPPORTUNITY'],
    startedAt: '2026-08-17T00:00:00.000Z',
    ...overrides,
  });
}

function roll(die1, die2, doublesStreak = 0) {
  return {
    die1,
    die2,
    total: die1 + die2,
    isDouble: die1 === die2,
    doublesStreak: die1 === die2 ? doublesStreak + 1 : 0,
    sentToJail: false,
  };
}

const board = buildSmallBoard();

test('TURN_START routes to ROLLING when the current player is not in jail', () => {
  const { gameState } = transitionTurn(baseGameState(), board, { type: 'START_TURN' });
  assert.equal(gameState.phase, 'ROLLING');
});

test('TURN_START routes to JAIL_DECISION when the current player is in jail', () => {
  const state = baseGameState();
  state.players[1] = { ...state.players[1], inJail: true };
  const { gameState } = transitionTurn(state, board, { type: 'START_TURN' });
  assert.equal(gameState.phase, 'JAIL_DECISION');
});

test('an action illegal for the current phase throws InvalidTurnActionError', () => {
  const state = { ...baseGameState(), phase: 'ROLLING' };
  assert.throws(() => transitionTurn(state, board, { type: 'BUY_PROPERTY' }), InvalidTurnActionError);
});

test('rolling onto an unowned property lands at AWAITING_PURCHASE', () => {
  const state = { ...baseGameState(), phase: 'ROLLING' };
  // total 2 (minimum possible on two dice) -> position 2, Station A (transport, unowned)
  const { gameState } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 1) });
  assert.equal(gameState.phase, 'AWAITING_PURCHASE');
  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentPosition, 2);
});

test('ROLL_DICE: records the real die faces on gameState.lastRoll, trimmed to die1/die2/total/isDouble (2026-08-21)', () => {
  const state = { ...baseGameState(), phase: 'ROLLING' };
  const { gameState } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(3, 4) });
  assert.deepEqual(gameState.lastRoll, { die1: 3, die2: 4, total: 7, isDouble: false });
});

// REVERSED 2026-08-25 (was: "TURN_START resets lastRoll to null — a fresh
// turn must not show the previous player's stale roll"). Clearing it on
// every turn advance meant three real rolls produced NO visible dice for
// anyone, because each ends the turn in the same transition and cascades
// into the next player's startTurn(): a failed jail-escape, a 3rd
// consecutive double, and landing on Go To Jail. Since no game logic reads
// lastRoll, keeping it is display-only, and "when to stop showing the dice"
// becomes a presentation concern (DiceRoll.jsx auto-hides on lastRollSeq).
test('TURN_START keeps lastRoll so every roll stays visible to the table — only the rules fields reset', () => {
  let state = { ...baseGameState(), phase: 'ROLLING' };
  ({ gameState: state } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 1) }));
  assert.ok(state.lastRoll);
  const rolled = state.lastRoll;

  const { gameState: nextTurn } = transitionTurn({ ...state, currentTurnIndex: 1, phase: 'TURN_START' }, board, { type: 'START_TURN' });
  assert.deepEqual(nextTurn.lastRoll, rolled); // survives, for display
  // The fields the RULES actually depend on are still reset, which is what
  // matters for correctness — a new turn must not inherit a doubles streak.
  assert.equal(nextTurn.lastRollWasDouble, null);
  assert.equal(nextTurn.currentDoublesStreak, 0);
});

test('a failed jail escape still records real dice for display', () => {
  // Was previously invisible: the path used to advance the turn in the same
  // transition, so the old startTurn() reset wiped the dice before any
  // broadcast could carry them. Still worth pinning after the 2026-09-01
  // revision (the turn no longer advances here) — the dice must survive into
  // the POST_ACTIONS window the jailed player now gets.
  const jailed = baseGameState().players.map((p) =>
    p.id === 'gp-alice' ? { ...p, inJail: true, jailTurns: 0, currentPosition: 4 } : p
  );
  const state = { ...baseGameState(), players: jailed, phase: 'JAIL_DECISION' };

  const { gameState } = transitionTurn(state, board, {
    type: 'ATTEMPT_JAIL_ROLL',
    payload: { die1: 2, die2: 5, total: 7, isDouble: false, doublesStreak: 0, sentToJail: false },
  });

  assert.deepEqual(gameState.lastRoll, { die1: 2, die2: 5, total: 7, isDouble: false });
  assert.equal(gameState.lastRollSeq, 1);
  assert.equal(gameState.phase, 'POST_ACTIONS');
});

test('BUY_PROPERTY charges the price and transfers ownership', () => {
  let state = { ...baseGameState(), phase: 'ROLLING' };
  ({ gameState: state } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 1) }));
  const { gameState: afterBuy, transactions } = transitionTurn(state, board, { type: 'BUY_PROPERTY' }, '2026-08-17T12:00:00.000Z');

  assert.equal(afterBuy.phase, 'POST_ACTIONS');
  assert.equal(afterBuy.players.find((p) => p.id === 'gp-alice').currentBalance, 1500 - 200);
  const property = afterBuy.properties.find((p) => p.boardTileId === 't2');
  assert.equal(property.ownerId, 'gp-alice');
  assert.equal(property.acquiredAt, '2026-08-17T12:00:00.000Z');
  assert.equal(property.acquiredAtRound, afterBuy.roundNumber); // 2026-08-25: RECENTLY_ACQUIRED's own gate reads this
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].transactionType, 'purchase');
});

// The real source of the negative balances seen in a live match (a player
// sitting at $-293), found 2026-08-25 by fuzzing rather than review.
// BUY_PROPERTY was the oldest and most-used spending action in the game and
// the ONLY voluntary purchase with no affordability check — BUILD_HOUSE,
// UNMORTGAGE and HOSTILE_BUYOUT each had one, this did not.
test('BUY_PROPERTY: rejects when the player cannot afford the price, instead of driving them negative', () => {
  let state = { ...baseGameState(), phase: 'ROLLING' };
  ({ gameState: state } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 1) })); // t2, price 200
  const poor = {
    ...state,
    players: state.players.map((p) => (p.id === 'gp-alice' ? { ...p, currentBalance: 199 } : p)),
  };

  assert.throws(
    () => transitionTurn(poor, board, { type: 'BUY_PROPERTY' }, '2026-08-17T12:00:00.000Z'),
    (err) => err instanceof InvalidPropertyActionError && err.reason === 'INSUFFICIENT_BALANCE'
  );

  // Exactly the price is still affordable — the boundary is `<`, not `<=`.
  const exact = {
    ...state,
    players: state.players.map((p) => (p.id === 'gp-alice' ? { ...p, currentBalance: 200 } : p)),
  };
  const { gameState: bought } = transitionTurn(exact, board, { type: 'BUY_PROPERTY' }, '2026-08-17T12:00:00.000Z');
  assert.equal(bought.players.find((p) => p.id === 'gp-alice').currentBalance, 0);
  assert.equal(bought.properties.find((p) => p.boardTileId === 't2').ownerId, 'gp-alice');
});

test('FORCE_AUCTION: charges the auction fee and starts a Flash Auction (V2)', () => {
  let state = { ...baseGameState(), phase: 'ROLLING' };
  ({ gameState: state } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 1) })); // Station A, price 200
  const { gameState: after, transactions } = transitionTurn(state, board, { type: 'FORCE_AUCTION' });

  // calculateAuctionFee(200) = max(20, min(80, 10)) = 20
  assert.equal(after.phase, 'FLASH_AUCTION_ACTIVE');
  assert.equal(after.players.find((p) => p.id === 'gp-alice').currentBalance, 1500 - 20);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].transactionType, 'flash_auction');
  assert.equal(transactions[0].amount, 20);
  assert.equal(transactions[0].fromGamePlayerId, 'gp-alice');
  assert.equal(transactions[0].toGamePlayerId, 'gp-bank');

  const auction = after.pendingAuction;
  assert.equal(auction.propertyId, 'p2');
  assert.equal(auction.basePrice, 200);
  assert.equal(auction.currentBid, 200); // opens at 100% of price
  assert.equal(auction.highestBidderId, null);
  assert.equal(auction.initiatorId, 'gp-alice');
  assert.equal(auction.bankId, 'gp-bank'); // V2: bankId stored for commission settlement
  // V2 Broker rule: the host is EXCLUDED from their own auction — they take
  // the 20% commission instead of bidding. Alice initiated, so only Bob bids.
  assert.deepEqual(auction.activeBidders, ['gp-bob']);
  assert.equal(after.properties.find((p) => p.boardTileId === 't2').ownerId, null); // not transferred yet
});

// --- Custom opening price (2026-09-03) ---
// Station A is price 200, so the allowed band is [ceil(200*0.5), 200] = [100, 200]
// and the fee is calculateAuctionFee(200) = 20.
test('FORCE_AUCTION: a custom opening price opens the auction there', () => {
  let state = { ...baseGameState(), phase: 'ROLLING' };
  ({ gameState: state } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 1) }));
  const { gameState: after } = transitionTurn(state, board, { type: 'FORCE_AUCTION', payload: { basePrice: 120 } });

  assert.equal(after.pendingAuction.basePrice, 120);
  assert.equal(after.pendingAuction.currentBid, 120); // opening bid follows it
});

test('FORCE_AUCTION: the fee follows the HOST-CHOSEN opening price, not the printed price', () => {
  // Renamed and re-pointed 2026-09-04. This previously asserted the OPPOSITE
  // ("discounting the opening price does NOT discount the fee") and kept
  // passing after the basis changed to basePrice, purely because 5% of both
  // 100 and 200 clamps to the same $20 floor — a green test documenting a rule
  // the code had stopped following. Two cases now, picked so the floor cannot
  // mask the difference a second time.
  let state = { ...baseGameState(), phase: 'ROLLING' };
  ({ gameState: state } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 1) }));

  // Opening ABOVE the printed $200: 5% of 1000 is $50, well clear of the floor.
  const { gameState: high, transactions: highTx } = transitionTurn(state, board, { type: 'FORCE_AUCTION', payload: { basePrice: 1000 } });
  assert.equal(highTx[0].amount, 50, 'fee is 5% of the chosen opening, not of the printed 200');
  assert.equal(high.pendingAuction.basePrice, 1000);

  // Opening BELOW it: 5% of 100 is $5, so the $20 fee floor is what binds.
  const { gameState: low, transactions: lowTx } = transitionTurn(state, board, { type: 'FORCE_AUCTION', payload: { basePrice: 100 } });
  assert.equal(lowTx[0].amount, 20, 'the fee floor still applies to a cheap opening');
  assert.equal(low.players.find((p) => p.id === 'gp-alice').currentBalance, 1500 - 20);
  assert.equal(low.pendingAuction.basePrice, 100);
});

// Rewritten 2026-09-04. These two previously pinned a [50% of printed,
// printed] band that "allow any positive opening price, no upper/lower bound"
// (2026-09-03) deliberately removed — so they had been RED on master ever
// since: the code moved and the tests did not. They now pin what actually
// ships, which is a single rule: a positive integer. The collusion risk the
// old floor guarded against is recorded as a known, accepted trade in
// handleForceAuction's own comment, and deliberately not re-asserted here, so
// this file describes the shipped rule and nothing else.
test('FORCE_AUCTION: any positive integer opening price is accepted — no floor, no ceiling', () => {
  let state = { ...baseGameState(), phase: 'ROLLING' };
  ({ gameState: state } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 1) }));
  // 1 and 99 sit under the removed 50% floor; 201 and 1000 sit over the
  // removed printed-price ceiling — the exact values the old band rejected.
  for (const good of [1, 99, 201, 1000]) {
    const { gameState: after } = transitionTurn(state, board, { type: 'FORCE_AUCTION', payload: { basePrice: good } });
    assert.equal(after.pendingAuction.basePrice, good, `basePrice ${good} should have been accepted`);
  }
});

test('FORCE_AUCTION: a non-integer or non-positive opening price is still rejected (INVALID_BASE_PRICE)', () => {
  let state = { ...baseGameState(), phase: 'ROLLING' };
  ({ gameState: state } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 1) }));
  for (const bad of [150.5, 0, -50]) {
    assert.throws(
      () => transitionTurn(state, board, { type: 'FORCE_AUCTION', payload: { basePrice: bad } }),
      (err) => err instanceof InvalidPropertyActionError && err.reason === 'INVALID_BASE_PRICE',
      `basePrice ${bad} should have been rejected`
    );
  }
});

test('FORCE_AUCTION: omitting basePrice still opens at the printed price (unchanged default)', () => {
  let state = { ...baseGameState(), phase: 'ROLLING' };
  ({ gameState: state } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 1) }));
  const { gameState: after } = transitionTurn(state, board, { type: 'FORCE_AUCTION' });
  assert.equal(after.pendingAuction.basePrice, 200);
});

test('FORCE_AUCTION, insufficient balance: throws instead of silently skipping (V2)', () => {
  const poor = {
    ...baseGameState(),
    players: baseGameState().players.map((p) => (p.id === 'gp-alice' ? { ...p, currentBalance: 10 } : p)), // below $20 fee
    phase: 'ROLLING',
  };
  let state = poor;
  ({ gameState: state } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 1) }));
  // V2: FORCE_AUCTION throws when player cannot afford the fee — client must check before offering the button.
  //
  // The class and reason are asserted deliberately (2026-09-02): this test
  // used to be a bare assert.throws(), which is why it stayed green while the
  // handler threw InvalidTurnActionError — a class errorCodeFor() maps to
  // PHASE_MISMATCH, so the player was told "wrong phase" when the real
  // problem was money. A throws-anything assertion cannot catch a
  // wrong-reason bug; naming the reason is the whole point of the test.
  assert.throws(
    () => transitionTurn(state, board, { type: 'FORCE_AUCTION' }),
    (err) => err instanceof InvalidPropertyActionError && err.reason === 'INSUFFICIENT_BALANCE'
  );
});

test('SKIP_PURCHASE: free skip — no fee, straight to POST_ACTIONS (V2)', () => {
  let state = { ...baseGameState(), phase: 'ROLLING' };
  ({ gameState: state } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 1) }));
  const { gameState: after, transactions } = transitionTurn(state, board, { type: 'SKIP_PURCHASE' });

  assert.equal(after.phase, 'POST_ACTIONS');
  assert.equal(transactions.length, 0);
  assert.equal(after.players.find((p) => p.id === 'gp-alice').currentBalance, 1500); // untouched
  assert.equal(after.pendingAuction, null);
  assert.equal(after.properties.find((p) => p.boardTileId === 't2').ownerId, null); // still unowned
});

test('DECLINE_PURCHASE (legacy alias): behaves like SKIP_PURCHASE — free, no auction (V2 backward-compat)', () => {
  let state = { ...baseGameState(), phase: 'ROLLING' };
  ({ gameState: state } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 1) }));
  const { gameState: after, transactions } = transitionTurn(state, board, { type: 'DECLINE_PURCHASE' });

  assert.equal(after.phase, 'POST_ACTIONS'); // not FLASH_AUCTION_ACTIVE anymore
  assert.equal(transactions.length, 0);
  assert.equal(after.players.find((p) => p.id === 'gp-alice').currentBalance, 1500); // no fee
  assert.equal(after.pendingAuction, null);
});


test('passing GO pays PASS_GO_SALARY before landing resolution', () => {
  const state = {
    ...baseGameState(),
    players: baseGameState().players.map((p) => (p.id === 'gp-alice' ? { ...p, currentPosition: 34 } : p)),
    phase: 'ROLLING',
  };
  const { gameState, transactions } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(4, 0) }); // 34 + 4 = 38, wraps to 2

  const alice = gameState.players.find((p) => p.id === 'gp-alice');
  assert.equal(alice.currentPosition, 2);
  assert.equal(alice.currentBalance, 1500 + 200); // PASS_GO_SALARY credited
  assert.ok(transactions.some((t) => t.transactionType === 'pass_go_salary'));
});

test('landing on tax, solvent: pays the Bank and reaches POST_ACTIONS', () => {
  const state = { ...baseGameState(), phase: 'ROLLING' };
  const { gameState, transactions } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(3, 2) }); // total 5 -> tax tile

  assert.equal(gameState.phase, 'POST_ACTIONS');
  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentBalance, 1500 - 100);
  assert.ok(transactions.some((t) => t.transactionType === 'tax' && t.amount === 100));
});

test('landing on tax, cash-short but solvent via liquidation: stops at LIQUIDATION_REQUIRED, no transaction applied yet', () => {
  // Owns Station A (transport, mortgageValue 100) — cash 10 + liquidatable
  // 100 = 110 >= debt 100, so solvent via liquidation (not bankrupt), but
  // not payable from cash alone (10 < 100) either.
  const withProperty = {
    ...baseGameState(),
    players: baseGameState().players.map((p) => (p.id === 'gp-alice' ? { ...p, currentBalance: 10 } : p)),
    properties: baseGameState().properties.map((p) => (p.id === 'p2' ? { ...p, ownerId: 'gp-alice' } : p)),
    phase: 'ROLLING',
  };
  const { gameState, transactions } = transitionTurn(withProperty, board, { type: 'ROLL_DICE', payload: roll(3, 2) }); // tax tile, owes 100

  assert.equal(gameState.phase, 'LIQUIDATION_REQUIRED');
  assert.deepEqual(gameState.pendingLiquidation, { debtorId: 'gp-alice', creditorId: 'gp-bank', amount: 100, transactionType: 'tax' });
  assert.equal(transactions.length, 0);
  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentBalance, 10); // untouched
});

test('landing on tax, genuinely bankrupt (no liquidatable assets at all): eliminated in kind, and — as the second-to-last active player — the match ends immediately', () => {
  const poor = {
    ...baseGameState(),
    players: baseGameState().players.map((p) => (p.id === 'gp-alice' ? { ...p, currentBalance: 10 } : p)),
    phase: 'ROLLING',
  };
  const { gameState, transactions } = transitionTurn(poor, board, { type: 'ROLL_DICE', payload: roll(3, 2) }, '2026-08-19T12:00:00.000Z'); // tax tile, owes 100, has 10 cash and no properties at all

  const alice = gameState.players.find((p) => p.id === 'gp-alice');
  const bob = gameState.players.find((p) => p.id === 'gp-bob');

  assert.equal(alice.bankrupt, true);
  assert.equal(alice.bankruptAt, '2026-08-19T12:00:00.000Z');
  assert.equal(alice.currentBalance, 0);
  assert.ok(transactions.some((t) => t.transactionType === 'bankruptcy_transfer' && t.fromGamePlayerId === 'gp-alice' && t.amount === 10));

  // Only Bob is left non-bankrupt -> elimination win, checked immediately,
  // not deferred to a turn boundary.
  assert.equal(gameState.status, 'finished');
  assert.equal(gameState.phase, null);
  assert.equal(gameState.endReason, 'elimination');
  assert.equal(gameState.endedAt, '2026-08-19T12:00:00.000Z');
  assert.equal(bob.finalRank, 1);
  assert.equal(alice.finalRank, 2);
  // Bob: 1500 cash (untouched — Alice's tax went to the Bank, not him) + p10
  // (Owned Property, price 100, unmortgaged, unimproved) = 1600 net worth.
  assert.equal(bob.finalCash, 1500);
  assert.equal(bob.finalPropertyValue, 100);
  assert.equal(bob.finalNetWorth, 1600);
  // A real bankruptcy transfers everything away — nothing left to break down.
  assert.equal(alice.finalCash, 0);
  assert.equal(alice.finalPropertyValue, 0);
  assert.equal(alice.finalNetWorth, 0);
});

// REWRITTEN 2026-08-25 (was: "reaches RENT_RISK_DECISION, then a STANDARD
// choice pays them directly, Bank uninvolved") — Rent Risk Choice no longer
// blocks rent behind an owner decision at all; see turnMachine.js's own
// resolveLanding PAYING_RENT comment for the real user correction that
// removed that phase.
test('landing on rent owed to another player: settles immediately, in full, Bank uninvolved, and offers the owner a non-blocking gamble', () => {
  const state = { ...baseGameState(), phase: 'ROLLING' };
  const { gameState, transactions } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(5, 5) }); // total 10 -> Owned Property (Bob's)

  // Settles in the SAME transition as the roll — no RENT_RISK_DECISION, no
  // waiting on anyone.
  assert.equal(gameState.phase, 'POST_ACTIONS');
  const alice = gameState.players.find((p) => p.id === 'gp-alice');
  const bob = gameState.players.find((p) => p.id === 'gp-bob');
  assert.equal(alice.currentBalance, 1500 - 6); // unimproved rent = baseRent — the payer's own fixed x1, never touched again
  assert.equal(bob.currentBalance, 1500 + 6);
  assert.ok(transactions.some((t) => t.transactionType === 'rent' && t.fromGamePlayerId === 'gp-alice' && t.toGamePlayerId === 'gp-bob'));

  // The owner's optional follow-up: gamble the $6 they just collected
  // against the Bank, not against Alice.
  assert.deepEqual(gameState.pendingRentGamble, { propertyId: 'p10', ownerId: 'gp-bob', payerId: 'gp-alice', amount: 6 });
});

test('rolling doubles loops the same player back to ROLLING via END_TURN', () => {
  let state = { ...baseGameState(), phase: 'ROLLING' };
  // double, lands on position 2 (transport, unowned) -> AWAITING_PURCHASE;
  // also sets gameState.lastRollWasDouble = true (P07-T02), which is what
  // END_TURN actually reads now — no payload needed on the END_TURN action itself.
  ({ gameState: state } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 1) }));
  assert.equal(state.lastRollWasDouble, true);

  // BUY_PROPERTY here (not DECLINE_PURCHASE) deliberately — this test is
  // about the doubles loop, not about Auction V1's decline/fee behavior;
  // buying sidesteps that entirely while still reaching POST_ACTIONS.
  ({ gameState: state } = transitionTurn(state, board, { type: 'BUY_PROPERTY' }, '2026-08-17T00:00:00.000Z'));
  assert.equal(state.lastRollWasDouble, true); // untouched by BUY_PROPERTY
  const { gameState: afterEndTurn } = transitionTurn(state, board, { type: 'END_TURN' });

  assert.equal(afterEndTurn.phase, 'ROLLING');
  assert.equal(afterEndTurn.currentTurnIndex, 0); // still Alice's turn
  // lastRollWasDouble is left as true here, not reset — the next real
  // ROLL_DICE overwrites it unconditionally before it could matter again,
  // and mid-loop it's still an accurate record of why the loop happened.
  assert.equal(afterEndTurn.lastRollWasDouble, true);
});

test('a non-double END_TURN advances to the next player and resolves their TURN_START', () => {
  let state = { ...baseGameState(), phase: 'ROLLING' };
  // total 6 (2+4, not a double) -> position 6, Electric Co (utility, unowned).
  // Deliberately not a double: END_TURN now reads gameState.lastRollWasDouble
  // (P07-T02) rather than trusting whatever the END_TURN action's own
  // payload claims, so the roll that got here must itself be non-double
  // for this test to actually exercise the "advance" branch.
  ({ gameState: state } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(2, 4) })); // AWAITING_PURCHASE
  // BUY_PROPERTY (not DECLINE_PURCHASE) — sidesteps Auction V1's fee/auction
  // behavior, which is orthogonal to what this test actually covers.
  ({ gameState: state } = transitionTurn(state, board, { type: 'BUY_PROPERTY' }, '2026-08-17T00:00:00.000Z')); // POST_ACTIONS
  const { gameState: afterEndTurn } = transitionTurn(state, board, { type: 'END_TURN' });

  assert.equal(afterEndTurn.currentTurnIndex, 1); // Bob's turn now
  assert.equal(afterEndTurn.phase, 'ROLLING'); // Bob is not in jail
  assert.equal(afterEndTurn.lastRollWasDouble, null); // reset fresh for Bob's turn
});

test('END_TURN skips a bankrupt player and advances to the one after', () => {
  const threePlayers = baseGameState();
  threePlayers.players.push(
    createPlayerGameState({ id: 'gp-carol', gameId: 'g1', playerId: 'carol', turnOrder: 2, currentBalance: 1500 })
  );
  threePlayers.players[2] = { ...threePlayers.players[2], bankrupt: true }; // Bob (index 2 in the array: bank, alice, bob) is bankrupt

  let state = { ...threePlayers, phase: 'ROLLING' };
  ({ gameState: state } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(2, 4) })); // total 6, non-double
  // BUY_PROPERTY (not DECLINE_PURCHASE) — same reasoning as the test above.
  ({ gameState: state } = transitionTurn(state, board, { type: 'BUY_PROPERTY' }, '2026-08-17T00:00:00.000Z'));
  const { gameState: afterEndTurn } = transitionTurn(state, board, { type: 'END_TURN' });

  assert.equal(afterEndTurn.currentTurnIndex, 2); // Bob (turnOrder 1) skipped, Carol (turnOrder 2) is next
});

// ---- GAME_DESIGN_SPEC.md §25 missedTurnStreak, wired 2026-08-21 ----

test('END_TURN: a genuine (non-system-default) END_TURN resets the outgoing player\'s missedTurnStreak to 0', () => {
  let state = { ...baseGameState(), phase: 'ROLLING' };
  state.players[1] = { ...state.players[1], missedTurnStreak: 2 }; // Alice already had 2 misses
  ({ gameState: state } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(2, 4) }));
  ({ gameState: state } = transitionTurn(state, board, { type: 'BUY_PROPERTY' }, '2026-08-17T00:00:00.000Z'));
  const { gameState: afterEndTurn } = transitionTurn(state, board, { type: 'END_TURN' }); // no isSystemDefault — a real click

  assert.equal(afterEndTurn.players.find((p) => p.id === 'gp-alice').missedTurnStreak, 0);
});

test('END_TURN: a system-default (POST_ACTIONS timeout) END_TURN increments the outgoing player\'s missedTurnStreak', () => {
  let state = { ...baseGameState(), phase: 'ROLLING' };
  ({ gameState: state } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(2, 4) }));
  ({ gameState: state } = transitionTurn(state, board, { type: 'BUY_PROPERTY' }, '2026-08-17T00:00:00.000Z'));
  const { gameState: afterEndTurn } = transitionTurn(state, board, { type: 'END_TURN', isSystemDefault: true });

  assert.equal(afterEndTurn.players.find((p) => p.id === 'gp-alice').missedTurnStreak, 1);
});

test('END_TURN: consecutive system-default end-turns accumulate the streak across real turns', () => {
  const threePlayers = baseGameState();
  threePlayers.players.push(
    createPlayerGameState({ id: 'gp-carol', gameId: 'g1', playerId: 'carol', turnOrder: 2, currentBalance: 1500 })
  );

  let state = { ...threePlayers, phase: 'POST_ACTIONS' }; // Alice already past ROLLING/BUY for this turn
  ({ gameState: state } = transitionTurn(state, board, { type: 'END_TURN', isSystemDefault: true })); // Alice's 1st miss, now Bob's turn
  assert.equal(state.players.find((p) => p.id === 'gp-alice').missedTurnStreak, 1);

  state = { ...state, phase: 'POST_ACTIONS' };
  ({ gameState: state } = transitionTurn(state, board, { type: 'END_TURN', isSystemDefault: true })); // Bob's 1st miss, now Carol's turn
  assert.equal(state.players.find((p) => p.id === 'gp-bob').missedTurnStreak, 1);

  state = { ...state, phase: 'POST_ACTIONS' };
  ({ gameState: state } = transitionTurn(state, board, { type: 'END_TURN', isSystemDefault: true })); // Carol's 1st miss, back to Alice
  state = { ...state, phase: 'POST_ACTIONS' };
  const { gameState: final } = transitionTurn(state, board, { type: 'END_TURN', isSystemDefault: true }); // Alice's 2nd consecutive miss

  assert.equal(final.players.find((p) => p.id === 'gp-alice').missedTurnStreak, 2);
});

test('a 3rd-consecutive-double roll sends the player straight to jail, no movement, and advances the turn (no bonus roll)', () => {
  const state = { ...baseGameState(), phase: 'ROLLING' };
  const jailRoll = { die1: 4, die2: 4, total: 8, isDouble: true, doublesStreak: 0, sentToJail: true };
  const { gameState, transactions } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: jailRoll });

  const alice = gameState.players.find((p) => p.id === 'gp-alice');
  assert.equal(alice.inJail, true);
  assert.equal(alice.currentPosition, 4); // the Jail tile's position, not moved by the roll total
  // Despite isDouble:true on the triggering roll, this must NOT loop back
  // to Alice — going to jail is the penalty for the 3rd double, not a
  // reward. Turn advances straight to Bob.
  assert.equal(gameState.currentTurnIndex, 1);
  assert.equal(gameState.phase, 'ROLLING');
  assert.equal(transactions.length, 0);
  // The 2026-08-21 "documented, not fixed" gap this used to assert (the dice
  // that sent Alice to jail were never visible, because advanceTurn()
  // cascaded into Bob's startTurn() and reset lastRoll) is CLOSED as of
  // 2026-08-25 — startTurn() no longer clears lastRoll, and this branch now
  // records the roll explicitly, so the whole table sees the double that
  // did it.
  assert.deepEqual(gameState.lastRoll, { die1: 4, die2: 4, total: 8, isDouble: true });
  assert.equal(gameState.lastRollSeq, 1);
});

test('JAIL_DECISION: PAY_JAIL_FINE releases and charges the Bank the fine, then ROLLING', () => {
  const state = baseGameState();
  state.players[1] = { ...state.players[1], inJail: true, jailTurns: 1 };
  const { gameState, transactions } = transitionTurn({ ...state, phase: 'JAIL_DECISION' }, board, { type: 'PAY_JAIL_FINE' });

  const alice = gameState.players.find((p) => p.id === 'gp-alice');
  assert.equal(alice.inJail, false);
  assert.equal(alice.currentBalance, 1500 - 50);
  assert.equal(gameState.phase, 'ROLLING');
  assert.ok(transactions.some((t) => t.transactionType === 'jail_fine'));
});

test('JAIL_DECISION: USE_JAIL_CARD releases with no money moved, then ROLLING, and consumes exactly one held card', () => {
  const state = baseGameState();
  state.players[1] = { ...state.players[1], inJail: true, jailFreeCards: 2 };
  const { gameState, transactions } = transitionTurn({ ...state, phase: 'JAIL_DECISION' }, board, { type: 'USE_JAIL_CARD' });

  const alice = gameState.players.find((p) => p.id === 'gp-alice');
  assert.equal(alice.inJail, false);
  assert.equal(alice.jailFreeCards, 1); // consumed exactly one, not all of them
  assert.equal(gameState.phase, 'ROLLING');
  assert.equal(transactions.length, 0);
});

test('JAIL_DECISION: USE_JAIL_CARD is rejected (NO_JAIL_CARD) when the player holds none — 2026-08-22 fix, closes a real pre-existing gap where this always succeeded regardless', () => {
  const state = baseGameState();
  state.players[1] = { ...state.players[1], inJail: true, jailFreeCards: 0 };
  assert.throws(
    () => transitionTurn({ ...state, phase: 'JAIL_DECISION' }, board, { type: 'USE_JAIL_CARD' }),
    (err) => err.name === 'InvalidJailActionError' && err.reason === 'NO_JAIL_CARD'
  );
});

test('JAIL_DECISION: ATTEMPT_JAIL_ROLL with doubles releases and moves on that same roll', () => {
  const state = baseGameState();
  // position 5 + a doubles total of 4 -> position 9 (free_parking, a
  // no-side-effect landing — freeParkingJackpot defaults to 0). Was
  // position 4 (-> 8, go_to_jail) until the 2026-08-22 go_to_jail fix below
  // made that combination land the escaping player straight back in jail —
  // a real, correct consequence (see the dedicated test for it below), but
  // not what *this* test means to exercise, so the fixture moved instead of
  // loosening the assertion.
  state.players[1] = { ...state.players[1], inJail: true, currentPosition: 5 };
  const { gameState } = transitionTurn({ ...state, phase: 'JAIL_DECISION' }, board, {
    type: 'ATTEMPT_JAIL_ROLL',
    payload: roll(2, 2), // doubles, total 4
  });

  const alice = gameState.players.find((p) => p.id === 'gp-alice');
  assert.equal(alice.inJail, false);
  assert.equal(alice.currentPosition, 9); // moved 5 + 4 = 9 (free_parking), landing resolved (POST_ACTIONS, no purchase/rent there)
  assert.equal(gameState.phase, 'POST_ACTIONS');
  // Classic rule: escaping jail via doubles never earns the usual
  // roll-doubles-again bonus turn, even though the escape roll IS a double.
  assert.equal(gameState.lastRollWasDouble, false);
  assert.equal(gameState.currentDoublesStreak, 0);
});

test('JAIL_DECISION: doubles-escape roll does not grant a bonus turn — END_TURN advances to the next player', () => {
  const state = baseGameState();
  state.players[1] = { ...state.players[1], inJail: true, currentPosition: 5 }; // see the previous test's own comment for why 5, not 4
  let after;
  ({ gameState: after } = transitionTurn({ ...state, phase: 'JAIL_DECISION' }, board, {
    type: 'ATTEMPT_JAIL_ROLL',
    payload: roll(2, 2), // doubles, total 4 -> lands on free_parking (position 9), POST_ACTIONS
  }));
  assert.equal(after.phase, 'POST_ACTIONS');

  ({ gameState: after } = transitionTurn(after, board, { type: 'END_TURN' }));

  // If the bonus-turn rule were not enforced, this would loop back to
  // Alice at ROLLING instead of advancing to Bob.
  assert.equal(after.currentTurnIndex, 1); // Bob's turn now
  assert.equal(after.phase, 'ROLLING');
});

test('JAIL_DECISION: a doubles-escape roll that lands exactly on Go To Jail sends the player right back — a real, correct consequence, not a bug', () => {
  const state = baseGameState();
  state.players[1] = { ...state.players[1], inJail: true, currentPosition: 4 };
  const { gameState } = transitionTurn({ ...state, phase: 'JAIL_DECISION' }, board, {
    type: 'ATTEMPT_JAIL_ROLL',
    payload: roll(2, 2), // doubles, total 4 -> position 8 (go_to_jail)
  });

  // advanceTurn() cascades straight into Bob's own startTurn() within this
  // same call (same "no lingering POST_ACTIONS window" treatment the
  // 3-consecutive-double trigger already gets) — Alice never surfaces at
  // POST_ACTIONS at all here, unlike the (deliberately different-fixture)
  // tests above.
  const alice = gameState.players.find((p) => p.id === 'gp-alice');
  assert.equal(alice.inJail, true);
  assert.equal(alice.currentPosition, 4); // the real Jail tile's own position on this fixture board, not 8
  assert.equal(alice.jailTurns, 0);
  assert.equal(gameState.currentTurnIndex, 1); // Bob's turn already — no bonus turn, no POST_ACTIONS stop for Alice
});

// REWRITTEN 2026-09-01 (jail economic-actions revision). A failed escape used
// to end the turn outright; it now continues into POST_ACTIONS with the
// player still jailed, so they can build/sell/mortgage like anyone else.
// Movement remains impossible — startTurn() still routes them back to
// JAIL_DECISION next turn while inJail holds, which the second half asserts.
test('JAIL_DECISION: a failed escape keeps the player in jail but hands them a normal POST_ACTIONS window', () => {
  const state = baseGameState();
  state.players[1] = { ...state.players[1], inJail: true, jailTurns: 0 };
  const { gameState, transactions } = transitionTurn({ ...state, phase: 'JAIL_DECISION' }, board, {
    type: 'ATTEMPT_JAIL_ROLL',
    payload: roll(2, 5), // not doubles
  });

  const alice = gameState.players.find((p) => p.id === 'gp-alice');
  assert.equal(alice.inJail, true);
  assert.equal(alice.jailTurns, 1);
  assert.equal(alice.currentPosition, 0, 'still cannot move');
  assert.equal(gameState.phase, 'POST_ACTIONS');
  assert.equal(gameState.currentTurnIndex, 0, 'the turn has NOT passed — the jailed player still owns it');
  assert.equal(transactions.length, 0);

  // The economy really is open to them now: a real BUILD_HOUSE while jailed.
  const withProperty = {
    ...gameState,
    properties: gameState.properties.map((p) => (p.id === 'p1' ? { ...p, ownerId: 'gp-alice' } : p)),
  };
  const { gameState: built } = transitionTurn(withProperty, board, { type: 'BUILD_HOUSE', payload: { propertyId: 'p1' } });
  assert.equal(built.properties.find((p) => p.id === 'p1').upgradeLevel, 1);
  assert.equal(built.players.find((p) => p.id === 'gp-alice').inJail, true, 'building does not release anyone');

  // Ending the turn passes play on, and the next turn routes back to jail.
  const { gameState: ended } = transitionTurn(built, board, { type: 'END_TURN' });
  assert.equal(ended.currentTurnIndex, 1);
});

test('a jailed player is routed back to JAIL_DECISION on their next turn, never to ROLLING', () => {
  const state = baseGameState();
  state.players[1] = { ...state.players[1], inJail: true, jailTurns: 1 };
  const { gameState } = transitionTurn({ ...state, phase: 'TURN_START' }, board, { type: 'START_TURN' });
  assert.equal(gameState.phase, 'JAIL_DECISION');
});

test('JAIL_DECISION: the forced 3rd failure pays the fine AND moves by the roll that just failed', () => {
  // REVISED 2026-09-01: this used to release the player and end the turn
  // without moving. The classic rule is "pay, then move the number you just
  // rolled" — and the failed roll is by definition not a double, so this exit
  // can never award a bonus turn.
  const state = baseGameState();
  state.players[1] = { ...state.players[1], inJail: true, jailTurns: 2, currentPosition: 4 }; // on the Jail tile
  const { gameState, transactions } = transitionTurn({ ...state, phase: 'JAIL_DECISION' }, board, {
    type: 'ATTEMPT_JAIL_ROLL',
    payload: roll(2, 5), // not doubles, total 7
  });

  const alice = gameState.players.find((p) => p.id === 'gp-alice');
  assert.equal(alice.inJail, false);
  assert.equal(alice.currentBalance, 1500 - 50);
  assert.equal(alice.currentPosition, 11, 'moved 7 from the Jail tile at 4, rather than losing the move');
  assert.equal(gameState.currentTurnIndex, 0, 'they still own the turn — they are mid-move, not skipped');
  assert.equal(gameState.currentDoublesStreak, 0, 'leaving jail never grants a bonus turn');
  assert.ok(transactions.some((t) => t.transactionType === 'jail_fine'));
});

// ---- Finding #28 (docs/PROJECT_STATUS.md), resolved 2026-08-19: jail-fine payments now go through the same solvency check every other debt does ----

test('PAY_JAIL_FINE: cash-short but solvent via liquidation — stops at LIQUIDATION_REQUIRED, stays in jail, no transaction applied yet', () => {
  const state = {
    ...baseGameState(),
    properties: baseGameState().properties.map((p) => (p.id === 'p2' ? { ...p, ownerId: 'gp-alice' } : p)), // transport, mortgageValue 100
    phase: 'JAIL_DECISION',
  };
  state.players[1] = { ...state.players[1], inJail: true, jailTurns: 1, currentBalance: 10 }; // needs 40 more to cover the $50 fine
  const { gameState, transactions } = transitionTurn(state, board, { type: 'PAY_JAIL_FINE' });

  assert.equal(gameState.phase, 'LIQUIDATION_REQUIRED');
  assert.deepEqual(gameState.pendingLiquidation, {
    debtorId: 'gp-alice',
    creditorId: 'gp-bank',
    amount: 50,
    transactionType: 'jail_fine',
    onSettled: 'RELEASE_TO_ROLLING',
  });
  assert.equal(transactions.length, 0);
  const alice = gameState.players.find((p) => p.id === 'gp-alice');
  assert.equal(alice.currentBalance, 10); // untouched
  assert.equal(alice.inJail, true); // NOT released yet — see finding #28's own reasoning
});

test('PAY_JAIL_FINE liquidation, once cleared: released from jail and sent to ROLLING', () => {
  const state = {
    ...baseGameState(),
    properties: baseGameState().properties.map((p) => (p.id === 'p2' ? { ...p, ownerId: 'gp-alice' } : p)),
    phase: 'JAIL_DECISION',
  };
  state.players[1] = { ...state.players[1], inJail: true, jailTurns: 1, currentBalance: 10 };
  const { gameState: afterFine } = transitionTurn(state, board, { type: 'PAY_JAIL_FINE' });
  const { gameState, transactions } = transitionTurn(afterFine, board, { type: 'MORTGAGE', payload: { propertyId: 'p2' } });

  assert.equal(gameState.phase, 'ROLLING');
  assert.equal(gameState.pendingLiquidation, null);
  const alice = gameState.players.find((p) => p.id === 'gp-alice');
  assert.equal(alice.inJail, false);
  assert.equal(alice.jailTurns, 0);
  assert.equal(alice.currentBalance, 10 + 100 - 50); // +mortgageValue, -the fine
  assert.ok(transactions.some((t) => t.transactionType === 'jail_fine' && t.amount === 50));
});

test('PAY_JAIL_FINE: genuinely bankrupt (no liquidatable assets at all) — real bankruptcy, and as the second-to-last active player, the match ends immediately', () => {
  const state = { ...baseGameState(), phase: 'JAIL_DECISION' }; // alice owns nothing in the default fixture
  state.players[1] = { ...state.players[1], inJail: true, jailTurns: 1, currentBalance: 10 };
  const { gameState, transactions } = transitionTurn(state, board, { type: 'PAY_JAIL_FINE' }, '2026-08-19T13:00:00.000Z');

  const alice = gameState.players.find((p) => p.id === 'gp-alice');
  const bob = gameState.players.find((p) => p.id === 'gp-bob');
  assert.equal(alice.bankrupt, true);
  assert.equal(alice.currentBalance, 0);
  assert.ok(transactions.some((t) => t.transactionType === 'bankruptcy_transfer' && t.amount === 10));
  assert.equal(gameState.status, 'finished');
  assert.equal(gameState.endReason, 'elimination');
  assert.equal(bob.finalRank, 1);
});

test('ATTEMPT_JAIL_ROLL forced 3rd attempt: cash-short but solvent via liquidation — stops at LIQUIDATION_REQUIRED, stays in jail (not released by the failed roll)', () => {
  const state = {
    ...baseGameState(),
    properties: baseGameState().properties.map((p) => (p.id === 'p2' ? { ...p, ownerId: 'gp-alice' } : p)),
    phase: 'JAIL_DECISION',
  };
  state.players[1] = { ...state.players[1], inJail: true, jailTurns: 2, currentBalance: 10 }; // this failure is the 3rd
  const { gameState, transactions } = transitionTurn(state, board, { type: 'ATTEMPT_JAIL_ROLL', payload: roll(2, 5) }); // not doubles

  assert.equal(gameState.phase, 'LIQUIDATION_REQUIRED');
  assert.equal(gameState.pendingLiquidation.debtorId, 'gp-alice');
  assert.equal(gameState.pendingLiquidation.creditorId, 'gp-bank');
  assert.equal(gameState.pendingLiquidation.amount, 50);
  assert.equal(gameState.pendingLiquidation.transactionType, 'jail_fine');
  assert.equal(gameState.pendingLiquidation.onSettled, 'RELEASE_AND_MOVE');
  // 2026-09-01: the failed roll rides along so a debtor who has to liquidate
  // first still gets the move a solvent player gets — without it, being poor
  // would silently cost you the exit move as well as the fine.
  assert.deepEqual(gameState.pendingLiquidation.moveRoll, roll(2, 5));
  assert.equal(transactions.length, 0);
  const alice = gameState.players.find((p) => p.id === 'gp-alice');
  assert.equal(alice.inJail, true); // still jailed — rollForExit's own computed release was discarded, not applied
  assert.equal(alice.jailTurns, 2); // untouched too — the "3rd attempt" only actually counts once the fine clears
  assert.equal(gameState.currentTurnIndex, 0); // still Alice's turn
});

test('ATTEMPT_JAIL_ROLL forced-3rd liquidation, once cleared: released AND moved by the failed roll', () => {
  const state = {
    ...baseGameState(),
    properties: baseGameState().properties.map((p) => (p.id === 'p2' ? { ...p, ownerId: 'gp-alice' } : p)),
    phase: 'JAIL_DECISION',
  };
  state.players[1] = { ...state.players[1], inJail: true, jailTurns: 2, currentBalance: 10, currentPosition: 4 };
  const { gameState: afterRoll } = transitionTurn(state, board, { type: 'ATTEMPT_JAIL_ROLL', payload: roll(2, 5) });
  const { gameState, transactions } = transitionTurn(afterRoll, board, { type: 'MORTGAGE', payload: { propertyId: 'p2' } });

  const alice = gameState.players.find((p) => p.id === 'gp-alice');
  assert.equal(alice.inJail, false);
  assert.equal(alice.jailTurns, 0);
  assert.equal(alice.currentBalance, 10 + 100 - 50);
  // The whole point of the 2026-09-01 revision: a deferred settlement must
  // reach the SAME outcome a solvent one does, move included.
  assert.equal(alice.currentPosition, 11, 'moved 7 from the Jail tile at 4');
  assert.equal(gameState.currentDoublesStreak, 0, 'no bonus turn from a jail exit');
  assert.ok(transactions.some((t) => t.transactionType === 'jail_fine' && t.amount === 50));
});

test('ATTEMPT_JAIL_ROLL forced 3rd attempt: genuinely bankrupt — real bankruptcy, match ends immediately', () => {
  const state = { ...baseGameState(), phase: 'JAIL_DECISION' };
  state.players[1] = { ...state.players[1], inJail: true, jailTurns: 2, currentBalance: 10 };
  const { gameState, transactions } = transitionTurn(
    state,
    board,
    { type: 'ATTEMPT_JAIL_ROLL', payload: roll(2, 5) },
    '2026-08-19T13:00:00.000Z'
  );

  const alice = gameState.players.find((p) => p.id === 'gp-alice');
  const bob = gameState.players.find((p) => p.id === 'gp-bob');
  assert.equal(alice.bankrupt, true);
  assert.ok(transactions.some((t) => t.transactionType === 'bankruptcy_transfer' && t.amount === 10));
  assert.equal(gameState.status, 'finished');
  assert.equal(gameState.endReason, 'elimination');
  assert.equal(bob.finalRank, 1);
});

test('DRAWING_CARD: an INSTANT card applies its intents immediately and continues to POST_ACTIONS', () => {
  const state = { ...baseGameState(), phase: 'ROLLING' }; // eventDeck default: DIVIDEND_50 first
  const { gameState, transactions } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 2) }); // total 3 -> Chance tile

  assert.equal(gameState.phase, 'POST_ACTIONS');
  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentBalance, 1500 + 50);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].transactionType, 'event_card');
  assert.equal(transactions[0].amount, 50);
  assert.deepEqual(gameState.eventDeck, ['INVESTMENT_OPPORTUNITY', 'DIVIDEND_50']); // cycled to the bottom
  // 2026-08-21: unlike pendingEventCardId (CHOICE-only), lastDrawnEventCardId
  // is set for an INSTANT draw too — the one place a client can learn which
  // card actually produced this same broadcast's transactions[] entry.
  assert.equal(gameState.lastDrawnEventCardId, 'DIVIDEND_50');
  // Bug fix 2026-08-23: lastDrawnEventCardSeq must increment on a real draw —
  // EventCardModal.jsx's dismiss/replay logic keys off this, not stateVersion
  // (which bumps on every action, causing the notice to reappear forever).
  assert.equal(gameState.lastDrawnEventCardSeq, 1);
});

test('DRAWING_CARD: lastDrawnEventCardSeq survives a pre-fix snapshot that has no such field — must not become NaN', () => {
  // gameRepository.js's loadGameStateFromSupabase() returns snapshot.state's
  // raw JSONB blob and does NOT re-run createGameState(), so a match that was
  // already in progress when this field shipped comes back WITHOUT it. A
  // plain `+ 1` would give NaN, which stays NaN forever — every drawKey on
  // the frontend would then be identical and the card would show once and
  // never again (the original bug, inverted).
  const restored = { ...baseGameState(), phase: 'ROLLING' };
  delete restored.lastDrawnEventCardSeq;
  assert.equal(restored.lastDrawnEventCardSeq, undefined); // the real restored shape

  const { gameState } = transitionTurn(restored, board, { type: 'ROLL_DICE', payload: roll(1, 2) }); // total 3 -> Chance tile
  assert.equal(gameState.lastDrawnEventCardSeq, 1);
  assert.ok(Number.isInteger(gameState.lastDrawnEventCardSeq));
});

test('DRAWING_CARD: lastDrawnEventCardSeq keeps incrementing across separate draws, even of the same card id — the real "new draw" signal stateVersion cannot provide', () => {
  const state = {
    ...baseGameState({ eventDeck: ['DIVIDEND_50', 'DIVIDEND_50', 'INVESTMENT_OPPORTUNITY'] }),
    phase: 'ROLLING',
  };
  const first = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 2) }); // total 3 -> Chance tile
  assert.equal(first.gameState.lastDrawnEventCardId, 'DIVIDEND_50');
  assert.equal(first.gameState.lastDrawnEventCardSeq, 1);

  const afterEndTurn = transitionTurn(first.gameState, board, { type: 'END_TURN' });
  const bobRolling = { ...afterEndTurn.gameState, phase: 'ROLLING' };
  const second = transitionTurn(bobRolling, board, { type: 'ROLL_DICE', payload: roll(1, 2) }); // total 3 -> Chance tile again, same card id redrawn
  assert.equal(second.gameState.lastDrawnEventCardId, 'DIVIDEND_50'); // same card id as the first draw
  assert.equal(second.gameState.lastDrawnEventCardSeq, 2); // but a distinct, later draw — seq still advances
});

test('DRAWING_CARD: an INSTANT card with a MOVE_TO_JAIL intent sends the drawing player to the real Jail tile', () => {
  const state = {
    ...baseGameState({ eventDeck: ['CHAY_QUA_TOC_DO', 'DIVIDEND_50', 'INVESTMENT_OPPORTUNITY'] }),
    phase: 'ROLLING',
  };
  const { gameState } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 2) }); // total 3 -> Chance tile

  const alice = gameState.players.find((p) => p.id === 'gp-alice');
  assert.equal(alice.inJail, true);
  assert.equal(alice.currentPosition, 4); // the real Jail tile's own position on this fixture board
  assert.equal(alice.jailTurns, 0);
  // Landing+drawing still resolves to the normal POST_ACTIONS window (same
  // as every other event-card outcome, ADD_MONEY/REMOVE_MONEY included) —
  // jail is enforced at the *start* of the drawing player's own next turn
  // (startTurn()'s own jail check), not by ending this turn early. Unlike
  // landing directly ON the Go To Jail tile via real movement
  // (moveAndResolve's own short-circuit, a separate fix this same session),
  // a card is a secondary effect layered onto an already-resolved landing,
  // not the sole outcome of the roll that produced it.
  assert.equal(gameState.phase, 'POST_ACTIONS');
});

// Rewritten 2026-09-01: VE_SO_TRUNG_AN_UI became a `keepable` card with the
// Card Inventory system (2026-08-27), so drawing it no longer fires its
// intent — it goes into the hand and fires on USE_INVENTORY_CARD instead.
// The test drives that real two-step flow rather than being loosened: it
// still proves the GRANT_JAIL_CARD intent grants exactly one card, and now
// additionally pins where the card waits in between.
test('DRAWING_CARD: a keepable card goes to the hand on draw, and its GRANT_JAIL_CARD intent fires only on USE_INVENTORY_CARD', () => {
  const state = {
    ...baseGameState({ eventDeck: ['VE_SO_TRUNG_AN_UI', 'DIVIDEND_50', 'INVESTMENT_OPPORTUNITY'] }),
    phase: 'ROLLING',
  };
  const { gameState: afterDraw } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 2) }); // total 3 -> Chance tile

  const drawn = afterDraw.players.find((p) => p.id === 'gp-alice');
  assert.deepEqual(drawn.inventory, ['VE_SO_TRUNG_AN_UI']);
  assert.equal(drawn.jailFreeCards, 0, 'a kept card must not fire its intent at draw time');
  assert.equal(afterDraw.phase, 'POST_ACTIONS');
  assert.equal(afterDraw.lastDrawnEventCardId, 'VE_SO_TRUNG_AN_UI', 'the draw is still revealed to the table');

  const { gameState: afterUse } = transitionTurn(afterDraw, board, {
    type: 'USE_INVENTORY_CARD',
    payload: { playerId: 'gp-alice', cardId: 'VE_SO_TRUNG_AN_UI' },
  });
  const used = afterUse.players.find((p) => p.id === 'gp-alice');
  assert.equal(used.jailFreeCards, 1);
  assert.deepEqual(used.inventory, [], 'the card leaves the hand once played');
});

// 24-card "Cơ Hội/Khí Vận" deck, 2026-08-22, phase 1+2 — the new
// *_EACH_PLAYER/*_RICHEST/*_POOREST/*_IF_BALANCE_AT_LEAST/*_PER_DEVELOPMENT
// intents and the `eligibility` gate, each exercised through the real
// DRAWING_CARD path (not applyIntents directly — it's unexported, same
// discipline the MOVE_TO_JAIL/GRANT_JAIL_CARD tests above already used).

test('DRAWING_CARD: ADD_MONEY_EACH_PLAYER (K03) pays every real player, Bank excluded', () => {
  const state = {
    ...baseGameState({ eventDeck: ['K03_NGAY_HOI_THANH_PHO', 'DIVIDEND_50', 'INVESTMENT_OPPORTUNITY'] }),
    phase: 'ROLLING',
  };
  const { gameState, transactions } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 2) });

  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentBalance, 1500 + 50);
  assert.equal(gameState.players.find((p) => p.id === 'gp-bob').currentBalance, 1500 + 50);
  assert.equal(gameState.players.find((p) => p.id === 'gp-bank').currentBalance, 20000 - 100); // paid both, no third recipient
  assert.equal(transactions.length, 2);
});

test('DRAWING_CARD: REMOVE_MONEY_EACH_PLAYER (K04) charges every real player', () => {
  const state = {
    ...baseGameState({ eventDeck: ['K04_PHI_DICH_VU_CONG', 'DIVIDEND_50', 'INVESTMENT_OPPORTUNITY'] }),
    phase: 'ROLLING',
  };
  const { gameState } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 2) });

  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentBalance, 1500 - 25);
  assert.equal(gameState.players.find((p) => p.id === 'gp-bob').currentBalance, 1500 - 25);
});

test('DRAWING_CARD: REMOVE_MONEY_RICHEST (K06) — no tie, only the single richest player pays the full amount', () => {
  const state = {
    ...baseGameState({ eventDeck: ['K06_KIEM_TOAN_TAI_CHINH', 'DIVIDEND_50', 'INVESTMENT_OPPORTUNITY'] }),
    phase: 'ROLLING',
  };
  state.players[2] = { ...state.players[2], currentBalance: 2000 }; // Bob is strictly richer
  const { gameState, transactions } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 2) });

  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentBalance, 1500); // untouched
  assert.equal(gameState.players.find((p) => p.id === 'gp-bob').currentBalance, 2000 - 100); // full amount, not tiedAmount
  assert.equal(transactions.length, 1);
});

test('DRAWING_CARD: REMOVE_MONEY_RICHEST (K06) — tied richest players each pay the reduced tiedAmount, not a split', () => {
  const state = {
    ...baseGameState({ eventDeck: ['K06_KIEM_TOAN_TAI_CHINH', 'DIVIDEND_50', 'INVESTMENT_OPPORTUNITY'] }),
    phase: 'ROLLING',
  }; // Alice and Bob both start at 1500 — a real tie, not contrived
  const { gameState, transactions } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 2) });

  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentBalance, 1500 - 50);
  assert.equal(gameState.players.find((p) => p.id === 'gp-bob').currentBalance, 1500 - 50);
  assert.equal(transactions.length, 2);
});

test('DRAWING_CARD: ADD_MONEY_POOREST (K10) — no tie, only the single poorest player receives the full amount', () => {
  const state = {
    ...baseGameState({ eventDeck: ['K10_QUY_HO_TRO_THANH_PHO', 'DIVIDEND_50', 'INVESTMENT_OPPORTUNITY'] }),
    phase: 'ROLLING',
  };
  state.players[2] = { ...state.players[2], currentBalance: 2000 }; // Bob strictly richer -> Alice is strictly poorest
  const { gameState } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 2) });

  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentBalance, 1500 + 100); // full amount
  assert.equal(gameState.players.find((p) => p.id === 'gp-bob').currentBalance, 2000); // untouched
});

test('DRAWING_CARD: ADD_MONEY_POOREST (K10) — tied poorest players each receive the reduced tiedAmount', () => {
  const state = {
    ...baseGameState({ eventDeck: ['K10_QUY_HO_TRO_THANH_PHO', 'DIVIDEND_50', 'INVESTMENT_OPPORTUNITY'] }),
    phase: 'ROLLING',
  };
  const { gameState } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 2) });

  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentBalance, 1500 + 75);
  assert.equal(gameState.players.find((p) => p.id === 'gp-bob').currentBalance, 1500 + 75);
});

test('DRAWING_CARD: REMOVE_MONEY_IF_BALANCE_AT_LEAST (K12) only charges players at or above the threshold', () => {
  const state = {
    ...baseGameState({ eventDeck: ['K12_NGAY_THUE', 'DIVIDEND_50', 'INVESTMENT_OPPORTUNITY'] }),
    phase: 'ROLLING',
  };
  state.players[2] = { ...state.players[2], currentBalance: 1000 }; // Bob exactly meets the $1000 threshold
  const { gameState, transactions } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 2) });

  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentBalance, 1500 - 100); // 1500 >= 1000
  assert.equal(gameState.players.find((p) => p.id === 'gp-bob').currentBalance, 1000 - 100); // exactly at the threshold, still charged
  assert.equal(transactions.length, 2);
});

test('DRAWING_CARD: REMOVE_MONEY_PER_DEVELOPMENT (K09) charges each player by their own real development level, skipping a player who owns nothing', () => {
  const state = {
    ...baseGameState({ eventDeck: ['K09_BAO_TRI_DO_THI', 'DIVIDEND_50', 'INVESTMENT_OPPORTUNITY'] }),
    phase: 'ROLLING',
  };
  // p10 (Bob's, from baseGameState's own fixture) gets 2 houses built —
  // Alice owns nothing this whole fixture, so she should pay exactly $0
  // and produce no transaction at all, not a real $0 one.
  state.properties = state.properties.map((p) => (p.id === 'p10' ? { ...p, upgradeLevel: 2 } : p));
  const { gameState, transactions } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 2) });

  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentBalance, 1500); // owns nothing, untouched
  assert.equal(gameState.players.find((p) => p.id === 'gp-bob').currentBalance, 1500 - 2 * 25); // 2 levels x $25
  assert.equal(transactions.length, 1);
});

test('DRAWING_CARD: an eligibility-gated card (C08) applies its effect when the drawing player qualifies', () => {
  const state = {
    ...baseGameState({ eventDeck: ['C08_CUU_HO_TAI_CHINH', 'DIVIDEND_50', 'INVESTMENT_OPPORTUNITY'] }),
    phase: 'ROLLING',
  };
  state.players[1] = { ...state.players[1], currentBalance: 200 }; // Alice, well below the $300 gate
  const { gameState, transactions } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 2) });

  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentBalance, 200 + 100);
  assert.equal(gameState.phase, 'POST_ACTIONS');
  assert.equal(transactions.length, 1);
});

test('DRAWING_CARD: an eligibility-gated card (C08) is a real, revealed no-op when the drawing player does not qualify', () => {
  const state = {
    ...baseGameState({ eventDeck: ['C08_CUU_HO_TAI_CHINH', 'DIVIDEND_50', 'INVESTMENT_OPPORTUNITY'] }),
    phase: 'ROLLING',
  }; // Alice starts at 1500, well above the $300 gate — ineligible
  const { gameState, transactions } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 2) });

  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentBalance, 1500); // untouched
  assert.equal(gameState.phase, 'POST_ACTIONS'); // still resolves normally, not stuck
  assert.equal(transactions.length, 0);
  // Still fully revealed — the reveal-to-everyone UI (EventCardModal.jsx)
  // keys off exactly this field, regardless of whether the card actually
  // did anything.
  assert.equal(gameState.lastDrawnEventCardId, 'C08_CUU_HO_TAI_CHINH');
});

// Phase 3 of the 24-card deck, 2026-08-22 — the "temporary buff" pair of
// mechanisms. Mechanics tested directly via GameState/PlayerGameState
// overrides (not always via a real card draw — applyIntents' own new
// branches are exercised once each via DRAWING_CARD tests further below;
// these focus on the *consumption* side: how the modifier/discount fields
// actually change PAYING_RENT/BUILD_HOUSE's real charged amount, and when
// they clear).

// Rewritten 2026-08-25 (rent settles immediately now, no RENT_RISK_DECISION
// — see turnMachine.js's own resolveLanding PAYING_RENT comment) — reads
// the real charged amount off the payer's own balance and the resulting
// pendingRentGamble.amount instead of a pending choice's standardAmount.
test('PAYING_RENT: a global rentModifierPercent (K01-style) increases the actual charged rent by that percent', () => {
  const state = { ...baseGameState({ rentModifierPercent: 10 }), phase: 'ROLLING' };
  const { gameState } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(5, 5) }); // total 10 -> Bob's Owned Property, base rent 6

  assert.equal(gameState.phase, 'POST_ACTIONS');
  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentBalance, 1500 - 7); // round(6 * 1.10) = round(6.6) = 7
  assert.equal(gameState.pendingRentGamble.amount, 7);
});

test('PAYING_RENT: a global rentModifierPercent (K02-style, negative) decreases the actual charged rent by that percent', () => {
  const state = { ...baseGameState({ rentModifierPercent: -10 }), phase: 'ROLLING' };
  const { gameState } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(5, 5) });

  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentBalance, 1500 - 5); // round(6 * 0.90) = round(5.4) = 5
  assert.equal(gameState.pendingRentGamble.amount, 5);
});

test('PAYING_RENT: the payer\'s own nextRentDiscount (C12-C) reduces the actual charged rent, capped at `max`, and is consumed by this one payment', () => {
  const state = { ...baseGameState(), phase: 'ROLLING' };
  state.players[1] = { ...state.players[1], nextRentDiscount: { percent: 50, max: 150 } }; // Alice is the payer here
  const { gameState } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(5, 5) });

  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentBalance, 1500 - 3); // 6 - round(6 * 0.50) = 6 - 3
  assert.equal(gameState.pendingRentGamble.amount, 3);
  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').nextRentDiscount, null); // spent, not left pending for a future payment
});

test('advanceTurn: round-scoped modifiers (rentModifierPercent/buildCostModifierAmount) reset exactly on a real round wraparound, not per-turn', () => {
  const state = {
    ...baseGameState({ rentModifierPercent: 10, buildCostModifierAmount: 50, phase: 'POST_ACTIONS' }),
  };
  // Alice (turnOrder 0) ends her turn -> Bob (turnOrder 1), not yet a full
  // wraparound (Alice started this round already) — modifiers must survive.
  const { gameState: afterAlice } = transitionTurn(state, board, { type: 'END_TURN' });
  assert.equal(afterAlice.currentTurnIndex, 1);
  assert.equal(afterAlice.rentModifierPercent, 10);
  assert.equal(afterAlice.buildCostModifierAmount, 50);

  // Bob ends his turn -> wraps back to Alice (turnOrder 0 <= 1) — a real
  // round boundary, both modifiers must clear.
  const { gameState: afterBob } = transitionTurn({ ...afterAlice, phase: 'POST_ACTIONS' }, board, { type: 'END_TURN' });
  assert.equal(afterBob.currentTurnIndex, 0);
  assert.equal(afterBob.rentModifierPercent, 0);
  assert.equal(afterBob.buildCostModifierAmount, 0);
});

test('BUILD_HOUSE: a global buildCostModifierAmount (K07-style) and the player\'s own nextBuildDiscount (C07-style) both stack onto the real charged amount, and the discount is consumed by this one build', () => {
  const state = {
    ...baseGameState({ buildCostModifierAmount: 50 }),
    properties: baseGameState().properties.map((p) => (p.id === 'p1' ? { ...p, ownerId: 'gp-alice' } : p)), // Brown Ave 1, houseCost 50
    phase: 'POST_ACTIONS',
  };
  state.players[1] = { ...state.players[1], nextBuildDiscount: 20 };
  const { gameState, transactions } = transitionTurn(state, board, { type: 'BUILD_HOUSE', payload: { propertyId: 'p1' } });

  // 50 (base houseCost) + 50 (K07-style global) - 20 (C07-style personal) = 80
  assert.equal(transactions[0].amount, 80);
  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentBalance, 1500 - 80);
  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').nextBuildDiscount, 0); // spent
});

// Found by fuzzing 2026-08-25. C07 grants a $50 discount and 5 real streets
// cost exactly $50 to build on; C12's option B grants $100, which also zeroes
// the 9 streets at $100 — 14 of the board's 22 buildable streets. The amount
// was correctly clamped to 0, then handed straight to applyTransaction, which
// rejects non-positive amounts: TypeError, build failed, and (since the throw
// preceded any state change) the discount was never consumed either, so the
// player stayed stuck holding a "reward" that broke building on most tiles.
test('BUILD_HOUSE: a discount that fully covers the cost builds for free instead of throwing, and writes no $0 ledger row', () => {
  const state = {
    ...baseGameState(),
    properties: baseGameState().properties.map((p) => (p.id === 'p1' ? { ...p, ownerId: 'gp-alice' } : p)), // Brown Ave 1, houseCost 50
    phase: 'POST_ACTIONS',
  };
  state.players[1] = { ...state.players[1], nextBuildDiscount: 50 }; // exactly cancels the $50 houseCost

  const { gameState, transactions } = transitionTurn(state, board, { type: 'BUILD_HOUSE', payload: { propertyId: 'p1' } });

  assert.equal(gameState.properties.find((p) => p.id === 'p1').upgradeLevel, 1); // the build really happened
  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentBalance, 1500); // free — nothing charged
  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').nextBuildDiscount, 0); // and the discount was still spent
  assert.equal(transactions.length, 0); // no $0 row — applyTransaction is never handed a non-positive amount
  assert.equal(gameState.houseSupply, 31); // supply accounting is unaffected by the payment being skipped
});

test('BUILD_HOUSE: a discount LARGER than the cost is also free, never a negative charge', () => {
  const state = {
    ...baseGameState(),
    properties: baseGameState().properties.map((p) => (p.id === 'p1' ? { ...p, ownerId: 'gp-alice' } : p)),
    phase: 'POST_ACTIONS',
  };
  state.players[1] = { ...state.players[1], nextBuildDiscount: 100 }; // C12 option B, double the $50 cost

  const { gameState, transactions } = transitionTurn(state, board, { type: 'BUILD_HOUSE', payload: { propertyId: 'p1' } });
  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentBalance, 1500); // not 1550 — the Bank never pays you to build
  assert.equal(transactions.length, 0);
});

test('DRAWING_CARD: K01/K07 cards actually set the real global modifier fields on GameState', () => {
  const state = {
    ...baseGameState({ eventDeck: ['K01_THI_TRUONG_SOI_DONG', 'DIVIDEND_50', 'INVESTMENT_OPPORTUNITY'] }),
    phase: 'ROLLING',
  };
  const { gameState } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 2) });
  assert.equal(gameState.rentModifierPercent, 10);
});

// Rewritten 2026-09-01 for the same reason as the VE_SO test above — C07 is
// `keepable` now, so its discount lands when the card is played, not drawn.
test('DRAWING_CARD: C07 grants its real nextBuildDiscount when played from the hand', () => {
  const state = {
    ...baseGameState({ eventDeck: ['C07_GIAM_GIA_XAY_DUNG', 'DIVIDEND_50', 'INVESTMENT_OPPORTUNITY'] }),
    phase: 'ROLLING',
  };
  const { gameState: afterDraw } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 2) });
  assert.deepEqual(afterDraw.players.find((p) => p.id === 'gp-alice').inventory, ['C07_GIAM_GIA_XAY_DUNG']);
  assert.equal(afterDraw.players.find((p) => p.id === 'gp-alice').nextBuildDiscount, 0);

  const { gameState: afterUse } = transitionTurn(afterDraw, board, {
    type: 'USE_INVENTORY_CARD',
    payload: { playerId: 'gp-alice', cardId: 'C07_GIAM_GIA_XAY_DUNG' },
  });
  assert.equal(afterUse.players.find((p) => p.id === 'gp-alice').nextBuildDiscount, 50);
});

// --- Event-card charges a player cannot afford (2026-08-23) ---
//
// Regression tests for a real, verified bug: applyIntents charged players
// through applyTransaction, which performs NO solvency check — it simply
// subtracts. So an event card costing more than the player held drove the
// balance NEGATIVE and play continued as if nothing happened (measured
// before the fix: $10 balance, -$50 card, ended at -$40, not bankrupt, no
// liquidation). Every other debt in the game routes through settleDebt();
// event cards were the one path that bypassed it. These three tests pin the
// three real outcomes settleDebt can produce, so the bypass can't return.

test('DRAWING_CARD: a card charging more than the player holds triggers real LIQUIDATION_REQUIRED, never a negative balance', () => {
  const state = { ...baseGameState({ eventDeck: ['QUY_TO_DAN_PHO'] }), phase: 'ROLLING' }; // -$50
  // $10 cash, but owns the $200 Station (mortgageValue 100) — 10 + 100 > 50,
  // so this player is cash-short yet genuinely solvent: liquidation, not bankruptcy.
  state.players[1] = { ...state.players[1], currentBalance: 10 };
  state.properties = state.properties.map((p) => (p.id === 'p2' ? { ...p, ownerId: 'gp-alice' } : p));

  const { gameState } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(3, 4) }); // total 7 -> Fortune

  const alice = gameState.players.find((p) => p.id === 'gp-alice');
  assert.equal(gameState.phase, 'LIQUIDATION_REQUIRED');
  assert.equal(alice.bankrupt, false);
  assert.equal(alice.currentBalance, 10); // untouched — nothing is taken until the debt actually settles
  assert.deepEqual(gameState.pendingLiquidation, {
    debtorId: 'gp-alice',
    creditorId: 'gp-bank',
    amount: 50,
    transactionType: 'event_card',
  });
});

test('DRAWING_CARD: a card charging a genuinely insolvent player applies real bankruptcy, not a negative balance', () => {
  const state = { ...baseGameState({ eventDeck: ['QUY_TO_DAN_PHO'] }), phase: 'ROLLING' }; // -$50
  state.players[1] = { ...state.players[1], currentBalance: 10 }; // owns nothing — 10 < 50 with nothing to liquidate
  state.players.push(
    createPlayerGameState({ id: 'gp-carol', gameId: 'g1', playerId: 'carol', turnOrder: 2, currentBalance: 1500 })
  );

  const { gameState } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(3, 4) });

  const alice = gameState.players.find((p) => p.id === 'gp-alice');
  assert.equal(alice.bankrupt, true);
  assert.equal(alice.currentBalance, 0);
  assert.ok(gameState.players.every((p) => p.currentBalance >= 0), 'no player may hold a negative balance');
});

test('DRAWING_CARD: an each-player charge bankrupts the NON-CURRENT player who cannot pay, rather than stranding the turn in a liquidation they cannot act on', () => {
  const state = { ...baseGameState({ eventDeck: ['K04_PHI_DICH_VU_CONG'] }), phase: 'ROLLING' }; // every player -$25
  state.players.push(
    createPlayerGameState({ id: 'gp-carol', gameId: 'g1', playerId: 'carol', turnOrder: 2, currentBalance: 1500 })
  );
  // Bob can't cover $25 in cash. He DOES own p10 (the fixture gives it to
  // him), so on cash-solvency alone he'd be liquidation-eligible — but it's
  // Alice's turn, and LIQUIDATION_REQUIRED resolves through getCurrentPlayer,
  // so Bob could never act on it. Immediate bankruptcy is the deliberate,
  // flagged outcome (settlePendingDebts documents the tradeoff in full).
  state.players[2] = { ...state.players[2], currentBalance: 5 };

  const { gameState } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(3, 4) });

  const bob = gameState.players.find((p) => p.id === 'gp-bob');
  assert.equal(bob.bankrupt, true);
  assert.equal(bob.currentBalance, 0);
  assert.notEqual(gameState.phase, 'LIQUIDATION_REQUIRED'); // never strands the turn on a debtor who can't act
  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentBalance, 1500 - 25); // solvent players paid normally
  assert.equal(gameState.properties.find((p) => p.id === 'p10').ownerId, null); // his land reverted to the Bank, GAME_DESIGN_SPEC §16
  assert.ok(gameState.players.every((p) => p.currentBalance >= 0));
  // Added 2026-08-25 alongside the bankruptcy turn force-advance: eliminating
  // an OUT-OF-TURN player must never disturb the real current player's turn.
  // This is the branch that force-advance is deliberately conditional on.
  assert.equal(gameState.currentTurnIndex, 0); // still Alice's turn
});

// Rewritten 2026-09-01: C12 is now BOTH eligibility-gated and `keepable`, so
// it never reaches AWAITING_EVENT_CHOICE on draw — an eligible draw banks it
// in the hand, and the 3-way choice is made later through USE_INVENTORY_CARD.
// All three options are still exercised for real, plus the eligibility gate
// on both ends (draw time AND play time, which is the genuinely new
// behaviour: a player who climbs back above $200 loses the card's use).
test('C12 is eligibility-gated at draw AND at play, and each of its 3 options resolves for real from the hand', () => {
  const eventDeck = ['C12_CO_HOI_CUOI', 'DIVIDEND_50', 'INVESTMENT_OPPORTUNITY'];

  // Ineligible — Alice at the default 1500, well above the $200 gate.
  const ineligible = { ...baseGameState({ eventDeck }), phase: 'ROLLING' };
  const { gameState: afterIneligible } = transitionTurn(ineligible, board, { type: 'ROLL_DICE', payload: roll(1, 2) });
  assert.equal(afterIneligible.phase, 'POST_ACTIONS'); // no choice, and no card banked either
  assert.equal(afterIneligible.lastDrawnEventCardId, 'C12_CO_HOI_CUOI');
  assert.deepEqual(afterIneligible.players.find((p) => p.id === 'gp-alice').inventory, []);

  function eligibleDraw() {
    const state = { ...baseGameState({ eventDeck }), phase: 'ROLLING' };
    state.players[1] = { ...state.players[1], currentBalance: 100 };
    return transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 2) }).gameState;
  }

  const held = eligibleDraw();
  assert.equal(held.phase, 'POST_ACTIONS');
  assert.deepEqual(held.players.find((p) => p.id === 'gp-alice').inventory, ['C12_CO_HOI_CUOI']);

  const play = (state, optionId) =>
    transitionTurn(state, board, {
      type: 'USE_INVENTORY_CARD',
      payload: { playerId: 'gp-alice', cardId: 'C12_CO_HOI_CUOI', optionId },
    }).gameState;

  assert.equal(play(held, 'OPT_CASH').players.find((p) => p.id === 'gp-alice').currentBalance, 100 + 150);
  assert.equal(play(held, 'OPT_BUILD_DISCOUNT').players.find((p) => p.id === 'gp-alice').nextBuildDiscount, 100);
  assert.deepEqual(play(held, 'OPT_RENT_DISCOUNT').players.find((p) => p.id === 'gp-alice').nextRentDiscount, {
    percent: 50,
    max: 150,
  });

  // Play-time eligibility: the same held card is refused once the holder is
  // no longer poor enough to qualify for it.
  const richNow = {
    ...held,
    players: held.players.map((p) => (p.id === 'gp-alice' ? { ...p, currentBalance: 5000 } : p)),
  };
  assert.throws(
    () => play(richNow, 'OPT_CASH'),
    (err) => err.name === 'InvalidInventoryActionError' && err.reason === 'NOT_ELIGIBLE'
  );
});

test('DRAWING_CARD: a CHOICE card transitions to AWAITING_EVENT_CHOICE and records pendingEventCardId', () => {
  const state = {
    ...baseGameState({ eventDeck: ['INVESTMENT_OPPORTUNITY', 'DIVIDEND_50'] }),
    phase: 'ROLLING',
  };
  const { gameState, transactions } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(3, 4) }); // total 7 -> Fortune tile

  assert.equal(gameState.phase, 'AWAITING_EVENT_CHOICE');
  assert.equal(gameState.pendingEventCardId, 'INVESTMENT_OPPORTUNITY');
  assert.equal(gameState.lastDrawnEventCardId, 'INVESTMENT_OPPORTUNITY'); // 2026-08-21: set alongside pendingEventCardId for the CHOICE case too, same field either way
  assert.equal(transactions.length, 0);
  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentBalance, 1500); // untouched — no choice made yet
  assert.deepEqual(gameState.eventDeck, ['DIVIDEND_50', 'INVESTMENT_OPPORTUNITY']); // cycled to the bottom
});

test('MAKE_EVENT_CHOICE: OPT_SAFE resolves to POST_ACTIONS and pays the guaranteed amount', () => {
  const state = {
    ...baseGameState(),
    phase: 'AWAITING_EVENT_CHOICE',
    pendingEventCardId: 'INVESTMENT_OPPORTUNITY',
  };
  const { gameState, transactions } = transitionTurn(state, board, {
    type: 'MAKE_EVENT_CHOICE',
    payload: { optionId: 'OPT_SAFE' },
  });

  assert.equal(gameState.phase, 'POST_ACTIONS');
  assert.equal(gameState.pendingEventCardId, null);
  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentBalance, 1500 + 200);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].transactionType, 'event_card');
});

// --- The "nobody can afford this card" deadlock (fixed 2026-09-02) ---
//
// C11_CU_DANH_LIEU is eligibility-gated at currentBalance >= 50 on draw and
// its SINGLE option costs $50. Trades / GAMBLE_RENT / USE_INVENTORY_CARD are
// all deliberately phase-independent, so the drawer's cash can fall below $50
// while the card is still pending. Before the fix that was a permanent room
// freeze: MAKE_EVENT_CHOICE was the only legal action in the phase and every
// call threw INSUFFICIENT_BALANCE, and the phase timeout synthesized that
// same doomed choice, so handleTurnTimeout bailed with the timer already
// cleared. The card now fizzles to a no-op instead.
test('MAKE_EVENT_CHOICE: a card whose every option is unaffordable fizzles to POST_ACTIONS instead of deadlocking', () => {
  const base = baseGameState();
  const state = {
    ...base,
    phase: 'AWAITING_EVENT_CHOICE',
    pendingEventCardId: 'C11_CU_DANH_LIEU',
    players: base.players.map((p) => (p.id === 'gp-alice' ? { ...p, currentBalance: 40 } : p)), // below the $50 option
  };
  const { gameState, transactions } = transitionTurn(state, board, {
    type: 'MAKE_EVENT_CHOICE',
    payload: { optionId: 'OPT_GAMBLE', dieFaceRoll: 4 },
  });

  assert.equal(gameState.phase, 'POST_ACTIONS');
  assert.equal(gameState.pendingEventCardId, null);
  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentBalance, 40); // untouched — a no-op, not a free win
  assert.equal(transactions.length, 0);
});

test('MAKE_EVENT_CHOICE: an unaffordable option is still rejected while an affordable one exists', () => {
  // The fizzle above must stay narrow. INVESTMENT_OPPORTUNITY has a free
  // OPT_SAFE alongside a staked OPT_RISK, so picking the stake you cannot
  // cover is real invalid input, not a card nobody can play.
  const base = baseGameState();
  const state = {
    ...base,
    phase: 'AWAITING_EVENT_CHOICE',
    pendingEventCardId: 'INVESTMENT_OPPORTUNITY',
    players: base.players.map((p) => (p.id === 'gp-alice' ? { ...p, currentBalance: 1 } : p)),
  };
  assert.throws(
    () => transitionTurn(state, board, { type: 'MAKE_EVENT_CHOICE', payload: { optionId: 'OPT_RISK', probabilityRoll: 0.1 } }),
    (err) => err.name === 'EventChoiceError' && err.reason === 'INSUFFICIENT_BALANCE'
  );
});

test('MAKE_EVENT_CHOICE: OPT_RISK, probability succeeds — pays the premium after the stake', () => {
  const state = {
    ...baseGameState(),
    phase: 'AWAITING_EVENT_CHOICE',
    pendingEventCardId: 'INVESTMENT_OPPORTUNITY',
  };
  const { gameState, transactions } = transitionTurn(state, board, {
    type: 'MAKE_EVENT_CHOICE',
    payload: { optionId: 'OPT_RISK', probabilityRoll: 0.2 }, // < 0.5 chance -> succeeds
  });

  assert.equal(gameState.phase, 'POST_ACTIONS');
  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentBalance, 1500 - 300 + 900);
  assert.equal(transactions.length, 2);
  assert.deepEqual(
    transactions.map((t) => t.amount),
    [300, 900]
  );
});

test('MAKE_EVENT_CHOICE: OPT_RISK, probability fails — only the stake is deducted', () => {
  const state = {
    ...baseGameState(),
    phase: 'AWAITING_EVENT_CHOICE',
    pendingEventCardId: 'INVESTMENT_OPPORTUNITY',
  };
  const { gameState, transactions } = transitionTurn(state, board, {
    type: 'MAKE_EVENT_CHOICE',
    payload: { optionId: 'OPT_RISK', probabilityRoll: 0.8 }, // >= 0.5 chance -> fails
  });

  assert.equal(gameState.phase, 'POST_ACTIONS');
  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentBalance, 1500 - 300);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].amount, 300);
});

test('MAKE_EVENT_CHOICE: OPT_RISK is rejected when the player cannot cover the stake', () => {
  const state = {
    ...baseGameState({
      players: baseGameState().players.map((p) => (p.id === 'gp-alice' ? { ...p, currentBalance: 100 } : p)),
    }),
    phase: 'AWAITING_EVENT_CHOICE',
    pendingEventCardId: 'INVESTMENT_OPPORTUNITY',
  };

  assert.throws(
    () => transitionTurn(state, board, { type: 'MAKE_EVENT_CHOICE', payload: { optionId: 'OPT_RISK', probabilityRoll: 0.2 } }),
    EventChoiceError
  );
});

test('an action illegal for AWAITING_EVENT_CHOICE throws InvalidTurnActionError', () => {
  const state = { ...baseGameState(), phase: 'AWAITING_EVENT_CHOICE', pendingEventCardId: 'INVESTMENT_OPPORTUNITY' };
  assert.throws(() => transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 1) }), InvalidTurnActionError);
});

test('END_TURN remains illegal during FLASH_AUCTION_ACTIVE, even though PLACE_BID/FOLD_AUCTION now are', () => {
  let state = { ...baseGameState(), phase: 'ROLLING' };
  ({ gameState: state } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 1) })); // Station A
  ({ gameState: state } = transitionTurn(state, board, { type: 'FORCE_AUCTION' })); // FLASH_AUCTION_ACTIVE

  assert.equal(state.phase, 'FLASH_AUCTION_ACTIVE');
  assert.throws(() => transitionTurn(state, board, { type: 'END_TURN' }), InvalidTurnActionError);
});

// Alice opens an auction on Station A (price 200, fee 20).
//
// These three helpers are named for how many players can actually BID, which
// since the V2 Broker rule (2026-09-02) is one FEWER than the number of
// players at the table: handleForceAuction excludes the initiator from
// `eligibleBidders`, because the host earns the 20% broker commission and may
// not bid on their own auction. Alice is always the initiator here, so she is
// never in activeBidders — every helper below adds one more opponent than the
// bidder count in its name would suggest at a glance.
function soloBidderAuctionState() {
  let state = { ...baseGameState(), phase: 'ROLLING' };
  ({ gameState: state } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 1) }));
  ({ gameState: state } = transitionTurn(state, board, { type: 'FORCE_AUCTION' }));
  return state; // FLASH_AUCTION_ACTIVE, activeBidders ['gp-bob'] (alice hosts), alice balance 1480
}

// + Carol, so two players can bid — the smallest table where one bidder can
// fold and the auction still has someone left to resolve to.
function twoBidderAuctionState() {
  const players = baseGameState();
  players.players.push(
    createPlayerGameState({ id: 'gp-carol', gameId: 'g1', playerId: 'carol', turnOrder: 2, currentBalance: 1500 })
  );
  let state = { ...players, phase: 'ROLLING' };
  ({ gameState: state } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 1) }));
  ({ gameState: state } = transitionTurn(state, board, { type: 'FORCE_AUCTION' }));
  return state; // FLASH_AUCTION_ACTIVE, activeBidders ['gp-bob', 'gp-carol']
}

// + Dave, so three players can bid — needed to exercise "a bidder leaves and
// MORE THAN ONE still remains" (fold, and forfeit) separately from "the last
// departure resolves the auction". Before the Broker rule the three-player
// table covered this, because the host counted as a bidder; it no longer does.
function threeBidderAuctionState() {
  const players = baseGameState();
  players.players.push(
    createPlayerGameState({ id: 'gp-carol', gameId: 'g1', playerId: 'carol', turnOrder: 2, currentBalance: 1500 }),
    createPlayerGameState({ id: 'gp-dave', gameId: 'g1', playerId: 'dave', turnOrder: 3, currentBalance: 1500 })
  );
  let state = { ...players, phase: 'ROLLING' };
  ({ gameState: state } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 1) }));
  ({ gameState: state } = transitionTurn(state, board, { type: 'FORCE_AUCTION' }));
  return state; // FLASH_AUCTION_ACTIVE, activeBidders ['gp-bob', 'gp-carol', 'gp-dave']
}


test('PLACE_BID: a valid bid updates the auction, stays in FLASH_AUCTION_ACTIVE, moves no money yet', () => {
  const state = soloBidderAuctionState();
  const { gameState, transactions } = transitionTurn(state, board, {
    type: 'PLACE_BID',
    payload: { playerId: 'gp-bob', amount: 250 },
  });

  assert.equal(gameState.phase, 'FLASH_AUCTION_ACTIVE');
  assert.equal(gameState.pendingAuction.currentBid, 250);
  assert.equal(gameState.pendingAuction.highestBidderId, 'gp-bob');
  assert.deepEqual(gameState.pendingAuction.bids, [{ playerId: 'gp-bob', amount: 250 }]);
  assert.equal(transactions.length, 0);
  assert.equal(gameState.players.find((p) => p.id === 'gp-bob').currentBalance, 1500); // untouched — no locking
});

test('PLACE_BID: a bid at or below the current bid is rejected', () => {
  const state = soloBidderAuctionState(); // currentBid starts at 200 (basePrice)
  assert.throws(
    () => transitionTurn(state, board, { type: 'PLACE_BID', payload: { playerId: 'gp-bob', amount: 200 } }),
    InvalidBidError
  );
});

test('FOLD_AUCTION: folding down to more than one remaining bidder just continues the auction', () => {
  let state = threeBidderAuctionState(); // bob/carol/dave bid; alice hosts
  ({ gameState: state } = transitionTurn(state, board, {
    type: 'PLACE_BID',
    payload: { playerId: 'gp-bob', amount: 250 },
  }));
  const { gameState: afterFold, transactions } = transitionTurn(state, board, {
    type: 'FOLD_AUCTION',
    payload: { playerId: 'gp-carol' },
  });

  assert.equal(afterFold.phase, 'FLASH_AUCTION_ACTIVE'); // 2 active bidders remain — not resolved yet
  assert.deepEqual(afterFold.pendingAuction.activeBidders, ['gp-bob', 'gp-dave']);
  assert.equal(afterFold.pendingAuction.highestBidderId, 'gp-bob'); // Bob's bid still stands
  assert.equal(transactions.length, 0);
});

test('FOLD_AUCTION: folding down to the last active bidder resolves the auction — winner pays and receives the property', () => {
  let state = twoBidderAuctionState(); // bob/carol bid; alice hosts and cannot fold what she isn't in
  ({ gameState: state } = transitionTurn(state, board, {
    type: 'PLACE_BID',
    payload: { playerId: 'gp-bob', amount: 250 },
  }));
  const { gameState: after, transactions } = transitionTurn(state, board, {
    type: 'FOLD_AUCTION',
    payload: { playerId: 'gp-carol' }, // 1 left (Bob) -> resolves
  });

  assert.equal(after.phase, 'POST_ACTIONS');
  assert.equal(after.pendingAuction, null);
  assert.equal(after.players.find((p) => p.id === 'gp-bob').currentBalance, 1500 - 250);
  assert.equal(after.players.find((p) => p.id === 'gp-alice').currentBalance, 1480 + 50); // commission = 250 * 0.2 = 50
  assert.equal(after.properties.find((p) => p.boardTileId === 't2').ownerId, 'gp-bob');
  assert.equal(transactions.length, 2); // 1. winner pays, 2. commission
  assert.deepEqual(
    transactions.map((t) => t.amount),
    [250, 50]
  );
});

test('FOLD_AUCTION: the last bidder folding without anyone ever bidding resolves as FAILED, no transfer', () => {
  const state = soloBidderAuctionState();
  const { gameState: after, transactions } = transitionTurn(state, board, {
    type: 'FOLD_AUCTION',
    payload: { playerId: 'gp-bob' }, // the only bidder folds -> resolves; nobody ever bid
  });

  assert.equal(after.phase, 'POST_ACTIONS');
  assert.equal(after.pendingAuction, null);
  assert.equal(transactions.length, 0);
  assert.equal(after.properties.find((p) => p.boardTileId === 't2').ownerId, null); // stays bank-owned
});

test('AUCTION_TIMEOUT forcibly resolves the auction even with multiple active bidders remaining — winner pays, property transfers, Near-Miss rewarded', () => {
  let state = twoBidderAuctionState();
  ({ gameState: state } = transitionTurn(state, board, { type: 'PLACE_BID', payload: { playerId: 'gp-carol', amount: 220 } })); // carol bid #1
  ({ gameState: state } = transitionTurn(state, board, { type: 'PLACE_BID', payload: { playerId: 'gp-bob', amount: 380 } }));
  ({ gameState: state } = transitionTurn(state, board, { type: 'PLACE_BID', payload: { playerId: 'gp-carol', amount: 390 } })); // carol bid #2, highest 390
  ({ gameState: state } = transitionTurn(state, board, { type: 'PLACE_BID', payload: { playerId: 'gp-bob', amount: 430 } })); // bob's final, winning bid

  assert.deepEqual(state.pendingAuction.activeBidders, ['gp-bob', 'gp-carol']); // both bidders still active — nobody folded (alice hosts)
  // No payload at all — AUCTION_TIMEOUT is system-generated, needs no playerId.
  const { gameState: after, transactions } = transitionTurn(state, board, { type: 'AUCTION_TIMEOUT' });

  // threshold = 430 * 0.9 = 387; carol's highest (390) clears it, 2 bids of her own.
  assert.equal(after.phase, 'POST_ACTIONS');
  assert.equal(after.pendingAuction, null);
  assert.equal(after.players.find((p) => p.id === 'gp-bob').currentBalance, 1500 - 430);
  assert.equal(after.players.find((p) => p.id === 'gp-alice').currentBalance, 1480 + 86); // commission = floor(430*0.2) = 86
  assert.equal(after.players.find((p) => p.id === 'gp-carol').currentBalance, 1500 + 4); // floor((430-200)*0.02) = 4
  assert.equal(after.properties.find((p) => p.boardTileId === 't2').ownerId, 'gp-bob');
  assert.equal(transactions.length, 3); // winner pays, commission, near-miss
  assert.deepEqual(
    transactions.map((t) => t.amount),
    [430, 86, 4]
  );
});

test('AUCTION_TIMEOUT on an auction nobody ever bid on resolves as FAILED, no transfer', () => {
  const state = twoBidderAuctionState(); // no PLACE_BID calls at all
  const { gameState: after, transactions } = transitionTurn(state, board, { type: 'AUCTION_TIMEOUT' });

  assert.equal(after.phase, 'POST_ACTIONS');
  assert.equal(after.pendingAuction, null);
  assert.equal(transactions.length, 0);
  assert.equal(after.properties.find((p) => p.boardTileId === 't2').ownerId, null);
});

test('FOLD_AUCTION-triggered resolution also applies Near-Miss rewards through applyIntents', () => {
  let state = twoBidderAuctionState();
  // Each bid must strictly exceed the current one, so Carol and Bob have to
  // alternate raising for Bob to end up on top with Carol's highest still
  // close behind (not simply "Carol bids twice then Bob bids once above both").
  ({ gameState: state } = transitionTurn(state, board, { type: 'PLACE_BID', payload: { playerId: 'gp-carol', amount: 220 } })); // carol bid #1
  ({ gameState: state } = transitionTurn(state, board, { type: 'PLACE_BID', payload: { playerId: 'gp-bob', amount: 380 } }));
  ({ gameState: state } = transitionTurn(state, board, { type: 'PLACE_BID', payload: { playerId: 'gp-carol', amount: 390 } })); // carol bid #2, highest 390
  ({ gameState: state } = transitionTurn(state, board, { type: 'PLACE_BID', payload: { playerId: 'gp-bob', amount: 430 } })); // bob's final, winning bid
  const { gameState: after, transactions } = transitionTurn(state, board, {
    type: 'FOLD_AUCTION',
    payload: { playerId: 'gp-carol' }, // 1 left (Bob) -> resolves, Bob wins at 430.
    // Carol still collects Near-Miss despite folding: the reward is computed
    // from the `bids` log, not from who is still standing at settlement.
  });

  // threshold = 430 * 0.9 = 387; carol's highest (390) clears it, 2 bids of her own.
  assert.equal(after.phase, 'POST_ACTIONS');
  assert.equal(after.players.find((p) => p.id === 'gp-bob').currentBalance, 1500 - 430);
  assert.equal(after.players.find((p) => p.id === 'gp-alice').currentBalance, 1480 + 86); // commission = 86
  assert.equal(after.players.find((p) => p.id === 'gp-carol').currentBalance, 1500 + 4); // floor((430-200)*0.02) = 4
  assert.equal(after.properties.find((p) => p.boardTileId === 't2').ownerId, 'gp-bob');
  assert.equal(transactions.length, 3);
  assert.deepEqual(
    transactions.map((t) => t.amount),
    [430, 86, 4]
  );
});

test('lastRollWasDouble is null at the start of a genuinely fresh turn', () => {
  const { gameState } = transitionTurn(baseGameState(), board, { type: 'START_TURN' });
  assert.equal(gameState.lastRollWasDouble, null);
});

test('regression: a game left in the post-jail-failure state is not stuck — it genuinely advanced and can keep going', () => {
  // Before P07-T02's advanceTurn fix, every jail-ending-the-turn path set
  // phase: 'END_TURN' as a resting state with no action defined to leave
  // it — any further transitionTurn call would throw InvalidTurnActionError
  // forever. This proves that's fixed: the game lands on Bob's real,
  // actionable ROLLING phase and a further action succeeds normally.
  // Updated 2026-09-01: a failed escape now rests in POST_ACTIONS (the jailed
  // player's own economic window) instead of advancing immediately, so the
  // "is it stuck?" question is asked one step later — END_TURN must still
  // hand play on cleanly, and the next player must get a real actionable
  // phase.
  const state = baseGameState();
  state.players[1] = { ...state.players[1], inJail: true, jailTurns: 0 };
  const { gameState: afterJailFail } = transitionTurn({ ...state, phase: 'JAIL_DECISION' }, board, {
    type: 'ATTEMPT_JAIL_ROLL',
    payload: roll(2, 5), // fails, not forced
  });

  assert.equal(afterJailFail.phase, 'POST_ACTIONS');
  assert.equal(afterJailFail.currentTurnIndex, 0);

  const { gameState: afterEnd } = transitionTurn(afterJailFail, board, { type: 'END_TURN' });
  assert.equal(afterEnd.currentTurnIndex, 1);
  assert.equal(afterEnd.phase, 'ROLLING');

  // Bob's turn genuinely continues — no InvalidTurnActionError, no dead end.
  const { gameState: afterBobRolls } = transitionTurn(afterEnd, board, {
    type: 'ROLL_DICE',
    payload: roll(2, 4), // total 6, lands on Electric Co (unowned utility)
  });
  assert.equal(afterBobRolls.phase, 'AWAITING_PURCHASE');
});

test('currentDoublesStreak carries the rolled doublesStreak forward, and resets on jail entry / new turn', () => {
  const doubleRoll = roll(1, 1); // doublesStreak param defaults to 0 -> returns doublesStreak: 1
  const { gameState: afterDouble } = transitionTurn(
    { ...baseGameState(), phase: 'ROLLING' },
    board,
    { type: 'ROLL_DICE', payload: doubleRoll }
  );
  assert.equal(afterDouble.currentDoublesStreak, 1);

  const { gameState: afterJail } = transitionTurn(
    { ...baseGameState(), phase: 'ROLLING' },
    board,
    { type: 'ROLL_DICE', payload: { die1: 4, die2: 4, total: 8, isDouble: true, doublesStreak: 0, sentToJail: true } }
  );
  assert.equal(afterJail.currentDoublesStreak, 0);

  const { gameState: freshTurn } = transitionTurn(baseGameState(), board, { type: 'START_TURN' });
  assert.equal(freshTurn.currentDoublesStreak, 0);
});

// --- BUILD_HOUSE ---

test('BUILD_HOUSE outside POST_ACTIONS throws InvalidTurnActionError', () => {
  const state = { ...baseGameState(), phase: 'ROLLING' };
  assert.throws(
    () => transitionTurn(state, board, { type: 'BUILD_HOUSE', payload: { propertyId: 'p1' } }),
    InvalidTurnActionError
  );
});

test('BUILD_HOUSE: owned single-tile group, funded — charges houseCost, bumps upgradeLevel, stays in POST_ACTIONS', () => {
  const state = {
    ...baseGameState(),
    phase: 'POST_ACTIONS',
    properties: baseGameState().properties.map((p) => (p.id === 'p1' ? { ...p, ownerId: 'gp-alice' } : p)),
  };
  const { gameState: after, transactions } = transitionTurn(state, board, {
    type: 'BUILD_HOUSE',
    payload: { propertyId: 'p1' },
  });

  assert.equal(after.phase, 'POST_ACTIONS'); // unlike END_TURN, a build does not advance the turn
  assert.equal(after.players.find((p) => p.id === 'gp-alice').currentBalance, 1500 - 50); // t1's houseCost
  assert.equal(after.properties.find((p) => p.id === 'p1').upgradeLevel, 1);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].transactionType, 'build');
});

test('BUILD_HOUSE: rejects when the player does not own the property (NOT_OWNER)', () => {
  const state = { ...baseGameState(), phase: 'POST_ACTIONS' }; // p1 unowned by default
  assert.throws(
    () => transitionTurn(state, board, { type: 'BUILD_HOUSE', payload: { propertyId: 'p1' } }),
    (err) => err instanceof InvalidPropertyActionError && err.reason === 'NOT_OWNER'
  );
});

// Rewritten 2026-08-25 (was: "rejects a property with no color group assigned
// (INCOMPLETE_GROUP)"). Owning the complete colour group is no longer a build
// precondition at all, so this now asserts the OPPOSITE outcome rather than
// being deleted — an ungrouped property is buildable on its own merits.
test('BUILD_HOUSE: a property with no colour group at all is now buildable (group ownership is no longer a precondition)', () => {
  // t10/p10 ('Owned Property') is deliberately ungrouped in buildSmallBoard(),
  // so it has no group holdings at all — the fallback to the property
  // itself (used by the GROUP_MORTGAGED check) is what has to hold here.
  const state = {
    ...baseGameState(),
    phase: 'POST_ACTIONS',
    properties: baseGameState().properties.map((p) => (p.id === 'p10' ? { ...p, ownerId: 'gp-alice' } : p)),
  };
  const { gameState: after, transactions } = transitionTurn(state, board, {
    type: 'BUILD_HOUSE',
    payload: { propertyId: 'p10' },
  });

  assert.equal(after.properties.find((p) => p.id === 'p10').upgradeLevel, 1);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].transactionType, 'build');
});

// 2026-08-25, user request: building must wait until at least the owner's own
// next turn after taking possession — see property.js's acquiredAtRound doc
// comment for the full reasoning (closes the "build immediately to dodge a
// further hostile buyout" loophole the fresh-purchase build offer opened).
test('BUILD_HOUSE: rejects a property acquired this same round (RECENTLY_ACQUIRED)', () => {
  const state = {
    ...baseGameState(),
    phase: 'POST_ACTIONS',
    roundNumber: 3,
    properties: baseGameState().properties.map((p) => (p.id === 'p1' ? { ...p, ownerId: 'gp-alice', acquiredAtRound: 3 } : p)),
  };
  assert.throws(
    () => transitionTurn(state, board, { type: 'BUILD_HOUSE', payload: { propertyId: 'p1' } }),
    (err) => err instanceof InvalidPropertyActionError && err.reason === 'RECENTLY_ACQUIRED'
  );
});

test('BUILD_HOUSE: succeeds once roundNumber has advanced past acquiredAtRound', () => {
  const state = {
    ...baseGameState(),
    phase: 'POST_ACTIONS',
    roundNumber: 4, // one full cycle past the round it was acquired in
    properties: baseGameState().properties.map((p) => (p.id === 'p1' ? { ...p, ownerId: 'gp-alice', acquiredAtRound: 3 } : p)),
  };
  const { gameState: after } = transitionTurn(state, board, { type: 'BUILD_HOUSE', payload: { propertyId: 'p1' } });
  assert.equal(after.properties.find((p) => p.id === 'p1').upgradeLevel, 1);
});

test('BUILD_HOUSE: acquiredAtRound === null skips the gate entirely (trade-acquired or legacy property)', () => {
  const state = {
    ...baseGameState(),
    phase: 'POST_ACTIONS',
    roundNumber: 3,
    properties: baseGameState().properties.map((p) => (p.id === 'p1' ? { ...p, ownerId: 'gp-alice', acquiredAtRound: null } : p)),
  };
  const { gameState: after } = transitionTurn(state, board, { type: 'BUILD_HOUSE', payload: { propertyId: 'p1' } });
  assert.equal(after.properties.find((p) => p.id === 'p1').upgradeLevel, 1);
});

test('BUY_PROPERTY then BUILD_HOUSE in the very same round is rejected end-to-end (RECENTLY_ACQUIRED)', () => {
  let state = { ...baseGameState(), phase: 'ROLLING' };
  // t2 (Station A) isn't house-eligible — roll(6, 5) lands on t11 ("Filler
  // 11"), a real unowned `property`-type tile, same as the other filler
  // tiles BUILD_HOUSE's own tests already rely on being house-eligible.
  ({ gameState: state } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(6, 5) })); // lands on t11
  ({ gameState: state } = transitionTurn(state, board, { type: 'BUY_PROPERTY' }, '2026-08-17T12:00:00.000Z'));
  const property = state.properties.find((p) => p.boardTileId === 't11');
  assert.equal(property.acquiredAtRound, state.roundNumber); // sanity: really did get set to the current round

  assert.throws(
    () => transitionTurn(state, board, { type: 'BUILD_HOUSE', payload: { propertyId: property.id } }),
    (err) => err instanceof InvalidPropertyActionError && err.reason === 'RECENTLY_ACQUIRED'
  );
});

test('BUILD_HOUSE: rejects building past the hotel ceiling (MAX_UPGRADE_LEVEL)', () => {
  const state = {
    ...baseGameState(),
    phase: 'POST_ACTIONS',
    properties: baseGameState().properties.map((p) =>
      p.id === 'p1' ? { ...p, ownerId: 'gp-alice', upgradeLevel: 5 } : p
    ),
  };
  assert.throws(
    () => transitionTurn(state, board, { type: 'BUILD_HOUSE', payload: { propertyId: 'p1' } }),
    (err) => err instanceof InvalidPropertyActionError && err.reason === 'MAX_UPGRADE_LEVEL'
  );
});

test('BUILD_HOUSE: rejects insufficient balance (INSUFFICIENT_BALANCE)', () => {
  const state = {
    ...baseGameState(),
    phase: 'POST_ACTIONS',
    players: baseGameState().players.map((p) => (p.id === 'gp-alice' ? { ...p, currentBalance: 10 } : p)),
    properties: baseGameState().properties.map((p) => (p.id === 'p1' ? { ...p, ownerId: 'gp-alice' } : p)),
  };
  assert.throws(
    () => transitionTurn(state, board, { type: 'BUILD_HOUSE', payload: { propertyId: 'p1' } }),
    (err) => err instanceof InvalidPropertyActionError && err.reason === 'INSUFFICIENT_BALANCE'
  );
});

// buildSmallBoard()'s own 'brown' group has exactly one tile (position 1) —
// too small to exercise "owns only part of the group". A dedicated
// two-tile group, isolated from the shared board/
// baseGameState() fixtures above, covers those.
function buildTwoTileGroupBoard() {
  const shared = { groupId: 'red', price: 100, baseRent: 6, rentTable: [30, 90, 270, 400, 550], houseCost: 50, mortgageValue: 50 };
  return [
    createTile({ id: 'rA', boardId: 'small', position: 20, tileType: 'property', name: 'Red Ave A', ...shared }),
    createTile({ id: 'rB', boardId: 'small', position: 21, tileType: 'property', name: 'Red Ave B', ...shared }),
  ];
}

function twoTileGroupState(propertyOverrides = {}) {
  const players = [
    createPlayerGameState({ id: 'gp-bank', gameId: 'g2', isBank: true, currentBalance: 20000 }),
    createPlayerGameState({ id: 'gp-alice', gameId: 'g2', playerId: 'alice', turnOrder: 0, currentBalance: 1500, currentPosition: 0 }),
    // Added 2026-08-25 so the "a rival owns part of this group" cases below
    // reference a player that genuinely exists, rather than an ownerId
    // pointing at nobody. Never the current player (turnOrder 0 is Alice), so
    // every pre-existing test using this fixture is unaffected.
    createPlayerGameState({ id: 'gp-bob', gameId: 'g2', playerId: 'bob', turnOrder: 1, currentBalance: 1500, currentPosition: 0 }),
  ];
  const properties = [
    createProperty({ id: 'rpA', gameId: 'g2', boardTileId: 'rA', ownerId: 'gp-alice', ...(propertyOverrides.rA ?? {}) }),
    createProperty({ id: 'rpB', gameId: 'g2', boardTileId: 'rB', ownerId: 'gp-alice', ...(propertyOverrides.rB ?? {}) }),
  ];
  return createGameState({
    id: 'g2',
    roomId: 'r2',
    boardId: 'small',
    status: 'in_progress',
    phase: 'POST_ACTIONS',
    currentTurnIndex: 0,
    players,
    properties,
    startedAt: '2026-08-18T00:00:00.000Z',
  });
}

const twoTileGroupBoard = buildTwoTileGroupBoard();

test('BUILD_HOUSE: full two-tile group, both unimproved — succeeds', () => {
  const { gameState: after } = transitionTurn(twoTileGroupState(), twoTileGroupBoard, {
    type: 'BUILD_HOUSE',
    payload: { propertyId: 'rpA' },
  });
  assert.equal(after.properties.find((p) => p.id === 'rpA').upgradeLevel, 1);
});

// Rewritten 2026-08-25 (was: "rejects when the player owns only part of the
// group (INCOMPLETE_GROUP)") — that rule is gone, so this asserts the new
// behaviour instead of being removed.
test('BUILD_HOUSE: owning only part of the group now succeeds — the monopoly gate is gone', () => {
  const state = twoTileGroupState({ rB: { ownerId: null } }); // Alice owns rA only; rB unowned
  const { gameState: after } = transitionTurn(state, twoTileGroupBoard, {
    type: 'BUILD_HOUSE',
    payload: { propertyId: 'rpA' },
  });
  assert.equal(after.properties.find((p) => p.id === 'rpA').upgradeLevel, 1);
});

// The even-build rule ("raise every lot you own in the group to the same
// level before pushing one higher") was REMOVED 2026-09-02 — a measured A/B
// showed it prevented no exploit and was a holdover from the dropped
// monopoly-gated-building rule. These tests were rewritten from asserting
// UNEVEN_BUILD to asserting the new behaviour: uneven building is allowed.
test('BUILD_HOUSE: a player can build repeatedly on one lot, whatever the rest of the group looks like', () => {
  const state = twoTileGroupState({ rB: { ownerId: 'gp-bob' } });
  let gs = state;
  for (let i = 1; i <= 3; i += 1) {
    ({ gameState: gs } = transitionTurn({ ...gs, phase: 'POST_ACTIONS' }, twoTileGroupBoard, {
      type: 'BUILD_HOUSE',
      payload: { propertyId: 'rpA' },
    }));
    assert.equal(gs.properties.find((p) => p.id === 'rpA').upgradeLevel, i);
  }
});

test('BUILD_HOUSE: building ahead of your own other lot in the group is now allowed', () => {
  // Alice owns both; rA has a house, rB has none. Pre-2026-09-02 this threw
  // UNEVEN_BUILD; it now succeeds and the gap is fine.
  const state = twoTileGroupState({ rA: { upgradeLevel: 1 } });
  const { gameState: after } = transitionTurn(state, twoTileGroupBoard, {
    type: 'BUILD_HOUSE',
    payload: { propertyId: 'rpA' },
  });
  assert.equal(after.properties.find((p) => p.id === 'rpA').upgradeLevel, 2);
  assert.equal(after.properties.find((p) => p.id === 'rpB').upgradeLevel, 0);
});

test('MORTGAGE / SELL_HOUSE: a rival\'s houses in the same group no longer block your own actions', () => {
  // Bob owns rB and has built on it; Alice owns rA, unimproved. Neither the
  // old group-wide rule nor (since 2026-09-02) the per-property one blocks
  // Alice mortgaging her own house-free lot here.
  const state = twoTileGroupState({ rB: { ownerId: 'gp-bob', upgradeLevel: 2 } });
  const { gameState: after } = transitionTurn(state, twoTileGroupBoard, {
    type: 'MORTGAGE',
    payload: { propertyId: 'rpA' },
  });
  assert.equal(after.properties.find((p) => p.id === 'rpA').mortgaged, true);
});

test('BUILD_HOUSE: rejects when a group member is mortgaged (GROUP_MORTGAGED)', () => {
  const state = twoTileGroupState({ rB: { mortgaged: true } });
  assert.throws(
    () => transitionTurn(state, twoTileGroupBoard, { type: 'BUILD_HOUSE', payload: { propertyId: 'rpA' } }),
    (err) => err instanceof InvalidPropertyActionError && err.reason === 'GROUP_MORTGAGED'
  );
});

test('BUILD_HOUSE: with the even-build rule gone, both the ahead and the behind lot are buildable', () => {
  // rA at 1, rB at 0. Either is now a legal build target — the old rule
  // forced rB; nothing forces it any more.
  const ahead = transitionTurn(twoTileGroupState({ rA: { upgradeLevel: 1 } }), twoTileGroupBoard, {
    type: 'BUILD_HOUSE',
    payload: { propertyId: 'rpA' },
  });
  assert.equal(ahead.gameState.properties.find((p) => p.id === 'rpA').upgradeLevel, 2);

  const behind = transitionTurn(twoTileGroupState({ rA: { upgradeLevel: 1 } }), twoTileGroupBoard, {
    type: 'BUILD_HOUSE',
    payload: { propertyId: 'rpB' },
  });
  assert.equal(behind.gameState.properties.find((p) => p.id === 'rpB').upgradeLevel, 1);
});

// --- SELL_HOUSE / MORTGAGE / UNMORTGAGE ---

test('outside POST_ACTIONS, SELL_HOUSE/MORTGAGE/UNMORTGAGE all throw InvalidTurnActionError', () => {
  const state = { ...baseGameState(), phase: 'ROLLING' };
  for (const type of ['SELL_HOUSE', 'MORTGAGE', 'UNMORTGAGE']) {
    assert.throws(() => transitionTurn(state, board, { type, payload: { propertyId: 'p1' } }), InvalidTurnActionError);
  }
});

test('SELL_HOUSE: owned, one house built — refunds half houseCost (floored) and decrements upgradeLevel', () => {
  const owned = { ...baseGameState(), phase: 'POST_ACTIONS', properties: baseGameState().properties.map((p) => (p.id === 'p1' ? { ...p, ownerId: 'gp-alice' } : p)) };
  const { gameState: built } = transitionTurn(owned, board, { type: 'BUILD_HOUSE', payload: { propertyId: 'p1' } }); // upgradeLevel -> 1, balance 1500-50=1450

  const { gameState: after, transactions } = transitionTurn(built, board, { type: 'SELL_HOUSE', payload: { propertyId: 'p1' } });

  assert.equal(after.phase, 'POST_ACTIONS');
  assert.equal(after.properties.find((p) => p.id === 'p1').upgradeLevel, 0);
  assert.equal(after.players.find((p) => p.id === 'gp-alice').currentBalance, 1450 + 25); // floor(50 * 0.5)
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].transactionType, 'sell_house');
});

test('SELL_HOUSE: rejects when the player does not own the property (NOT_OWNER)', () => {
  const state = {
    ...baseGameState(),
    phase: 'POST_ACTIONS',
    properties: baseGameState().properties.map((p) => (p.id === 'p1' ? { ...p, ownerId: null, upgradeLevel: 1 } : p)),
  };
  assert.throws(
    () => transitionTurn(state, board, { type: 'SELL_HOUSE', payload: { propertyId: 'p1' } }),
    (err) => err instanceof InvalidPropertyActionError && err.reason === 'NOT_OWNER'
  );
});

test('SELL_HOUSE: rejects a property with no houses to sell (NO_HOUSES_TO_SELL)', () => {
  const state = {
    ...baseGameState(),
    phase: 'POST_ACTIONS',
    properties: baseGameState().properties.map((p) => (p.id === 'p1' ? { ...p, ownerId: 'gp-alice' } : p)), // upgradeLevel 0
  };
  assert.throws(
    () => transitionTurn(state, board, { type: 'SELL_HOUSE', payload: { propertyId: 'p1' } }),
    (err) => err instanceof InvalidPropertyActionError && err.reason === 'NO_HOUSES_TO_SELL'
  );
});

test('SELL_HOUSE: even-sell rule rejects selling from the property that is behind the rest of the group (UNEVEN_SELL)', () => {
  // rB has a house to sell (upgradeLevel 1, clears NO_HOUSES_TO_SELL) but is
  // still behind rA's 2 — must sell from rA (the group max) first.
  const state = twoTileGroupState({ rA: { upgradeLevel: 2 }, rB: { upgradeLevel: 1 } });
  assert.throws(
    () => transitionTurn(state, twoTileGroupBoard, { type: 'SELL_HOUSE', payload: { propertyId: 'rpB' } }),
    (err) => err instanceof InvalidPropertyActionError && err.reason === 'UNEVEN_SELL'
  );
});

test('SELL_HOUSE: even-sell rule allows selling from the group\'s highest-level property', () => {
  const state = twoTileGroupState({ rA: { upgradeLevel: 1 } }); // rA at 1 (ahead) -> sell from rA
  const { gameState: after } = transitionTurn(state, twoTileGroupBoard, { type: 'SELL_HOUSE', payload: { propertyId: 'rpA' } });
  assert.equal(after.properties.find((p) => p.id === 'rpA').upgradeLevel, 0);
});

test('MORTGAGE: owned, unimproved, unmortgaged — flips mortgaged and pays mortgageValue', () => {
  const state = {
    ...baseGameState(),
    phase: 'POST_ACTIONS',
    properties: baseGameState().properties.map((p) => (p.id === 'p1' ? { ...p, ownerId: 'gp-alice' } : p)),
  };
  const { gameState: after, transactions } = transitionTurn(state, board, { type: 'MORTGAGE', payload: { propertyId: 'p1' } });

  assert.equal(after.phase, 'POST_ACTIONS');
  assert.equal(after.properties.find((p) => p.id === 'p1').mortgaged, true);
  assert.equal(after.players.find((p) => p.id === 'gp-alice').currentBalance, 1500 + 30); // t1's mortgageValue
  assert.equal(transactions[0].transactionType, 'mortgage');
});

test('MORTGAGE: rejects when the player does not own the property (NOT_OWNER)', () => {
  const state = { ...baseGameState(), phase: 'POST_ACTIONS' }; // p1 unowned by default
  assert.throws(
    () => transitionTurn(state, board, { type: 'MORTGAGE', payload: { propertyId: 'p1' } }),
    (err) => err instanceof InvalidPropertyActionError && err.reason === 'NOT_OWNER'
  );
});

test('MORTGAGE: rejects a property that is already mortgaged (ALREADY_MORTGAGED)', () => {
  const state = {
    ...baseGameState(),
    phase: 'POST_ACTIONS',
    properties: baseGameState().properties.map((p) => (p.id === 'p1' ? { ...p, ownerId: 'gp-alice', mortgaged: true } : p)),
  };
  assert.throws(
    () => transitionTurn(state, board, { type: 'MORTGAGE', payload: { propertyId: 'p1' } }),
    (err) => err instanceof InvalidPropertyActionError && err.reason === 'ALREADY_MORTGAGED'
  );
});

test('MORTGAGE: rejects when the target property itself has houses (PROPERTY_HAS_HOUSES)', () => {
  const state = twoTileGroupState({ rA: { upgradeLevel: 1 } });
  assert.throws(
    () => transitionTurn(state, twoTileGroupBoard, { type: 'MORTGAGE', payload: { propertyId: 'rpA' } }),
    (err) => err instanceof InvalidPropertyActionError && err.reason === 'PROPERTY_HAS_HOUSES'
  );
});

test('MORTGAGE: allows mortgaging a house-free lot even when a *different* lot in the same group still has houses (per-property, reverted 2026-09-02)', () => {
  const state = twoTileGroupState({ rA: { upgradeLevel: 1 } }); // rA has a house, rB (the mortgage target) does not
  const { gameState: after } = transitionTurn(state, twoTileGroupBoard, {
    type: 'MORTGAGE',
    payload: { propertyId: 'rpB' },
  });
  assert.equal(after.properties.find((p) => p.id === 'rpB').mortgaged, true);
  assert.equal(after.properties.find((p) => p.id === 'rpA').upgradeLevel, 1); // the sibling's house is untouched
});

test('UNMORTGAGE: mortgaged, sufficient funds — flips mortgaged off and charges mortgageValue * 1.1 (ceiled)', () => {
  const state = {
    ...baseGameState(),
    phase: 'POST_ACTIONS',
    properties: baseGameState().properties.map((p) => (p.id === 'p1' ? { ...p, ownerId: 'gp-alice', mortgaged: true } : p)),
  };
  const { gameState: after, transactions } = transitionTurn(state, board, { type: 'UNMORTGAGE', payload: { propertyId: 'p1' } });

  assert.equal(after.phase, 'POST_ACTIONS');
  assert.equal(after.properties.find((p) => p.id === 'p1').mortgaged, false);
  assert.equal(after.players.find((p) => p.id === 'gp-alice').currentBalance, 1500 - 33); // ceil(30 * 1.1)
  assert.equal(transactions[0].transactionType, 'unmortgage');
});

test('UNMORTGAGE: rejects when the player does not own the property (NOT_OWNER)', () => {
  const state = {
    ...baseGameState(),
    phase: 'POST_ACTIONS',
    properties: baseGameState().properties.map((p) => (p.id === 'p1' ? { ...p, mortgaged: true } : p)), // mortgaged, unowned
  };
  assert.throws(
    () => transitionTurn(state, board, { type: 'UNMORTGAGE', payload: { propertyId: 'p1' } }),
    (err) => err instanceof InvalidPropertyActionError && err.reason === 'NOT_OWNER'
  );
});

test('UNMORTGAGE: rejects a property that is not mortgaged (NOT_MORTGAGED)', () => {
  const state = {
    ...baseGameState(),
    phase: 'POST_ACTIONS',
    properties: baseGameState().properties.map((p) => (p.id === 'p1' ? { ...p, ownerId: 'gp-alice' } : p)),
  };
  assert.throws(
    () => transitionTurn(state, board, { type: 'UNMORTGAGE', payload: { propertyId: 'p1' } }),
    (err) => err instanceof InvalidPropertyActionError && err.reason === 'NOT_MORTGAGED'
  );
});

test('UNMORTGAGE: rejects insufficient balance (INSUFFICIENT_BALANCE)', () => {
  const state = {
    ...baseGameState(),
    phase: 'POST_ACTIONS',
    players: baseGameState().players.map((p) => (p.id === 'gp-alice' ? { ...p, currentBalance: 10 } : p)),
    properties: baseGameState().properties.map((p) => (p.id === 'p1' ? { ...p, ownerId: 'gp-alice', mortgaged: true } : p)),
  };
  assert.throws(
    () => transitionTurn(state, board, { type: 'UNMORTGAGE', payload: { propertyId: 'p1' } }),
    (err) => err instanceof InvalidPropertyActionError && err.reason === 'INSUFFICIENT_BALANCE'
  );
});

// ---- Win Condition: LIQUIDATION_REQUIRED resolution, Final Phase, game end ----

test('LIQUIDATION_REQUIRED: outside POST_ACTIONS behavior — only SELL_HOUSE/MORTGAGE are legal here', () => {
  const state = {
    ...baseGameState(),
    phase: 'LIQUIDATION_REQUIRED',
    pendingLiquidation: { debtorId: 'gp-alice', creditorId: 'gp-bank', amount: 100, transactionType: 'tax' },
  };
  assert.throws(
    () => transitionTurn(state, board, { type: 'END_TURN' }),
    (err) => err instanceof InvalidTurnActionError
  );
  assert.throws(
    () => transitionTurn(state, board, { type: 'BUILD_HOUSE', payload: { propertyId: 'p1' } }),
    (err) => err instanceof InvalidTurnActionError
  );
});

test('LIQUIDATION_REQUIRED: a single MORTGAGE that fully covers the debt settles it immediately and returns to POST_ACTIONS', () => {
  const state = {
    ...baseGameState(),
    phase: 'LIQUIDATION_REQUIRED',
    pendingLiquidation: { debtorId: 'gp-alice', creditorId: 'gp-bank', amount: 100, transactionType: 'tax' },
    players: baseGameState().players.map((p) => (p.id === 'gp-alice' ? { ...p, currentBalance: 10 } : p)),
    properties: baseGameState().properties.map((p) => (p.id === 'p2' ? { ...p, ownerId: 'gp-alice' } : p)), // Station A, mortgageValue 100
  };

  const { gameState, transactions } = transitionTurn(state, board, { type: 'MORTGAGE', payload: { propertyId: 'p2' } });

  assert.equal(gameState.phase, 'POST_ACTIONS');
  assert.equal(gameState.pendingLiquidation, null);
  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentBalance, 10); // +100 mortgage payout, -100 tax settled
  assert.equal(gameState.properties.find((p) => p.id === 'p2').mortgaged, true);
  assert.equal(transactions.length, 2); // the mortgage payout, then the settled tax payment
  assert.ok(transactions.some((t) => t.transactionType === 'mortgage'));
  assert.ok(transactions.some((t) => t.transactionType === 'tax' && t.fromGamePlayerId === 'gp-alice' && t.toGamePlayerId === 'gp-bank'));
});

test('LIQUIDATION_REQUIRED: a MORTGAGE that does not yet cover the debt stays in LIQUIDATION_REQUIRED for another round', () => {
  const state = {
    ...baseGameState(),
    phase: 'LIQUIDATION_REQUIRED',
    pendingLiquidation: { debtorId: 'gp-alice', creditorId: 'gp-bank', amount: 100, transactionType: 'tax' },
    players: baseGameState().players.map((p) => (p.id === 'gp-alice' ? { ...p, currentBalance: 10 } : p)),
    // Three filler properties, mortgageValue 40 each (120 total) — enough overall, not enough after just one.
    properties: baseGameState().properties.map((p) =>
      ['p11', 'p12', 'p13'].includes(p.id) ? { ...p, ownerId: 'gp-alice' } : p
    ),
  };

  const afterOne = transitionTurn(state, board, { type: 'MORTGAGE', payload: { propertyId: 'p11' } });
  assert.equal(afterOne.gameState.phase, 'LIQUIDATION_REQUIRED');
  assert.equal(afterOne.gameState.pendingLiquidation.amount, 100); // untouched — not settled yet
  assert.equal(afterOne.gameState.players.find((p) => p.id === 'gp-alice').currentBalance, 50); // 10 + 40, still < 100

  const afterTwo = transitionTurn(afterOne.gameState, board, { type: 'MORTGAGE', payload: { propertyId: 'p12' } });
  assert.equal(afterTwo.gameState.phase, 'LIQUIDATION_REQUIRED');
  assert.equal(afterTwo.gameState.players.find((p) => p.id === 'gp-alice').currentBalance, 90); // 50 + 40, still < 100

  const afterThree = transitionTurn(afterTwo.gameState, board, { type: 'MORTGAGE', payload: { propertyId: 'p13' } });
  assert.equal(afterThree.gameState.phase, 'POST_ACTIONS'); // 90 + 40 = 130 >= 100 -> settled
  assert.equal(afterThree.gameState.pendingLiquidation, null);
  assert.equal(afterThree.gameState.players.find((p) => p.id === 'gp-alice').currentBalance, 30); // 130 - 100
});

test('Final Phase: entering it is a one-time flag flip, exactly at the trigger round, on a real wraparound advance', () => {
  const state = {
    ...baseGameState(),
    phase: 'POST_ACTIONS',
    currentTurnIndex: 1, // Bob — the last real player, so END_TURN here wraps back to Alice
    roundNumber: FINAL_PHASE_TRIGGER_ROUND - 1,
  };

  const { gameState } = transitionTurn(state, board, { type: 'END_TURN' });

  assert.equal(gameState.roundNumber, FINAL_PHASE_TRIGGER_ROUND);
  assert.equal(gameState.finalPhaseStartedAtRound, FINAL_PHASE_TRIGGER_ROUND);
  assert.equal(gameState.status, 'in_progress'); // entering Final Phase does not end the match
  assert.equal(gameState.currentTurnIndex, 0); // Alice's turn, normally
});

test('Final Phase: once its duration elapses, the match ends with the highest-net-worth solvent player winning (net_worth_win)', () => {
  const state = {
    ...baseGameState(),
    phase: 'POST_ACTIONS',
    currentTurnIndex: 1, // Bob — last player, END_TURN here wraps and completes the final round
    roundNumber: FINAL_PHASE_TRIGGER_ROUND + FINAL_PHASE_DURATION_ROUNDS - 1,
    finalPhaseStartedAtRound: FINAL_PHASE_TRIGGER_ROUND,
    players: baseGameState().players.map((p) => {
      if (p.id === 'gp-alice') return { ...p, currentBalance: 2000 };
      if (p.id === 'gp-bob') return { ...p, currentBalance: 1000 };
      return p;
    }),
  };

  const { gameState } = transitionTurn(state, board, { type: 'END_TURN' }, '2026-08-19T18:00:00.000Z');

  assert.equal(gameState.status, 'finished');
  assert.equal(gameState.phase, null);
  assert.equal(gameState.endReason, 'final_phase');
  assert.equal(gameState.endedAt, '2026-08-19T18:00:00.000Z');

  const alice = gameState.players.find((p) => p.id === 'gp-alice');
  const bob = gameState.players.find((p) => p.id === 'gp-bob');
  // Alice: 2000 cash + property value from Bob-owned p10 not counted for her (she owns nothing) -> 2000 net worth
  // Bob: 1000 cash + p10 (Owned Property, price 100, unmortgaged, unimproved) = 1100 net worth
  assert.equal(alice.finalRank, 1); // 2000 > 1100
  assert.equal(bob.finalRank, 2);
  assert.equal(alice.finalNetWorth, 2000);
  assert.equal(alice.finalCash, 2000);
  assert.equal(alice.finalPropertyValue, 0);
  assert.equal(bob.finalNetWorth, 1100);
  assert.equal(bob.finalCash, 1000);
  assert.equal(bob.finalPropertyValue, 100);
});

test('Bankruptcy during Final Phase with 2+ solvent players remaining does not end the match — just eliminates that one player', () => {
  const state = {
    ...baseGameState(),
    phase: 'ROLLING',
    finalPhaseStartedAtRound: FINAL_PHASE_TRIGGER_ROUND,
    roundNumber: FINAL_PHASE_TRIGGER_ROUND + 1,
    players: [
      ...baseGameState().players,
      createPlayerGameState({ id: 'gp-carol', gameId: 'g1', playerId: 'carol', turnOrder: 2, currentBalance: 1500, currentPosition: 0 }),
    ],
  };
  const poor = { ...state, players: state.players.map((p) => (p.id === 'gp-alice' ? { ...p, currentBalance: 10 } : p)) };

  const { gameState } = transitionTurn(poor, board, { type: 'ROLL_DICE', payload: roll(3, 2) }, '2026-08-19T12:00:00.000Z'); // tax tile, owes 100

  const alice = gameState.players.find((p) => p.id === 'gp-alice');
  assert.equal(alice.bankrupt, true);
  // Bob and Carol both still active -> match continues, Final Phase countdown untouched.
  assert.equal(gameState.status, 'in_progress');
  assert.equal(gameState.finalPhaseStartedAtRound, FINAL_PHASE_TRIGGER_ROUND);
});

// Found by fuzzing 2026-08-25 (invariant: the current player is never
// bankrupt). A bankruptcy used to leave the ELIMINATED player holding the
// turn, so the whole table waited for someone who had already lost — and who
// is the player most likely to have closed the tab — to click End Turn, or
// for POST_ACTIONS' 30s timeout to fire. resolveForfeit already force-advanced
// in the mechanically identical case; these two paths now agree.
test('a bankruptcy that eliminates the CURRENT player force-advances the turn instead of leaving them holding it', () => {
  const state = {
    ...baseGameState(),
    phase: 'ROLLING',
    players: [
      ...baseGameState().players,
      createPlayerGameState({ id: 'gp-carol', gameId: 'g1', playerId: 'carol', turnOrder: 2, currentBalance: 1500, currentPosition: 0 }),
    ],
  };
  const poor = { ...state, players: state.players.map((p) => (p.id === 'gp-alice' ? { ...p, currentBalance: 10 } : p)) };

  const { gameState } = transitionTurn(poor, board, { type: 'ROLL_DICE', payload: roll(3, 2) }, '2026-08-19T12:00:00.000Z'); // tax tile, owes 100

  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').bankrupt, true);
  assert.equal(gameState.status, 'in_progress'); // Bob and Carol remain
  const current = gameState.players.find((p) => !p.isBank && p.turnOrder === gameState.currentTurnIndex);
  assert.ok(current, 'currentTurnIndex must still resolve to a real player');
  assert.equal(current.bankrupt, false, 'the turn must not rest on the eliminated player');
  assert.notEqual(current.id, 'gp-alice');
});


// ---- Phase 14 (2026-08-19): building supply scarcity, Free Parking jackpot, Hostile Acquisition ----

test('BUILD_HOUSE: rejects with INSUFFICIENT_SUPPLY when houseSupply is exhausted', () => {
  const state = {
    ...baseGameState({ houseSupply: 0 }),
    properties: baseGameState().properties.map((p) => (p.id === 'p1' ? { ...p, ownerId: 'gp-alice' } : p)),
    phase: 'POST_ACTIONS',
  };
  assert.throws(
    () => transitionTurn(state, board, { type: 'BUILD_HOUSE', payload: { propertyId: 'p1' } }),
    (err) => err instanceof InvalidPropertyActionError && err.reason === 'INSUFFICIENT_SUPPLY'
  );
});

test('BUILD_HOUSE: a normal build decrements houseSupply by exactly 1, hotelSupply untouched', () => {
  const state = {
    ...baseGameState(),
    properties: baseGameState().properties.map((p) => (p.id === 'p1' ? { ...p, ownerId: 'gp-alice' } : p)),
    phase: 'POST_ACTIONS',
  };
  const { gameState } = transitionTurn(state, board, { type: 'BUILD_HOUSE', payload: { propertyId: 'p1' } });
  assert.equal(gameState.houseSupply, 31);
  assert.equal(gameState.hotelSupply, 12);
});

test('BUILD_HOUSE: the 4th house upgrading to a hotel returns 4 houses and takes 1 hotel from the shared supply', () => {
  const state = {
    ...baseGameState({ houseSupply: 10, hotelSupply: 5 }),
    properties: baseGameState().properties.map((p) => (p.id === 'p1' ? { ...p, ownerId: 'gp-alice', upgradeLevel: 4 } : p)),
    phase: 'POST_ACTIONS',
  };
  const { gameState } = transitionTurn(state, board, { type: 'BUILD_HOUSE', payload: { propertyId: 'p1' } });
  const p1 = gameState.properties.find((p) => p.id === 'p1');
  assert.equal(p1.upgradeLevel, 5);
  assert.equal(gameState.houseSupply, 14); // 10 + 4 returned
  assert.equal(gameState.hotelSupply, 4); // 5 - 1 taken
});

test('BUILD_HOUSE: the hotel conversion specifically is rejected when hotelSupply is exhausted, even with plenty of houses left', () => {
  const state = {
    ...baseGameState({ houseSupply: 32, hotelSupply: 0 }),
    properties: baseGameState().properties.map((p) => (p.id === 'p1' ? { ...p, ownerId: 'gp-alice', upgradeLevel: 4 } : p)),
    phase: 'POST_ACTIONS',
  };
  assert.throws(
    () => transitionTurn(state, board, { type: 'BUILD_HOUSE', payload: { propertyId: 'p1' } }),
    (err) => err instanceof InvalidPropertyActionError && err.reason === 'INSUFFICIENT_SUPPLY'
  );
});

test('SELL_HOUSE: a normal sale returns exactly 1 house to the shared supply', () => {
  const state = {
    ...baseGameState({ houseSupply: 20 }),
    properties: baseGameState().properties.map((p) => (p.id === 'p1' ? { ...p, ownerId: 'gp-alice', upgradeLevel: 1 } : p)),
    phase: 'POST_ACTIONS',
  };
  const { gameState } = transitionTurn(state, board, { type: 'SELL_HOUSE', payload: { propertyId: 'p1' } });
  assert.equal(gameState.houseSupply, 21);
  assert.equal(gameState.hotelSupply, 12);
});

test('SELL_HOUSE: selling down from a hotel returns the hotel and takes 4 houses back out of the shared supply', () => {
  const state = {
    ...baseGameState({ houseSupply: 20, hotelSupply: 5 }),
    properties: baseGameState().properties.map((p) => (p.id === 'p1' ? { ...p, ownerId: 'gp-alice', upgradeLevel: 5 } : p)),
    phase: 'POST_ACTIONS',
  };
  const { gameState } = transitionTurn(state, board, { type: 'SELL_HOUSE', payload: { propertyId: 'p1' } });
  const p1 = gameState.properties.find((p) => p.id === 'p1');
  assert.equal(p1.upgradeLevel, 4);
  assert.equal(gameState.houseSupply, 16); // 20 - 4 taken back out
  assert.equal(gameState.hotelSupply, 6); // 5 + 1 returned
});

test('Real bankruptcy to the Bank returns forfeited buildings to the shared supply and resets the property’s own upgradeLevel to 0', () => {
  const state = {
    ...baseGameState({
      players: baseGameState().players.map((p) => (p.id === 'gp-alice' ? { ...p, currentBalance: 10 } : p)),
      properties: baseGameState().properties.map((p) => (p.id === 'p1' ? { ...p, ownerId: 'gp-alice', upgradeLevel: 1 } : p)),
    }),
    phase: 'ROLLING',
  };
  const { gameState } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(3, 2) }, '2026-08-19T14:00:00.000Z'); // tax tile, owes 100 — 10 cash + p1's liquidation value (25 house sellback + 30 mortgage = 55) is still < 100, genuinely bankrupt

  const alice = gameState.players.find((p) => p.id === 'gp-alice');
  assert.equal(alice.bankrupt, true);
  const p1 = gameState.properties.find((p) => p.id === 'p1');
  assert.equal(p1.ownerId, null);
  assert.equal(p1.upgradeLevel, 0); // reset — the 1 house it had just returned to the pool below
  assert.equal(gameState.houseSupply, 33); // 32 default + 1 returned
});

test('Bankruptcy to another player (not the Bank) leaves the forfeited property’s buildings exactly as they were — supply untouched', () => {
  const state = {
    ...baseGameState({
      players: baseGameState().players.map((p) => (p.id === 'gp-alice' ? { ...p, currentBalance: 10 } : p)),
      properties: baseGameState().properties.map((p) => {
        if (p.id === 'p1') return { ...p, ownerId: 'gp-alice', upgradeLevel: 1 }; // Alice's own improved property
        if (p.id === 'p10') return { ...p, upgradeLevel: 4 }; // Bob's tile, improved enough that rent alone bankrupts Alice
        return p;
      }),
    }),
    phase: 'ROLLING',
    currentDoublesStreak: 0,
  };
  // total 10 -> position 10, Bob's Owned Property, rentTable[3] = 400. Alice has 10 cash + p1's liquidation value (55) = 65 < 400 -> genuinely bankrupt, creditor is Bob (a real player), not the Bank.
  // Rent Risk Choice REVISED 2026-08-25 — rent settles in the SAME
  // transition as the roll now, no separate owner decision to reach first.
  const { gameState } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(5, 5) }, '2026-08-19T14:00:00.000Z');

  const alice = gameState.players.find((p) => p.id === 'gp-alice');
  assert.equal(alice.bankrupt, true);
  const p1 = gameState.properties.find((p) => p.id === 'p1');
  assert.equal(p1.ownerId, 'gp-bob'); // transferred to Bob in kind
  assert.equal(p1.upgradeLevel, 1); // untouched — still has its 1 house, Bob just inherited it
  assert.equal(gameState.houseSupply, 32); // untouched — nothing returned to any shared pool
  // No Gamble side-offer either — pendingRentGamble is only ever set for a
  // clean, in-full cash payment (resolveLanding's own scope note), and this
  // one instead went to a real bankruptcy.
  assert.equal(gameState.pendingRentGamble, null);
});

test('PAYING_TAX: a successful payment feeds the Free Parking jackpot by the exact amount paid', () => {
  const state = { ...baseGameState(), phase: 'ROLLING' };
  const { gameState } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(3, 2) }); // tax tile, owes 100, Alice has 1500

  assert.equal(gameState.freeParkingJackpot, 100);
});

test('PAY_JAIL_FINE: a successful payment also feeds the Free Parking jackpot', () => {
  const state = baseGameState();
  state.players[1] = { ...state.players[1], inJail: true, jailTurns: 1 };
  const { gameState } = transitionTurn({ ...state, phase: 'JAIL_DECISION' }, board, { type: 'PAY_JAIL_FINE' });

  assert.equal(gameState.freeParkingJackpot, 50); // JAIL_FINE
});

test('Rent payments never feed the Free Parking jackpot — player-to-player, not the Bank', () => {
  const state = { ...baseGameState(), phase: 'ROLLING' };
  const { gameState } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(5, 5) }); // total 10 -> Bob's Owned Property

  assert.equal(gameState.freeParkingJackpot, 0);
});

test('A tax debt settled later via LIQUIDATION_REQUIRED still feeds the jackpot once it actually clears', () => {
  const state = {
    ...baseGameState({
      players: baseGameState().players.map((p) => (p.id === 'gp-alice' ? { ...p, currentBalance: 10 } : p)),
      properties: baseGameState().properties.map((p) => (p.id === 'p2' ? { ...p, ownerId: 'gp-alice' } : p)), // transport, mortgageValue 100 — enough to cover the 100 tax
    }),
    phase: 'ROLLING',
  };
  const { gameState: afterTax } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(3, 2) }); // tax tile, owes 100
  assert.equal(afterTax.phase, 'LIQUIDATION_REQUIRED');
  assert.equal(afterTax.freeParkingJackpot, 0); // not yet — still pending

  const { gameState } = transitionTurn(afterTax, board, { type: 'MORTGAGE', payload: { propertyId: 'p2' } });
  assert.equal(gameState.phase, 'POST_ACTIONS');
  assert.equal(gameState.freeParkingJackpot, 100); // cleared now
});

test('Landing on Free Parking with a jackpot pays it out to the landing player and resets it to 0', () => {
  const state = {
    ...baseGameState({ freeParkingJackpot: 350, currentDoublesStreak: 0 }),
    players: baseGameState().players.map((p) => (p.id === 'gp-alice' ? { ...p, currentPosition: 0 } : p)),
    phase: 'ROLLING',
  };
  // position 0 + 9 = 9, the free_parking tile in this fixture board.
  const { gameState, transactions } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(5, 4) });

  assert.equal(gameState.freeParkingJackpot, 0);
  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentBalance, 1500 + 350);
  assert.ok(transactions.some((t) => t.transactionType === 'free_parking_jackpot' && t.amount === 350));
});

test('Landing on Free Parking with no jackpot (0) is a normal, silent landing — no extra transaction', () => {
  const state = { ...baseGameState({ currentDoublesStreak: 0 }), phase: 'ROLLING' };
  const { gameState, transactions } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(5, 4) }); // position 0 -> 9, free_parking

  assert.equal(gameState.freeParkingJackpot, 0);
  assert.equal(transactions.length, 0);
});

test('Landing on an owned, unmortgaged, non-monopoly property and paying rent marks it eligible for a Hostile Buyout', () => {
  const state = { ...baseGameState(), phase: 'ROLLING' };
  const { gameState } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(5, 5) }); // total 10 -> Bob's Owned Property (ungrouped)

  assert.equal(gameState.phase, 'POST_ACTIONS');
  assert.equal(gameState.pendingHostileBuyoutPropertyId, 'p10');
});

// ---- Rent Risk Choice (BOARD_SPECIFICATION.md), REVISED 2026-08-25 ----
// Real user correction: "người vào đất chỉ mất x1 số tiền thôi chứ sao lại
// mất x2 và không cần chờ người khác quyết định chọn gì" — the payer's
// rent is now fixed (settled immediately, in full, in the SAME transition
// as the roll — see the "landing on rent owed" test above), and the
// GAMBLE_RENT action below is the owner's own entirely separate, optional,
// non-blocking follow-up: betting what they already collected against the
// Bank, never against the payer again.

function reachPendingRentGamble() {
  const state = { ...baseGameState(), phase: 'ROLLING' };
  const { gameState } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(5, 5) }); // total 10 -> Bob's Owned Property, rent 6, paid in full already
  return gameState;
}

test('GAMBLE_RENT: a winning roll (<0.5) pays the owner ANOTHER full amount from the Bank — the payer is never touched again', () => {
  const afterRent = reachPendingRentGamble();
  const alice = afterRent.players.find((p) => p.id === 'gp-alice');
  const { gameState, transactions } = transitionTurn(afterRent, board, {
    type: 'GAMBLE_RENT',
    payload: { gambleRoll: 0.1, playerId: 'gp-bob' },
  });

  assert.equal(gameState.pendingRentGamble, null);
  // Untouched — the payer already settled their fixed x1 the moment they
  // landed; nothing about the owner's later gamble can ever reach them.
  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentBalance, alice.currentBalance);
  assert.equal(gameState.players.find((p) => p.id === 'gp-bob').currentBalance, 1500 + 6 + 6); // rent, then the gamble's own win
  assert.ok(transactions.some((t) => t.transactionType === 'rent_gamble' && t.amount === 6 && t.toGamePlayerId === 'gp-bob'));
});

test('GAMBLE_RENT: a losing roll (>=0.5) takes the already-collected amount back to the Bank — a real transaction, not a zero-sum no-op', () => {
  const afterRent = reachPendingRentGamble();
  const { gameState, transactions } = transitionTurn(afterRent, board, {
    type: 'GAMBLE_RENT',
    payload: { gambleRoll: 0.9, playerId: 'gp-bob' },
  });

  assert.equal(gameState.pendingRentGamble, null);
  const alice = gameState.players.find((p) => p.id === 'gp-alice');
  const bob = gameState.players.find((p) => p.id === 'gp-bob');
  assert.equal(alice.currentBalance, 1500 - 6); // still just their original fixed rent — unaffected by Bob's own loss
  assert.equal(bob.currentBalance, 1500); // collected 6 in rent, then lost exactly that 6 back to the Bank — nets to their starting balance
  assert.ok(transactions.some((t) => t.transactionType === 'rent_gamble' && t.amount === 6 && t.fromGamePlayerId === 'gp-bob'));
});

test('GAMBLE_RENT: rejected with NOT_OWNER when the sender is not the property owner', () => {
  const afterRent = reachPendingRentGamble();
  assert.throws(
    () =>
      transitionTurn(afterRent, board, {
        type: 'GAMBLE_RENT',
        payload: { gambleRoll: 0.1, playerId: 'gp-alice' }, // Alice is the payer, not the owner (Bob)
      }),
    (err) => err instanceof InvalidPropertyActionError && err.reason === 'NOT_OWNER'
  );
});

test('GAMBLE_RENT: rejected with NO_PENDING_RENT_GAMBLE when nothing is currently offered', () => {
  const state = { ...baseGameState(), phase: 'POST_ACTIONS' }; // fresh state, no rent has ever settled
  assert.throws(
    () => transitionTurn(state, board, { type: 'GAMBLE_RENT', payload: { gambleRoll: 0.1, playerId: 'gp-bob' } }),
    (err) => err instanceof InvalidPropertyActionError && err.reason === 'NO_PENDING_RENT_GAMBLE'
  );
});

test('GAMBLE_RENT: rejected with INSUFFICIENT_BALANCE if the owner already spent the money before choosing to gamble it', () => {
  const afterRent = reachPendingRentGamble();
  // Bob collected the $6 rent, then (in this same, still-current turn or a
  // later one — GAMBLE_RENT is legal any time) spends it on something else
  // before ever using the gamble offer.
  const spentIt = {
    ...afterRent,
    players: afterRent.players.map((p) => (p.id === 'gp-bob' ? { ...p, currentBalance: 2 } : p)),
  };
  assert.throws(
    () => transitionTurn(spentIt, board, { type: 'GAMBLE_RENT', payload: { gambleRoll: 0.1, playerId: 'gp-bob' } }),
    (err) => err instanceof InvalidPropertyActionError && err.reason === 'INSUFFICIENT_BALANCE'
  );
});

test('GAMBLE_RENT: legal regardless of gameState.phase — the whole point of the revision is that nothing has to wait for it', () => {
  const afterRent = reachPendingRentGamble();
  // Some completely unrelated phase is now current — e.g. a later roll put
  // the table into AWAITING_PURCHASE — and Bob STILL has his earlier,
  // unclaimed gamble offer available.
  const midOtherPhase = { ...afterRent, phase: 'AWAITING_PURCHASE' };
  const { gameState } = transitionTurn(midOtherPhase, board, {
    type: 'GAMBLE_RENT',
    payload: { gambleRoll: 0.1, playerId: 'gp-bob' },
  });

  assert.equal(gameState.pendingRentGamble, null);
  assert.equal(gameState.phase, 'AWAITING_PURCHASE'); // completely untouched — a non-blocking side action never changes phase
  assert.equal(gameState.players.find((p) => p.id === 'gp-bob').currentBalance, 1500 + 6 + 6);
});

test('HOSTILE_BUYOUT: succeeds at exactly 2.0x price on an unimproved property, pays the owner directly, transfers ownership', () => {
  // p10's own fixture price is 100, upgradeLevel 0 (unimproved) — see the
  // next test for why this can no longer cover the "+ buildings" half of
  // the formula (found 2026-08-22, unrelated pre-existing rule, not this
  // session's own work: handleHostileBuyout now rejects HOUSE_PROTECTED
  // outright for any upgradeLevel > 0, so a buyout can never actually
  // succeed on an improved property to observe the doubled building cost).
  const state = {
    ...baseGameState(),
    phase: 'POST_ACTIONS',
    pendingHostileBuyoutPropertyId: 'p10',
  };
  const { gameState, transactions } = transitionTurn(state, board, { type: 'HOSTILE_BUYOUT' });

  const alice = gameState.players.find((p) => p.id === 'gp-alice');
  const bob = gameState.players.find((p) => p.id === 'gp-bob');
  assert.equal(alice.currentBalance, 1500 - 200); // 2.0 * 100
  assert.equal(bob.currentBalance, 1500 + 200); // paid directly, Bank uninvolved
  assert.equal(gameState.properties.find((p) => p.id === 'p10').ownerId, 'gp-alice');
  assert.equal(gameState.phase, 'POST_ACTIONS');
  assert.equal(gameState.pendingHostileBuyoutPropertyId, null);
  assert.ok(transactions.some((t) => t.transactionType === 'hostile_acquisition' && t.amount === 200));
});

// 2026-08-25, user request: the new owner from a hostile buyout is just as
// "freshly acquired" as a real BUY_PROPERTY, and every hostile-buyout target
// is by definition unimproved (HOUSE_PROTECTED already excludes anything
// else) — without this, the new owner could immediately build to re-protect
// it against a further hostile buyout in the very same turn, closing the
// window HOUSE_PROTECTED is supposed to leave open for at least one turn.
test('HOSTILE_BUYOUT: the new owner cannot immediately BUILD_HOUSE on the same-turn-acquired property (RECENTLY_ACQUIRED)', () => {
  const state = {
    ...baseGameState(),
    phase: 'POST_ACTIONS',
    pendingHostileBuyoutPropertyId: 'p10',
  };
  const { gameState } = transitionTurn(state, board, { type: 'HOSTILE_BUYOUT' });

  const property = gameState.properties.find((p) => p.id === 'p10');
  assert.equal(property.acquiredAtRound, gameState.roundNumber); // sanity: really did get reset

  assert.throws(
    () => transitionTurn(gameState, board, { type: 'BUILD_HOUSE', payload: { propertyId: 'p10' } }),
    (err) => err instanceof InvalidPropertyActionError && err.reason === 'RECENTLY_ACQUIRED'
  );
});

test('HOSTILE_BUYOUT: rejected with HOUSE_PROTECTED when the target has any houses built, found 2026-08-22 while running the full suite for unrelated work — a real, deliberate rule already in the code (its own comment: "User requirement: properties with ANY houses cannot be taken over"), just missing test coverage', () => {
  const state = {
    ...baseGameState(),
    properties: baseGameState().properties.map((p) => (p.id === 'p10' ? { ...p, upgradeLevel: 1 } : p)),
    phase: 'POST_ACTIONS',
    pendingHostileBuyoutPropertyId: 'p10',
  };
  assert.throws(
    () => transitionTurn(state, board, { type: 'HOSTILE_BUYOUT' }),
    (err) => err instanceof InvalidPropertyActionError && err.reason === 'HOUSE_PROTECTED'
  );
});

test('HOSTILE_BUYOUT: rejected with MONOPOLY_PROTECTED when the target belongs to a completed color-group monopoly', () => {
  // p10 itself is deliberately ungrouped in this fixture board (see
  // buildSmallBoard()'s own comment) — prove the restriction using p1
  // instead, a real single-tile "brown" group, fully owned by Bob.
  const state = {
    ...baseGameState(),
    properties: baseGameState().properties.map((p) => (p.id === 'p1' ? { ...p, ownerId: 'gp-bob' } : p)),
    phase: 'POST_ACTIONS',
    pendingHostileBuyoutPropertyId: 'p1',
  };
  assert.throws(
    () => transitionTurn(state, board, { type: 'HOSTILE_BUYOUT' }),
    (err) => err instanceof InvalidPropertyActionError && err.reason === 'MONOPOLY_PROTECTED'
  );
});

// All three found by fuzzing the trade subsystem 2026-08-25. Trades and
// FORFEIT_MATCH are deliberately phase-independent, so ownership of the
// pending buyout target can legitimately change between the rent payment
// that opened the window and the buyout click that uses it.
test('HOSTILE_BUYOUT: rejected with ALREADY_OWNED if the buyer acquired the target (e.g. by trade) before clicking — used to crash on a self-to-self transfer', () => {
  const state = {
    ...baseGameState(),
    phase: 'POST_ACTIONS',
    pendingHostileBuyoutPropertyId: 'p10',
    // p10 is Bob's in the fixture; Alice has since acquired it.
    properties: baseGameState().properties.map((p) => (p.id === 'p10' ? { ...p, ownerId: 'gp-alice' } : p)),
  };
  assert.throws(
    () => transitionTurn(state, board, { type: 'HOSTILE_BUYOUT' }),
    (err) => err instanceof InvalidPropertyActionError && err.reason === 'ALREADY_OWNED'
  );
});

test('HOSTILE_BUYOUT: rejected with NOT_OWNED if the owner forfeited/went bankrupt first, reverting the target to the Bank', () => {
  const state = {
    ...baseGameState(),
    phase: 'POST_ACTIONS',
    pendingHostileBuyoutPropertyId: 'p10',
    properties: baseGameState().properties.map((p) => (p.id === 'p10' ? { ...p, ownerId: null } : p)),
  };
  assert.throws(
    () => transitionTurn(state, board, { type: 'HOSTILE_BUYOUT' }),
    (err) => err instanceof InvalidPropertyActionError && err.reason === 'NOT_OWNED'
  );
});

test('HOSTILE_BUYOUT: drops any live trade offering the property it just seized, instead of leaving it advertising an asset its side no longer owns', () => {
  const staleTrade = {
    id: 'trade-1',
    roomId: 'r1',
    proposerId: 'gp-bob',
    targetId: 'gp-alice',
    proposerOffer: { properties: ['p10'], money: 0 }, // Bob offers the very property about to be seized
    targetOffer: { properties: [], money: 100 },
    status: 'PROPOSED',
    counterDepth: 0,
    previousTradeId: null,
    createdAt: '2026-08-25T00:00:00.000Z',
  };
  const state = {
    ...baseGameState(),
    phase: 'POST_ACTIONS',
    pendingHostileBuyoutPropertyId: 'p10',
    pendingTrades: [staleTrade],
  };

  const { gameState } = transitionTurn(state, board, { type: 'HOSTILE_BUYOUT' });

  assert.equal(gameState.properties.find((p) => p.id === 'p10').ownerId, 'gp-alice'); // seized
  assert.equal(gameState.pendingTrades.length, 0); // and the now-impossible trade is gone
});

// ---- C08 "Bảo Vệ Tài Sản" (card deck v2, 2026-08-25) ----

function drawC08(overrides = {}) {
  const base = baseGameState({ eventDeck: ['C08_BAO_VE_TAI_SAN', 'DIVIDEND_50'] });
  return { ...base, phase: 'ROLLING', ...overrides };
}

// C08 became `keepable` with the Card Inventory system (2026-08-27), so it
// is banked on draw and its "which property?" decision is made later through
// USE_INVENTORY_CARD rather than AWAITING_EVENT_CHOICE. Shared by the tests
// below (updated 2026-09-01) so the two-step flow is written once.
function drawAndHoldC08(overrides = {}) {
  const { gameState } = transitionTurn(drawC08(overrides), board, { type: 'ROLL_DICE', payload: roll(1, 2) }); // lands on chance -> draws C08
  assert.equal(gameState.phase, 'POST_ACTIONS');
  assert.deepEqual(gameState.players.find((p) => p.id === 'gp-alice').inventory, ['C08_BAO_VE_TAI_SAN']);
  return gameState;
}

function playC08(state, propertyId) {
  return transitionTurn(state, board, {
    type: 'USE_INVENTORY_CARD',
    payload: { playerId: 'gp-alice', cardId: 'C08_BAO_VE_TAI_SAN', optionId: 'OPT_PROTECT', propertyId },
  });
}

test('C08: protecting an unimproved property blocks HOSTILE_BUYOUT on it until the owner’s next round', () => {
  // Bob owns p10 unimproved; give it to Alice so she can protect it, then
  // have Bob try to seize it.
  let state = drawAndHoldC08({
    properties: baseGameState().properties.map((p) => (p.id === 'p10' ? { ...p, ownerId: 'gp-alice' } : p)),
  });

  ({ gameState: state } = playC08(state, 'p10'));
  assert.equal(state.propertyProtection.propertyId, 'p10');
  assert.equal(state.propertyProtection.ownerId, 'gp-alice');
  assert.deepEqual(state.players.find((p) => p.id === 'gp-alice').inventory, [], 'the card is consumed');

  // Bob, on his own turn, tries to seize the protected property.
  const bobsAttempt = { ...state, currentTurnIndex: 1, phase: 'POST_ACTIONS', pendingHostileBuyoutPropertyId: 'p10' };
  assert.throws(
    () => transitionTurn(bobsAttempt, board, { type: 'HOSTILE_BUYOUT' }),
    (err) => err instanceof InvalidPropertyActionError && err.reason === 'CARD_PROTECTED'
  );

  // Once the owner's next round begins, the protection lapses and the same
  // seizure succeeds — the card buys exactly one round, not permanence.
  const laterRound = { ...bobsAttempt, roundNumber: state.propertyProtection.grantedAtRound + 1 };
  const { gameState: seized } = transitionTurn(laterRound, board, { type: 'HOSTILE_BUYOUT' });
  assert.equal(seized.properties.find((p) => p.id === 'p10').ownerId, 'gp-bob');
});

test('C08: building on the protected property ends the protection early — HOUSE_PROTECTED takes over permanently', () => {
  const state = {
    ...baseGameState(),
    phase: 'POST_ACTIONS',
    properties: baseGameState().properties.map((p) => (p.id === 'p1' ? { ...p, ownerId: 'gp-alice' } : p)),
    propertyProtection: { propertyId: 'p1', ownerId: 'gp-alice', grantedAtRound: 0 },
  };
  const { gameState } = transitionTurn(state, board, { type: 'BUILD_HOUSE', payload: { propertyId: 'p1' } });
  assert.equal(gameState.propertyProtection, null);
  assert.equal(gameState.properties.find((p) => p.id === 'p1').upgradeLevel, 1);
});

test('C08: an already-improved property cannot be chosen — it is permanently immune anyway', () => {
  let state = drawC08({
    properties: baseGameState().properties.map((p) => (p.id === 'p10' ? { ...p, ownerId: 'gp-alice', upgradeLevel: 2 } : p)),
  });
  ({ gameState: state } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 2) }));
  // Alice's only holding is improved, so the card is ineligible entirely and
  // resolves as a revealed no-op rather than a blocking choice.
  assert.notEqual(state.phase, 'AWAITING_EVENT_CHOICE');
  assert.equal(state.propertyProtection, null);
});

test('C08: naming a property you do not own is rejected (NOT_PROTECTABLE)', () => {
  const state = drawAndHoldC08({
    properties: baseGameState().properties.map((p) => (p.id === 'p1' ? { ...p, ownerId: 'gp-alice' } : p)),
  });
  assert.throws(
    () => playC08(state, 'p10'), // Bob's
    (err) => err instanceof InvalidPropertyActionError && err.reason === 'NOT_PROTECTABLE'
  );
});

// Caught by fuzzing this card the day it was written. Trades are
// phase-independent, so a protected property can change hands while the
// protection is still live — the shield must NOT travel with it.
test('C08: protection does not follow the property to a new owner (a trade cannot launder a free shield)', () => {
  const state = {
    ...baseGameState(),
    phase: 'POST_ACTIONS',
    roundNumber: 3,
    currentTurnIndex: 1, // Bob's turn
    // Alice protected p10 this round, then it moved to Bob (by trade).
    properties: baseGameState().properties.map((p) => (p.id === 'p10' ? { ...p, ownerId: 'gp-bob' } : p)),
    propertyProtection: { propertyId: 'p10', ownerId: 'gp-alice', grantedAtRound: 3 },
    pendingHostileBuyoutPropertyId: 'p10',
  };
  // Bob now owns it, so he cannot buy it out from himself — but the point is
  // that the stale protection must not be what stops anything. Put it back in
  // Alice's hands as an attacker-facing check instead:
  const attackerView = {
    ...state,
    currentTurnIndex: 0, // Alice's turn
    properties: state.properties.map((p) => (p.id === 'p10' ? { ...p, ownerId: 'gp-bob' } : p)),
  };
  // Alice's own protection named p10 while SHE owned it; Bob owns it now, so
  // the shield is void and her buyout must go through.
  const { gameState } = transitionTurn(attackerView, board, { type: 'HOSTILE_BUYOUT' });
  assert.equal(gameState.properties.find((p) => p.id === 'p10').ownerId, 'gp-alice');
});

test('C08: a bankrupt owner’s protection is cleared, never left shielding a property they no longer hold', () => {
  const state = {
    ...baseGameState(),
    phase: 'ROLLING',
    players: baseGameState().players.map((p) => (p.id === 'gp-alice' ? { ...p, currentBalance: 10 } : p)),
    propertyProtection: { propertyId: 'p1', ownerId: 'gp-alice', grantedAtRound: 0 },
  };
  const { gameState } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(3, 2) }, '2026-08-25T00:00:00.000Z'); // tax tile, bankrupts her
  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').bankrupt, true);
  assert.equal(gameState.propertyProtection, null);
});

test('HOSTILE_BUYOUT: rejected with NO_PENDING_BUYOUT when nothing is currently eligible', () => {
  const state = { ...baseGameState(), phase: 'POST_ACTIONS', pendingHostileBuyoutPropertyId: null };
  assert.throws(
    () => transitionTurn(state, board, { type: 'HOSTILE_BUYOUT' }),
    (err) => err instanceof InvalidPropertyActionError && err.reason === 'NO_PENDING_BUYOUT'
  );
});

test('HOSTILE_BUYOUT: rejected with INSUFFICIENT_BALANCE when the current player cannot afford 2.0x', () => {
  const state = {
    ...baseGameState({
      players: baseGameState().players.map((p) => (p.id === 'gp-alice' ? { ...p, currentBalance: 50 } : p)), // 2x100 = 200 needed
    }),
    phase: 'POST_ACTIONS',
    pendingHostileBuyoutPropertyId: 'p10',
  };
  assert.throws(
    () => transitionTurn(state, board, { type: 'HOSTILE_BUYOUT' }),
    (err) => err instanceof InvalidPropertyActionError && err.reason === 'INSUFFICIENT_BALANCE'
  );
});

test('pendingHostileBuyoutPropertyId is cleared on END_TURN even if the window was never used', () => {
  const state = { ...baseGameState(), phase: 'POST_ACTIONS', pendingHostileBuyoutPropertyId: 'p10' };
  const { gameState } = transitionTurn(state, board, { type: 'END_TURN' });
  assert.equal(gameState.pendingHostileBuyoutPropertyId, null);
});

// --- FORFEIT_MATCH (2026-08-23) ---

// A 3rd player (Carol) so an ordinary forfeit doesn't itself trigger
// elimination — checkElimination fires the instant only one non-bankrupt
// real player remains, which a plain 2-player baseGameState() always would
// on ANY forfeit. These tests are about the turn/phase/transaction
// mechanics of an ordinary forfeit, not about elimination itself (that has
// its own dedicated 2-player test below).
function threePlayerBase(overrides = {}) {
  const state = baseGameState(overrides);
  state.players.push(createPlayerGameState({ id: 'gp-carol', gameId: 'g1', playerId: 'carol', turnOrder: 2, currentBalance: 1500 }));
  return state;
}

test('FORFEIT_MATCH: a non-current player forfeits — bankrupted to the Bank, their turn/phase left untouched', () => {
  const state = { ...threePlayerBase(), phase: 'POST_ACTIONS' }; // alice (turnOrder 0) is current
  const { gameState, transactions } = transitionTurn(state, board, {
    type: 'FORFEIT_MATCH',
    payload: { playerId: 'gp-bob' },
  });

  const bob = gameState.players.find((p) => p.id === 'gp-bob');
  assert.equal(bob.bankrupt, true);
  assert.equal(bob.currentBalance, 0);
  assert.equal(gameState.properties.find((p) => p.id === 'p10').ownerId, null); // Bob's owned property reverts to the Bank
  assert.equal(gameState.phase, 'POST_ACTIONS'); // alice's turn, completely unaffected
  assert.equal(gameState.currentTurnIndex, 0);
  assert.equal(transactions.length, 1);
  assert.deepEqual(
    { from: transactions[0].fromGamePlayerId, to: transactions[0].toGamePlayerId, amount: transactions[0].amount, type: transactions[0].transactionType },
    { from: 'gp-bob', to: 'gp-bank', amount: 1500, type: 'bankruptcy_transfer' }
  );
});

test('FORFEIT_MATCH: bypasses VALID_ACTIONS_BY_PHASE entirely — legal even during ROLLING, and force-advances the turn when the forfeiter held it', () => {
  const state = { ...threePlayerBase(), phase: 'ROLLING' }; // alice is current; FORFEIT_MATCH isn't in ROLLING's own allowed-action list
  const { gameState } = transitionTurn(state, board, {
    type: 'FORFEIT_MATCH',
    payload: { playerId: 'gp-alice' },
  });

  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').bankrupt, true);
  // Bob (turnOrder 1) inherits the turn immediately — no lingering "someone
  // has to click End Turn for the player who just left" gap.
  assert.equal(gameState.currentTurnIndex, 1);
  assert.equal(gameState.phase, 'ROLLING'); // startTurn() for Bob, who isn't in jail
});

test('FORFEIT_MATCH: a forfeiting current player never hands the vacant seat a doubles bonus turn', () => {
  const state = { ...threePlayerBase(), phase: 'POST_ACTIONS', lastRollWasDouble: true };
  const { gameState } = transitionTurn(state, board, { type: 'FORFEIT_MATCH', payload: { playerId: 'gp-alice' } });
  assert.equal(gameState.currentTurnIndex, 1); // moved on to Bob, not replayed for the now-bankrupt Alice
  assert.equal(gameState.phase, 'ROLLING');
});

test('FORFEIT_MATCH: settles a live LIQUIDATION_REQUIRED debt with the real creditor, not the Bank, and still advances the turn', () => {
  const threePlayers = baseGameState();
  threePlayers.players.push(
    createPlayerGameState({ id: 'gp-carol', gameId: 'g1', playerId: 'carol', turnOrder: 2, currentBalance: 1500 })
  );
  const state = {
    ...threePlayers,
    phase: 'LIQUIDATION_REQUIRED',
    pendingLiquidation: { debtorId: 'gp-alice', creditorId: 'gp-carol', amount: 200, transactionType: 'rent' },
  };
  state.players[1] = { ...state.players[1], currentBalance: 500 }; // alice — real invariant: LIQUIDATION_REQUIRED's debtor is always the current player (turnOrder 0)

  const { gameState, transactions } = transitionTurn(state, board, {
    type: 'FORFEIT_MATCH',
    payload: { playerId: 'gp-alice' },
  });

  assert.equal(gameState.pendingLiquidation, null);
  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').bankrupt, true);
  assert.equal(gameState.players.find((p) => p.id === 'gp-carol').currentBalance, 1500 + 500); // the real creditor, not the Bank
  assert.equal(gameState.players.find((p) => p.id === 'gp-bank').currentBalance, 20000); // untouched
  assert.equal(gameState.currentTurnIndex, 1); // Bob inherits the turn
  assert.ok(transactions.some((t) => t.toGamePlayerId === 'gp-carol' && t.amount === 500 && t.transactionType === 'bankruptcy_transfer'));
});

// Rewritten 2026-08-25 (was: "resolves a pending RENT_RISK_DECISION to
// STANDARD first when the forfeiter is the deciding owner") — there is no
// longer a blocking decision to resolve on the forfeiter's behalf; an
// unclaimed pendingRentGamble is simply dropped by applyBankruptcy()'s own
// cleanup, the same way an unclaimed trade/auction seat already was.
test('FORFEIT_MATCH: an unclaimed pendingRentGamble is simply dropped when its owner forfeits — nothing is resolved on their behalf', () => {
  const state = {
    ...threePlayerBase(), // Carol is a bystander here — without her, Bob forfeiting would leave only Alice and end the match, confounding this test's own phase/turn assertions
    phase: 'POST_ACTIONS',
    pendingRentGamble: { propertyId: 'p10', ownerId: 'gp-bob', payerId: 'gp-alice', amount: 50 }, // Bob already collected this; it's just sitting there unclaimed
  };

  const { gameState, transactions } = transitionTurn(state, board, {
    type: 'FORFEIT_MATCH',
    payload: { playerId: 'gp-bob' },
  });

  assert.equal(gameState.pendingRentGamble, null); // dropped, not resolved
  const bob = gameState.players.find((p) => p.id === 'gp-bob');
  const alice = gameState.players.find((p) => p.id === 'gp-alice');
  assert.equal(bob.bankrupt, true);
  assert.equal(alice.currentBalance, 1500); // completely untouched — Alice's own rent had already settled long before this forfeit, same as every other Gamble outcome
  assert.equal(gameState.properties.find((p) => p.id === 'p10').ownerId, null); // Bob's own property still reverts, an ordinary voluntary bankruptcy
  // Bob wasn't the current player (Alice is) — her own turn/phase is left
  // completely untouched, not force-advanced.
  assert.equal(gameState.phase, 'POST_ACTIONS');
  assert.equal(gameState.currentTurnIndex, 0);
  // Only Bob's own forfeiture-to-the-Bank transaction — no rent/gamble
  // transaction of any kind, since there was nothing left to resolve.
  assert.equal(transactions.length, 1);
  assert.ok(transactions.some((t) => t.transactionType === 'bankruptcy_transfer' && t.toGamePlayerId === 'gp-bank'));
});

test('FORFEIT_MATCH: removes the forfeiter from an active auction without settling it early, when other bidders remain', () => {
  const state = threeBidderAuctionState(); // FLASH_AUCTION_ACTIVE, activeBidders bob/carol/dave; alice hosts and is current
  const { gameState } = transitionTurn(state, board, { type: 'FORFEIT_MATCH', payload: { playerId: 'gp-carol' } });

  assert.equal(gameState.players.find((p) => p.id === 'gp-carol').bankrupt, true);
  assert.equal(gameState.phase, 'FLASH_AUCTION_ACTIVE'); // still 2 active bidders — not force-settled
  assert.deepEqual(gameState.pendingAuction.activeBidders, ['gp-bob', 'gp-dave']);
  assert.equal(gameState.currentTurnIndex, 0); // Carol wasn't the current player — Alice's turn is untouched
});

test('FORFEIT_MATCH: the second-to-last player forfeiting ends the match immediately (elimination win)', () => {
  const state = { ...baseGameState(), phase: 'POST_ACTIONS' }; // alice current, bob not
  const { gameState } = transitionTurn(state, board, { type: 'FORFEIT_MATCH', payload: { playerId: 'gp-bob' } });

  assert.equal(gameState.status, 'finished');
  assert.equal(gameState.phase, null);
  assert.equal(gameState.endReason, 'elimination');
  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').finalRank, 1);
});

// The test above has the NON-current player forfeit. This is the other half,
// and the one a real player actually hits: at a 2-player table you press
// "Đầu Hàng" on your own turn. resolveForfeit takes its `wasCurrentPlayer`
// branch here, so it is genuinely different code — and it was untested while a
// user-reported bug ("ấn đầu hàng nhưng không kết thúc ván đấu") pointed
// straight at it. The engine turned out to be correct in both branches; the
// defect was in ForfeitButton.jsx, which threw the finished state away before
// GameOverScreen could render it. Pinning the engine half so a future change
// cannot quietly make the report true.
test('FORFEIT_MATCH: the CURRENT player forfeiting with one opponent left also ends the match immediately', () => {
  const state = { ...baseGameState(), phase: 'POST_ACTIONS' }; // alice is the current player
  const { gameState } = transitionTurn(state, board, { type: 'FORFEIT_MATCH', payload: { playerId: 'gp-alice' } });

  assert.equal(gameState.status, 'finished');
  assert.equal(gameState.phase, null);
  assert.equal(gameState.endReason, 'elimination');
  assert.equal(gameState.players.find((p) => p.id === 'gp-bob').finalRank, 1); // the survivor wins
  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').finalRank, 2);
  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').bankrupt, true);
});

test('FORFEIT_MATCH: rejects a non-existent player, an already-bankrupt player, and the sole remaining player', () => {
  const base = { ...baseGameState(), phase: 'POST_ACTIONS' };

  assert.throws(
    () => transitionTurn(base, board, { type: 'FORFEIT_MATCH', payload: { playerId: 'gp-nobody' } }),
    (err) => err instanceof InvalidForfeitError && err.reason === 'NOT_A_PLAYER'
  );
  assert.throws(
    () => transitionTurn(base, board, { type: 'FORFEIT_MATCH', payload: { playerId: 'gp-bank' } }),
    (err) => err instanceof InvalidForfeitError && err.reason === 'NOT_A_PLAYER'
  );

  const bobAlreadyGone = { ...base, players: base.players.map((p) => (p.id === 'gp-bob' ? { ...p, bankrupt: true } : p)) };
  assert.throws(
    () => transitionTurn(bobAlreadyGone, board, { type: 'FORFEIT_MATCH', payload: { playerId: 'gp-bob' } }),
    (err) => err instanceof InvalidForfeitError && err.reason === 'ALREADY_ELIMINATED'
  );
  assert.throws(
    () => transitionTurn(bobAlreadyGone, board, { type: 'FORFEIT_MATCH', payload: { playerId: 'gp-alice' } }),
    (err) => err instanceof InvalidForfeitError && err.reason === 'SOLE_SURVIVOR'
  );
});

// --- Phase 4: C01 (Lối Tắt / MOVE_RELATIVE), C02 (Chuyến Đi May Mắn /
// MOVE_TO_NEAREST_UNOWNED_PROPERTY), C05 (Cơ Hội Đầu Tư) and C11 (Cú Đánh
// Liều) — both DIE_FACE_REWARD tables.

test('MAKE_EVENT_CHOICE (C01): MOVE_RELATIVE moves exactly `steps` tiles and resolves the destination landing for real', () => {
  const state = {
    ...baseGameState(),
    phase: 'AWAITING_EVENT_CHOICE',
    pendingEventCardId: 'C01_LOI_TAT',
  };
  const { gameState, transactions } = transitionTurn(state, board, {
    type: 'MAKE_EVENT_CHOICE',
    payload: { optionId: 'OPT_2_TILES' }, // 0 + 2 -> Station A (unowned transport)
  });

  const alice = gameState.players.find((p) => p.id === 'gp-alice');
  assert.equal(alice.currentPosition, 2);
  assert.equal(gameState.phase, 'AWAITING_PURCHASE'); // real landing resolution, not a bare teleport
  assert.equal(alice.currentBalance, 1500); // no PASS_GO crossed, no purchase made yet
  assert.equal(transactions.length, 0);
});

test('MAKE_EVENT_CHOICE (C01): OPT_1_TILE (a single-tile move) does not throw — below a real dice total\'s own 2-12 minimum', () => {
  const state = {
    ...baseGameState(),
    phase: 'AWAITING_EVENT_CHOICE',
    pendingEventCardId: 'C01_LOI_TAT',
  };
  const { gameState } = transitionTurn(state, board, {
    type: 'MAKE_EVENT_CHOICE',
    payload: { optionId: 'OPT_1_TILE' }, // 0 + 1 -> Brown Ave 1
  });
  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentPosition, 1);
});

test('MAKE_EVENT_CHOICE (C01): MOVE_RELATIVE credits PASS_GO_SALARY normally when the move wraps past GO', () => {
  const state = {
    ...baseGameState(),
    phase: 'AWAITING_EVENT_CHOICE',
    pendingEventCardId: 'C01_LOI_TAT',
  };
  state.players[1] = { ...state.players[1], currentPosition: 34 };
  const { gameState, transactions } = transitionTurn(state, board, {
    type: 'MAKE_EVENT_CHOICE',
    payload: { optionId: 'OPT_3_TILES' }, // 34 + 3 = 37 -> wraps to 1
  });

  const alice = gameState.players.find((p) => p.id === 'gp-alice');
  assert.equal(alice.currentPosition, 1);
  assert.equal(gameState.phase, 'AWAITING_PURCHASE');
  assert.equal(alice.currentBalance, 1500 + 200);
  assert.ok(transactions.some((t) => t.transactionType === 'pass_go_salary' && t.amount === 200));
});

test('DRAWING_CARD (C02): MOVE_TO_NEAREST_UNOWNED_PROPERTY finds the first unowned buyable tile ahead', () => {
  const state = { ...baseGameState({ eventDeck: ['C02_CHUYEN_DI_MAY_MAN', 'DIVIDEND_50', 'INVESTMENT_OPPORTUNITY'] }), phase: 'ROLLING' };
  // total 3 -> Chance (position 3); nearest unowned buyable ahead is Electric Co (position 6: jail/tax are non-buyable, skipped)
  const { gameState, transactions } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 2) });

  const alice = gameState.players.find((p) => p.id === 'gp-alice');
  assert.equal(alice.currentPosition, 6);
  assert.equal(gameState.phase, 'AWAITING_PURCHASE');
  assert.equal(gameState.lastDrawnEventCardId, 'C02_CHUYEN_DI_MAY_MAN');
  assert.equal(transactions.length, 0);
});

test('DRAWING_CARD (C02): skips already-owned tiles to find a further unowned one', () => {
  const state = {
    ...baseGameState({ eventDeck: ['C02_CHUYEN_DI_MAY_MAN', 'DIVIDEND_50', 'INVESTMENT_OPPORTUNITY'] }),
    properties: baseGameState().properties.map((p) => (p.id === 'p6' ? { ...p, ownerId: 'gp-bob' } : p)),
    phase: 'ROLLING',
  };
  // From Chance (position 3): Electric Co (6) now owned, Owned Property (10) already owned -> Filler 11 is first unowned
  const { gameState } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 2) });
  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentPosition, 11);
});

test('DRAWING_CARD (C02): a genuine no-op when no unowned buyable tile exists anywhere on the board', () => {
  const allOwned = baseGameState().properties.map((p) => ({ ...p, ownerId: 'gp-bob' }));
  const state = {
    ...baseGameState({ eventDeck: ['C02_CHUYEN_DI_MAY_MAN', 'DIVIDEND_50', 'INVESTMENT_OPPORTUNITY'] }),
    properties: allOwned,
    phase: 'ROLLING',
  };
  const { gameState, transactions } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 2) });

  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentPosition, 3); // stays where the dice roll landed
  assert.equal(gameState.phase, 'POST_ACTIONS');
  assert.equal(transactions.length, 0);
});

test('MAKE_EVENT_CHOICE (C05): OPT_SAFE pays the flat amount, no dice involved', () => {
  const state = { ...baseGameState(), phase: 'AWAITING_EVENT_CHOICE', pendingEventCardId: 'C05_CO_HOI_DAU_TU' };
  const { gameState } = transitionTurn(state, board, { type: 'MAKE_EVENT_CHOICE', payload: { optionId: 'OPT_SAFE' } });
  assert.equal(gameState.phase, 'POST_ACTIONS');
  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentBalance, 1500 + 100);
});

test('MAKE_EVENT_CHOICE (C05): OPT_RISK resolves each tier of the die-face reward table', () => {
  const faceOutcomes = [
    [1, 0],
    [3, 150],
    [4, 150],
    [5, 200],
    [6, 300],
  ];
  for (const [dieFaceRoll, expectedGain] of faceOutcomes) {
    const state = { ...baseGameState(), phase: 'AWAITING_EVENT_CHOICE', pendingEventCardId: 'C05_CO_HOI_DAU_TU' };
    const { gameState } = transitionTurn(state, board, {
      type: 'MAKE_EVENT_CHOICE',
      payload: { optionId: 'OPT_RISK', dieFaceRoll },
    });
    assert.equal(
      gameState.players.find((p) => p.id === 'gp-alice').currentBalance,
      1500 + expectedGain,
      `face ${dieFaceRoll} should net +${expectedGain}`
    );
  }
});

test('MAKE_EVENT_CHOICE (C11): OPT_GAMBLE always deducts the $50 stake, then resolves the die-face table on top', () => {
  const faceOutcomes = [
    [1, -50 - 100],
    [2, -50],
    [4, -50 + 100],
    [6, -50 + 300],
  ];
  for (const [dieFaceRoll, expectedDelta] of faceOutcomes) {
    const state = { ...baseGameState(), phase: 'AWAITING_EVENT_CHOICE', pendingEventCardId: 'C11_CU_DANH_LIEU' };
    const { gameState } = transitionTurn(state, board, {
      type: 'MAKE_EVENT_CHOICE',
      payload: { optionId: 'OPT_GAMBLE', dieFaceRoll },
    });
    assert.equal(
      gameState.players.find((p) => p.id === 'gp-alice').currentBalance,
      1500 + expectedDelta,
      `face ${dieFaceRoll} should net ${expectedDelta}`
    );
  }
});

// REVISED 2026-09-02. This used to assert that OPT_GAMBLE *throws* when the
// player cannot afford the $50 stake — which was true, and was precisely the
// deadlock: OPT_GAMBLE is C11's ONLY option, MAKE_EVENT_CHOICE is
// AWAITING_EVENT_CHOICE's ONLY action, and the phase timeout synthesized the
// same rejected choice, so the room froze with its timer already cleared.
// A card nobody can afford now fizzles to a no-op instead. See
// handleEventChoice's DEADLOCK ESCAPE comment and the general-case pair of
// tests next to the other MAKE_EVENT_CHOICE cases above.
test('MAKE_EVENT_CHOICE (C11): its single unaffordable option fizzles to POST_ACTIONS rather than deadlocking the phase', () => {
  const state = {
    ...baseGameState({
      players: baseGameState().players.map((p) => (p.id === 'gp-alice' ? { ...p, currentBalance: 10 } : p)),
    }),
    phase: 'AWAITING_EVENT_CHOICE',
    pendingEventCardId: 'C11_CU_DANH_LIEU',
  };
  const { gameState, transactions } = transitionTurn(state, board, {
    type: 'MAKE_EVENT_CHOICE',
    payload: { optionId: 'OPT_GAMBLE', dieFaceRoll: 4 },
  });

  assert.equal(gameState.phase, 'POST_ACTIONS');
  assert.equal(gameState.pendingEventCardId, null);
  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentBalance, 10); // no stake taken
  assert.equal(transactions.length, 0);
});

test('MAKE_EVENT_CHOICE: a DIE_FACE_REWARD option without a valid dieFaceRoll throws', () => {
  const state = { ...baseGameState(), phase: 'AWAITING_EVENT_CHOICE', pendingEventCardId: 'C05_CO_HOI_DAU_TU' };
  assert.throws(() => transitionTurn(state, board, { type: 'MAKE_EVENT_CHOICE', payload: { optionId: 'OPT_RISK' } }), TypeError);
  assert.throws(
    () => transitionTurn(state, board, { type: 'MAKE_EVENT_CHOICE', payload: { optionId: 'OPT_RISK', dieFaceRoll: 7 } }),
    TypeError
  );
});

// ============================================================
// The C11 hard deadlock (2026-08-23) — found while wiring finding #35's
// AWAITING_EVENT_CHOICE timer, and strictly worse than the missing timer:
// C11_CU_DANH_LIEU is the deck's only single-option CHOICE card, and that
// option requires $50. A player below $50 who drew it reached
// AWAITING_EVENT_CHOICE, where MAKE_EVENT_CHOICE is the only legal action
// and its only possible option was rejected for insufficient balance —
// leaving NO legal move for anyone at the table, the drawer included, with
// FORFEIT_MATCH the sole escape. Closed by giving the card a real
// eligibility gate, so it is never offered to someone who cannot play it.
// ============================================================

test('C11 deadlock: a player below $50 who draws C11 gets a revealed no-op, never the unplayable blocking phase', () => {
  const poor = baseGameState({ eventDeck: ['C11_CU_DANH_LIEU', 'DIVIDEND_50', 'INVESTMENT_OPPORTUNITY'] });
  const players = poor.players.map((p) => (p.id === 'gp-alice' ? { ...p, currentBalance: 49 } : p));
  const state = { ...poor, players, phase: 'ROLLING' };

  const { gameState, transactions } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 2) }); // total 3 -> Chance tile

  // The card is still genuinely drawn and revealed to everyone (that's what
  // cardEligible's revealed-no-op contract is for) — it simply has no effect.
  assert.equal(gameState.lastDrawnEventCardId, 'C11_CU_DANH_LIEU');
  assert.notEqual(gameState.phase, 'AWAITING_EVENT_CHOICE'); // the deadlock state itself
  assert.equal(gameState.phase, 'POST_ACTIONS');
  assert.equal(gameState.pendingEventCardId, null); // nothing is waiting on a choice nobody could make
  assert.equal(transactions.length, 0); // no money moved — the $50 stake was never taken
  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentBalance, 49);
});

test('C11 deadlock: a player who CAN afford the $50 stake still gets the real choice, unchanged', () => {
  const rich = baseGameState({ eventDeck: ['C11_CU_DANH_LIEU', 'DIVIDEND_50', 'INVESTMENT_OPPORTUNITY'] });
  const players = rich.players.map((p) => (p.id === 'gp-alice' ? { ...p, currentBalance: 50 } : p)); // exactly the boundary
  const state = { ...rich, players, phase: 'ROLLING' };

  const { gameState } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(1, 2) });

  assert.equal(gameState.phase, 'AWAITING_EVENT_CHOICE'); // the gate is >= 50, not > 50
  assert.equal(gameState.pendingEventCardId, 'C11_CU_DANH_LIEU');
});

test('finding #37: lastRollSeq increments only on a real roll, and survives a pre-fix snapshot without becoming NaN', () => {
  // DiceRoll.jsx keys its tumble animation off this instead of stateVersion,
  // which bumps on every action anyone takes while lastRoll sits unchanged
  // for the rest of the turn.
  const state = { ...baseGameState(), phase: 'ROLLING' };
  const first = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(3, 4) });
  assert.equal(first.gameState.lastRollSeq, 1);
  assert.deepEqual(first.gameState.lastRoll, { die1: 3, die2: 4, total: 7, isDouble: false });

  // A non-roll action in the same turn must NOT advance it — that was the bug.
  const afterOther = transitionTurn(first.gameState, board, { type: 'END_TURN' });
  assert.equal(afterOther.gameState.lastRollSeq, 1);

  // Same faces rolled again still counts as a new roll — the exact case a
  // naive `${die1}-${die2}` frontend key would have missed.
  const rolling = { ...afterOther.gameState, phase: 'ROLLING' };
  const second = transitionTurn(rolling, board, { type: 'ROLL_DICE', payload: roll(3, 4) });
  assert.equal(second.gameState.lastRollSeq, 2);

  // A match restored from a pre-fix snapshot has no such field at all —
  // gameRepository.js returns raw JSONB, bypassing createGameState()'s default.
  const restored = { ...baseGameState(), phase: 'ROLLING' };
  delete restored.lastRollSeq;
  const fromOld = transitionTurn(restored, board, { type: 'ROLL_DICE', payload: roll(2, 5) });
  assert.equal(fromOld.gameState.lastRollSeq, 1);
  assert.ok(Number.isInteger(fromOld.gameState.lastRollSeq));
});

// ---- USE_INVENTORY_CARD hardening (bug sweep, 2026-09-01) ----
//
// Four real defects found by reading the Card Inventory handler against the
// rest of the codebase, each reproduced before being fixed. All four are
// regression-tested here; each assertion below fails against the pre-fix
// handler (verified), so none of them guard nothing.

function handState(inventory, overrides = {}) {
  const base = baseGameState();
  return {
    ...base,
    phase: 'POST_ACTIONS',
    players: base.players.map((p) => (p.id === 'gp-alice' ? { ...p, inventory } : p)),
    ...overrides,
  };
}

test('USE_INVENTORY_CARD: a match restored from a pre-2026-08-27 snapshot (no `inventory` field) is rejected cleanly, not with a TypeError', () => {
  // gameRepository.loadGameStateFromSupabase returns the raw JSONB blob and
  // deliberately never re-runs it through createPlayerGameState, so the
  // factory's `inventory: []` default does not apply to a match that was
  // already in progress when the Card Inventory system shipped. The handler
  // did a bare `player.inventory.includes(...)` and crashed every such game.
  const restored = handState([]);
  restored.players = restored.players.map((p) => {
    const copy = { ...p };
    delete copy.inventory;
    return copy;
  });

  assert.throws(
    () =>
      transitionTurn(restored, board, {
        type: 'USE_INVENTORY_CARD',
        payload: { playerId: 'gp-alice', cardId: 'C07_GIAM_GIA_XAY_DUNG' },
      }),
    (err) => err instanceof InvalidInventoryActionError && err.reason === 'CARD_NOT_HELD'
  );
});

test('USE_INVENTORY_CARD: a non-keepable card sitting in a hand cannot be played from it', () => {
  // The handler gated on inventory membership rather than on the card's own
  // `keepable` flag, so any card that ever reached a hand stayed playable —
  // out of turn and out of phase. Reproduced live: K12 (a tax card) resolved
  // its full charge from the hand.
  const sneaky = handState(['K12_NGAY_THUE']);
  assert.throws(
    () =>
      transitionTurn(sneaky, board, {
        type: 'USE_INVENTORY_CARD',
        payload: { playerId: 'gp-alice', cardId: 'K12_NGAY_THUE' },
      }),
    (err) => err instanceof InvalidInventoryActionError && err.reason === 'CARD_NOT_KEEPABLE'
  );
});

test('USE_INVENTORY_CARD: a bankrupt player cannot play a held card', () => {
  // This action is turn-independent as of 2026-09-01, so the turn gate that
  // implicitly kept eliminated players out of every other action no longer
  // applies — the same class of hole the trade path was hardened against on
  // 2026-08-25 (a bankrupt player acting via a turn-independent action).
  const dead = handState(['C07_GIAM_GIA_XAY_DUNG']);
  dead.players = dead.players.map((p) => (p.id === 'gp-alice' ? { ...p, bankrupt: true } : p));

  assert.throws(
    () =>
      transitionTurn(dead, board, {
        type: 'USE_INVENTORY_CARD',
        payload: { playerId: 'gp-alice', cardId: 'C07_GIAM_GIA_XAY_DUNG' },
      }),
    (err) => err instanceof InvalidInventoryActionError && err.reason === 'PLAYER_BANKRUPT'
  );
});

test('USE_INVENTORY_CARD: an unknown playerId is a clean domain rejection, not a TypeError', () => {
  assert.throws(
    () =>
      transitionTurn(handState(['C07_GIAM_GIA_XAY_DUNG']), board, {
        type: 'USE_INVENTORY_CARD',
        payload: { playerId: 'gp-ghost', cardId: 'C07_GIAM_GIA_XAY_DUNG' },
      }),
    (err) => err instanceof InvalidInventoryActionError && err.reason === 'NOT_A_PARTICIPANT'
  );
});

test('USE_INVENTORY_CARD is genuinely playable out of turn (it is phase- and turn-independent)', () => {
  // Bob holds a card while it is ALICE's turn, in a phase whose
  // VALID_ACTIONS_BY_PHASE entry does not list this action at all.
  const base = baseGameState();
  const state = {
    ...base,
    phase: 'ROLLING', // Alice's turn, mid-roll — nothing about this phase admits USE_INVENTORY_CARD
    currentTurnIndex: 0,
    players: base.players.map((p) => (p.id === 'gp-bob' ? { ...p, inventory: ['C07_GIAM_GIA_XAY_DUNG'] } : p)),
  };

  const { gameState } = transitionTurn(state, board, {
    type: 'USE_INVENTORY_CARD',
    payload: { playerId: 'gp-bob', cardId: 'C07_GIAM_GIA_XAY_DUNG' },
  });
  assert.equal(gameState.players.find((p) => p.id === 'gp-bob').nextBuildDiscount, 50);
  assert.equal(gameState.phase, 'ROLLING', 'playing a held card must not disturb whatever the table was doing');
  assert.equal(gameState.currentTurnIndex, 0, 'and must not steal the turn');
});

test('bankruptcy leaves an eliminated player holding no cards of any kind', () => {
  // Cash and properties transfer, pending trades drop, an active auction
  // folds them out — `inventory` and `jailFreeCards` were the one asset
  // class still left behind on an eliminated player.
  const base = baseGameState();
  const state = {
    ...base,
    phase: 'POST_ACTIONS',
    players: base.players.map((p) =>
      p.id === 'gp-alice' ? { ...p, currentBalance: 5, inventory: ['C07_GIAM_GIA_XAY_DUNG'], jailFreeCards: 2 } : p
    ),
    // A debt Alice provably cannot cover and has nothing to liquidate for.
    properties: base.properties.map((p) => ({ ...p, ownerId: p.ownerId === 'gp-alice' ? null : p.ownerId })),
  };

  // Drive a real forfeit, which routes through the same applyBankruptcy.
  const { gameState } = transitionTurn(state, board, { type: 'FORFEIT_MATCH', payload: { playerId: 'gp-alice' } });
  const alice = gameState.players.find((p) => p.id === 'gp-alice');
  assert.equal(alice.bankrupt, true);
  assert.deepEqual(alice.inventory, []);
  assert.equal(alice.jailFreeCards, 0);
});

// ---- settleAuction argument-order bug (bug sweep, 2026-09-01) ----
//
// Found by fuzzing, not review. settleAuction's signature is
// (gameState, boardTiles, auction), but TWO of its four callers passed only
// two arguments — so the auction object landed in the boardTiles slot and
// `auction` arrived undefined, throwing a hard
// `TypeError: resolveAuction: auction is required`.
//
// Both are rare-but-reachable paths that no existing test covered: a player
// leaving while an auction is live, and a match ENDING while one is live.
// Each assertion below was verified to fail against the unfixed code.

test('FORFEIT_MATCH while an auction is live settles that auction instead of crashing', () => {
  // Alice hosts (and so cannot bid), leaving Bob as the sole active bidder.
  // Bob quits, emptying the bidder list, which drives applyBankruptcy's own
  // "fold, then settle" branch.
  let state = soloBidderAuctionState();
  assert.equal(state.phase, 'FLASH_AUCTION_ACTIVE');
  assert.ok(state.pendingAuction.activeBidders.includes('gp-bob'));

  const { gameState } = transitionTurn(state, board, {
    type: 'FORFEIT_MATCH',
    payload: { playerId: 'gp-bob' },
  });

  assert.equal(gameState.players.find((p) => p.id === 'gp-bob').bankrupt, true);
  assert.equal(gameState.pendingAuction, null, 'the auction resolved rather than dangling');
  assert.notEqual(gameState.phase, 'FLASH_AUCTION_ACTIVE');
});

test('a match ending while an auction is live settles that auction instead of crashing', () => {
  // settleGameEnd's own docstring says it "resolves any still-active auction
  // next" — that branch threw a TypeError every time it was actually taken.
  // Driven through a real forfeit that leaves exactly one solvent player, so
  // finishAfterBankruptcy -> settleGameEnd runs for real.
  let state = soloBidderAuctionState();
  assert.equal(state.phase, 'FLASH_AUCTION_ACTIVE');
  assert.ok(state.pendingAuction);

  // Alice forfeits: Bob is the only non-bankrupt player left, so the match
  // ends by elimination while pendingAuction is still set.
  const { gameState } = transitionTurn(state, board, {
    type: 'FORFEIT_MATCH',
    payload: { playerId: 'gp-alice' },
  });

  assert.equal(gameState.status, 'finished');
  assert.equal(gameState.pendingAuction, null, 'no auction left in flight in the final state');
  const bob = gameState.players.find((p) => p.id === 'gp-bob');
  assert.equal(bob.finalRank, 1);
});

// ---- Free Parking jackpot ceiling (2026-09-01) ----
//
// Set from measurement: 750 simulated matches put the payout median at $200
// and p90 at exactly $600, with a tail running to $1,300 (9.6% of payouts
// above $600). Capped at the measured p90 so ~90% of payouts are untouched
// and only the runaway tail is clipped.

test('the Free Parking jackpot stops accumulating at its cap', () => {
  const state = { ...baseGameState(), phase: 'ROLLING', freeParkingJackpot: 550 };
  // Income Tax at position 5 is $100 — enough to push 550 past the 600 cap.
  const { gameState } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(2, 3) }); // total 5 -> tax tile
  assert.equal(gameState.freeParkingJackpot, 600, 'clipped at the cap, not 650');
});

test('a capped jackpot still pays out in full and resets to zero', () => {
  const state = {
    ...baseGameState(),
    phase: 'ROLLING',
    freeParkingJackpot: 600,
  };
  state.players[1] = { ...state.players[1], currentPosition: 0 };
  // Free Parking sits at position 9 on the test board.
  const { gameState, transactions } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(4, 5) }); // total 9
  const payout = transactions.find((t) => t.transactionType === 'free_parking_jackpot');
  assert.ok(payout, 'the jackpot really paid out');
  assert.equal(payout.amount, 600);
  assert.equal(gameState.freeParkingJackpot, 0);
  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentBalance, 1500 + 600);
});

test('jackpot accumulation below the cap is unchanged', () => {
  const state = { ...baseGameState(), phase: 'ROLLING', freeParkingJackpot: 100 };
  const { gameState } = transitionTurn(state, board, { type: 'ROLL_DICE', payload: roll(2, 3) }); // $100 tax
  assert.equal(gameState.freeParkingJackpot, 200);
});

// ---- Auction settlement must survive a winner who can no longer pay ----
//
// Found by fuzzing 2026-09-02, pre-existing since trades became phase-
// independent (2026-08-18). settleAuction asserted that a winner can always
// pay, on the reasoning that placeBid validates the balance and "no money
// moves during FLASH_AUCTION_ACTIVE". Trades move money during any phase.
//
// The failure was a PERMANENT DEADLOCK, not a wrong number: the throw aborted
// the transition, so pendingAuction stayed set, FOLD_AUCTION threw again, and
// AUCTION_TIMEOUT — the phase's own timer default — threw too. No escape.
test('an auction winner who is drained by a trade before settlement does not deadlock the match', () => {
  const base = baseGameState();
  const auction = placeBid(
    startAuction('p1', 100, 'gp-bob', ['gp-alice', 'gp-bob'], 'gp-bank'),
    'gp-alice',
    1400,
    1500
  );
  const state = {
    ...base,
    phase: 'FLASH_AUCTION_ACTIVE',
    pendingAuction: auction,
    // Alice won at 1400 but now holds 100 — exactly what a trade out of the
    // auction window produces.
    players: base.players.map((p) => (p.id === 'gp-alice' ? { ...p, currentBalance: 100 } : p)),
  };

  const { gameState } = transitionTurn(state, board, { type: 'FOLD_AUCTION', payload: { playerId: 'gp-bob' } }, '2026-09-02T00:00:00.000Z');

  assert.equal(gameState.pendingAuction, null, 'the auction resolved rather than dangling');
  assert.notEqual(gameState.phase, 'FLASH_AUCTION_ACTIVE', 'the match is not stuck in the auction phase');
  // A winner who cannot pay is settled the way every other unpayable debt is,
  // not silently forgiven: Alice is not the current-turn player here, and
  // settlePendingDebts settles a non-current debtor as immediate bankruptcy.
  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').bankrupt, true);
  assert.equal(gameState.properties.find((p) => p.id === 'p1').ownerId, null, 'unpaid property is not handed over');

  // Money conservation across the whole settlement, the invariant that would
  // catch the charge being dropped instead of settled.
  const before = state.players.reduce((s, p) => s + p.currentBalance, 0);
  const after = gameState.players.reduce((s, p) => s + p.currentBalance, 0);
  assert.equal(after, before);
});

test('a player who forfeits while leading an auction is never handed the property they were bidding on', () => {
  // Integration counterpart to auction.test.js's foldBidder tests. Found by
  // fuzzing 2026-09-02 as the invariant "a bankrupt player owns a property".
  // applyBankruptcy folds a forfeiting player out of any live auction; because
  // foldBidder left highestBidderId pointing at them, resolveAuction still
  // named them winner and TRANSFER_PROPERTY ran *after* their own bankruptcy
  // settlement had already redistributed everything they owned.
  const base = baseGameState();
  const auction = placeBid(
    startAuction('p1', 100, 'gp-bob', ['gp-alice', 'gp-bob'], 'gp-bank'),
    'gp-alice',
    300,
    1500
  );
  const state = { ...base, phase: 'FLASH_AUCTION_ACTIVE', pendingAuction: auction, currentTurnIndex: 1 };

  const { gameState } = transitionTurn(
    state,
    board,
    { type: 'FORFEIT_MATCH', payload: { playerId: 'gp-alice' } },
    '2026-09-02T00:00:00.000Z'
  );

  const alice = gameState.players.find((p) => p.id === 'gp-alice');
  assert.equal(alice.bankrupt, true);
  assert.equal(
    gameState.properties.filter((p) => p.ownerId === 'gp-alice').length,
    0,
    'an eliminated player must end up owning nothing at all'
  );
  assert.notEqual(gameState.properties.find((p) => p.id === 'p1').ownerId, 'gp-alice');
});

// ── Draft Phase (ASYMMETRIC only, ASYMMETRIC_MODE_SPEC.md §1.3) ────────────
// The ASYMMETRIC ruleset's whole branch through this file had zero coverage
// before this block — every prior CONTROL/ECONOMY/EXECUTION/MOBILITY test
// lived in synergyEngine.test.js/movementMiddleware.test.js as isolated
// pure-engine tests. This is the first integration coverage of an
// ASYMMETRIC-only phase actually flowing through transitionTurn().
//
// `board`'s t1/t10..t35 are ownable `property` tiles (t1 costs 60, t10..t35
// cost 80-100 — see buildSmallBoard() above); t2 is transport and t6 is
// utility, both deliberately included in every offer fixture below so a
// test can assert the draft never offers them.
function draftGameState(overrides = {}) {
  return baseGameState({
    ruleset: 'ASYMMETRIC',
    phase: 'DRAFTING_ACTIVE',
    draftState: {
      round: 1,
      pickOrder: ['gp-alice', 'gp-bob'],
      currentPickIndex: 0,
      availableTileIds: ['t1', 't10', 't11', 't12'],
    },
    ...overrides,
  });
}

test('DRAFT_PICK assigns ownership to the CURRENT picker, deducts the price, and advances to the next picker', () => {
  const state = draftGameState();
  const { gameState, transactions } = transitionTurn(state, board, {
    type: 'DRAFT_PICK',
    payload: { tileId: 't1' },
  });

  const alice = gameState.players.find((p) => p.id === 'gp-alice');
  assert.equal(alice.currentBalance, 1500 - 60); // t1's price
  assert.equal(gameState.properties.find((p) => p.boardTileId === 't1').ownerId, 'gp-alice');
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].transactionType, 'purchase');

  assert.equal(gameState.phase, 'DRAFTING_ACTIVE', 'round 1 has one more picker left (Bob)');
  assert.equal(gameState.draftState.currentPickIndex, 1);
  assert.equal(getCurrentPlayer(gameState).id, 'gp-bob', 'getCurrentPlayer resolves through draftState during the draft');
});

test('a draft pick never sets acquiredAtRound — a stamped round would wrongly trigger RECENTLY_ACQUIRED on Turn 1', () => {
  // roundNumber is 0 both during the draft and at the very start of Turn 1
  // (it only advances once turn order wraps around) — stamping it here the
  // way handleBuyProperty does for an in-match purchase would make
  // property.js's "wait a turn" build gate misfire on the very first turn,
  // even though a full draft (far longer than one real turn) already
  // elapsed. null is what that gate already treats as exempt.
  const { gameState } = transitionTurn(draftGameState(), board, {
    type: 'DRAFT_PICK',
    payload: { tileId: 't1' },
  });
  assert.equal(gameState.properties.find((p) => p.boardTileId === 't1').acquiredAtRound, null);
});

test('DRAFT_PICK rejects a tileId that is not in this round\'s offer', () => {
  assert.throws(
    () => transitionTurn(draftGameState(), board, { type: 'DRAFT_PICK', payload: { tileId: 't20' } }),
    (err) => err instanceof InvalidDraftActionError && err.reason === 'TILE_NOT_AVAILABLE'
  );
});

test('DRAFT_PICK rejects a pick the picker cannot afford, same as BUY_PROPERTY', () => {
  const poor = draftGameState();
  const alice = poor.players.find((p) => p.id === 'gp-alice');
  poor.players = poor.players.map((p) => (p.id === 'gp-alice' ? { ...alice, currentBalance: 10 } : p));

  assert.throws(
    () => transitionTurn(poor, board, { type: 'DRAFT_PICK', payload: { tileId: 't1' } }),
    (err) => err instanceof InvalidDraftActionError && err.reason === 'INSUFFICIENT_BALANCE'
  );
});

test('DRAFT_PASS spends nothing but still advances to the next picker', () => {
  const { gameState } = transitionTurn(draftGameState(), board, { type: 'DRAFT_PASS' });
  const alice = gameState.players.find((p) => p.id === 'gp-alice');
  assert.equal(alice.currentBalance, 1500, 'passing costs nothing');
  assert.equal(gameState.draftState.currentPickIndex, 1);
  assert.equal(getCurrentPlayer(gameState).id, 'gp-bob');
});

test('round 1 completing rolls into round 2: fresh offer excluding round-1 picks, snake-reversed order, index reset', () => {
  const afterAlice = transitionTurn(draftGameState(), board, {
    type: 'DRAFT_PICK',
    payload: { tileId: 't1' },
  }).gameState;
  const afterBob = transitionTurn(afterAlice, board, {
    type: 'DRAFT_PICK',
    payload: { tileId: 't10' },
  }).gameState;

  assert.equal(afterBob.phase, 'DRAFTING_ACTIVE', 'round 2 still has picks left');
  assert.equal(afterBob.draftState.round, 2);
  assert.equal(afterBob.draftState.currentPickIndex, 0);
  assert.deepEqual(afterBob.draftState.pickOrder, ['gp-bob', 'gp-alice'], 'snake order reverses for round 2');
  assert.ok(!afterBob.draftState.availableTileIds.includes('t1'), 't1 was drafted in round 1');
  assert.ok(!afterBob.draftState.availableTileIds.includes('t10'), 't10 was drafted in round 1');
  assert.ok(
    afterBob.draftState.availableTileIds.every((id) => !['t2', 't6'].includes(id)),
    'transport (t2) and utility (t6) are never offered — draftPhase.js only offers `property` tiles'
  );
});

test('round 2 completing clears draftState and hands off to a real TURN_START at seat 0', () => {
  let state = draftGameState();
  state = transitionTurn(state, board, { type: 'DRAFT_PICK', payload: { tileId: 't1' } }).gameState;
  state = transitionTurn(state, board, { type: 'DRAFT_PICK', payload: { tileId: 't10' } }).gameState;
  // Round 2, snake-reversed: Bob picks first this time.
  assert.equal(getCurrentPlayer(state).id, 'gp-bob');
  state = transitionTurn(state, board, {
    type: 'DRAFT_PICK',
    payload: { tileId: state.draftState.availableTileIds[0] },
  }).gameState;
  assert.equal(getCurrentPlayer(state).id, 'gp-alice', 'last picker of the draft');
  state = transitionTurn(state, board, { type: 'DRAFT_PASS' }).gameState;

  assert.equal(state.draftState, null);
  assert.equal(state.phase, 'TURN_START');
  assert.equal(state.currentTurnIndex, 0);
  assert.equal(getCurrentPlayer(state).id, 'gp-alice', 'back to the match\'s own turnOrder, seat 0');
});

test('DRAFTING_ACTIVE rejects any action other than DRAFT_PICK/DRAFT_PASS', () => {
  assert.throws(() => transitionTurn(draftGameState(), board, { type: 'ROLL_DICE' }), InvalidTurnActionError);
});

// ── Trap system (trapEngine.js, ROADBLOCK/TOLL_BOOTH) ───────────────────────
// Shares PLAYING_CARD with PLAY_MOVEMENT_CARD by design (turnMachine.js's own
// VALID_ACTIONS_BY_PHASE comment) — placing a trap spends a movement card
// INSTEAD OF moving, so these fixtures start from the same phase real
// movement-card tests do, just with PLACE_TRAP instead.
function trapGameState(overrides = {}) {
  return baseGameState({
    ruleset: 'ASYMMETRIC',
    phase: 'PLAYING_CARD',
    ...overrides,
  });
}

test('PLACE_TRAP: spends the card, creates the trap, ends the turn at POST_ACTIONS without moving', () => {
  const state = trapGameState();
  state.players[1] = { ...state.players[1], movementHand: ['MOVE_5'] }; // alice, turnOrder 0
  const { gameState, transactions } = transitionTurn(state, board, {
    type: 'PLACE_TRAP',
    payload: { cardId: 'MOVE_5', trapType: 'ROADBLOCK', targetPosition: 20 },
  });

  const alice = gameState.players.find((p) => p.id === 'gp-alice');
  assert.deepEqual(alice.movementHand, [], 'the card is spent');
  assert.equal(alice.currentPosition, 0, 'placing a trap is not a move');
  assert.equal(gameState.phase, 'POST_ACTIONS');
  assert.deepEqual(transactions, [], 'placing a trap costs a card, not money');

  assert.deepEqual(gameState.activeTraps, [
    { tileIndex: 20, type: 'ROADBLOCK', ownerId: 'gp-alice', expiresAtRound: gameState.roundNumber + 5 },
  ]);
});

test('PLACE_TRAP rejects a card the player does not hold, same guard PLAY_MOVEMENT_CARD uses', () => {
  const state = trapGameState();
  state.players[1] = { ...state.players[1], movementHand: ['MOVE_5'] };
  assert.throws(
    () => transitionTurn(state, board, { type: 'PLACE_TRAP', payload: { cardId: 'JUMP_2', trapType: 'ROADBLOCK', targetPosition: 20 } }),
    /Bạn không có thẻ này trên tay/
  );
});

test('PLACE_TRAP rejects an out-of-range position', () => {
  const state = trapGameState();
  state.players[1] = { ...state.players[1], movementHand: ['MOVE_5'] };
  assert.throws(
    () => transitionTurn(state, board, { type: 'PLACE_TRAP', payload: { cardId: 'MOVE_5', trapType: 'ROADBLOCK', targetPosition: 99 } }),
    (err) => err instanceof InvalidTrapActionError && err.reason === 'INVALID_POSITION'
  );
});

test('PLACE_TRAP rejects a tile that already has an active trap on it', () => {
  const state = trapGameState({ activeTraps: [{ tileIndex: 20, type: 'TOLL_BOOTH', ownerId: 'gp-bob', expiresAtRound: 10 }] });
  state.players[1] = { ...state.players[1], movementHand: ['MOVE_5'] };
  assert.throws(
    () => transitionTurn(state, board, { type: 'PLACE_TRAP', payload: { cardId: 'MOVE_5', trapType: 'ROADBLOCK', targetPosition: 20 } }),
    (err) => err instanceof InvalidTrapActionError && err.reason === 'TILE_OCCUPIED'
  );
});

test('PLACE_TRAP rejects a placer\'s own 3rd simultaneous trap (MAX_TRAPS_PER_PLAYER = 2)', () => {
  const state = trapGameState({
    activeTraps: [
      { tileIndex: 15, type: 'ROADBLOCK', ownerId: 'gp-alice', expiresAtRound: 10 },
      { tileIndex: 16, type: 'ROADBLOCK', ownerId: 'gp-alice', expiresAtRound: 10 },
    ],
  });
  state.players[1] = { ...state.players[1], movementHand: ['MOVE_5'] };
  assert.throws(
    () => transitionTurn(state, board, { type: 'PLACE_TRAP', payload: { cardId: 'MOVE_5', trapType: 'ROADBLOCK', targetPosition: 20 } }),
    (err) => err instanceof InvalidTrapActionError && err.reason === 'TRAP_LIMIT_REACHED'
  );
});

test('a real move into a ROADBLOCK stops the mover AND removes the trap from gameState — one-shot ambush, not permanent', () => {
  const state = trapGameState({ activeTraps: [{ tileIndex: 3, type: 'ROADBLOCK', ownerId: 'gp-bob', expiresAtRound: 10 }] });
  state.players[1] = { ...state.players[1], movementHand: ['MOVE_6'], currentPosition: 0 }; // alice tries to walk 6, from 0
  const { gameState } = transitionTurn(state, board, { type: 'PLAY_MOVEMENT_CARD', payload: { cardId: 'MOVE_6' } });

  const alice = gameState.players.find((p) => p.id === 'gp-alice');
  assert.equal(alice.currentPosition, 3, 'stopped dead at the roadblock, 3 short of the full 6');
  assert.deepEqual(gameState.activeTraps, [], 'the ROADBLOCK is consumed the instant it fires');
});

test('a real move across a TOLL_BOOTH charges the crosser and pays the trap owner, and the trap survives to charge again', () => {
  const state = trapGameState({ activeTraps: [{ tileIndex: 3, type: 'TOLL_BOOTH', ownerId: 'gp-bob', expiresAtRound: 10 }] });
  state.players[1] = { ...state.players[1], movementHand: ['MOVE_6'], currentPosition: 0, currentBalance: 1500 };
  const { gameState, transactions } = transitionTurn(state, board, { type: 'PLAY_MOVEMENT_CARD', payload: { cardId: 'MOVE_6' } });

  const alice = gameState.players.find((p) => p.id === 'gp-alice');
  const bob = gameState.players.find((p) => p.id === 'gp-bob');
  assert.equal(alice.currentPosition, 6, 'a toll never stops the mover');
  assert.equal(alice.currentBalance, 1500 - 100);
  assert.equal(bob.currentBalance, 1500 + 100, 'the toll is paid to the trap OWNER, not the Bank');
  assert.ok(transactions.some((t) => t.transactionType === 'pass_through_toll'));
  assert.deepEqual(gameState.activeTraps, [{ tileIndex: 3, type: 'TOLL_BOOTH', ownerId: 'gp-bob', expiresAtRound: 10 }], 'still standing');
});

// ── Display-only movement facts (frontend "Mặt trận 3") ────────────────────
// lastRoll doubles as a "distance actually walked" carrier for ASYMMETRIC card
// plays, and lastTrapHits/lastTrapHitSeq report which traps went off. No game
// logic reads either back; these guard the contract the board's animation
// layer relies on. See handlePlayMovementCard's own comment for the reasoning.

test('a movement card reports the distance actually walked on lastRoll, WITHOUT bumping lastRollSeq', () => {
  const state = trapGameState({ lastRollSeq: 7 });
  state.players[1] = { ...state.players[1], movementHand: ['MOVE_6'], currentPosition: 20 };
  const { gameState } = transitionTurn(state, board, { type: 'PLAY_MOVEMENT_CARD', payload: { cardId: 'MOVE_6' } });

  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentPosition, 26);
  assert.deepEqual(gameState.lastRoll, { die1: 0, die2: 0, total: 6, isDouble: false });
  assert.equal(gameState.lastRollSeq, 7, 'not a real roll — bumping this would flash dice at the table');
  assert.deepEqual(gameState.lastTrapHits, []);
  assert.equal(gameState.lastTrapHitSeq, 0, 'nothing went off, so the explosion counter stays put');
});

test('a backward card reports its ABSOLUTE distance, not the 33-tile forward wrap', () => {
  const state = trapGameState();
  state.players[1] = { ...state.players[1], movementHand: ['BACKUP_3'], currentPosition: 20 };
  const { gameState } = transitionTurn(state, board, { type: 'PLAY_MOVEMENT_CARD', payload: { cardId: 'BACKUP_3' } });

  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentPosition, 17);
  assert.equal(gameState.lastRoll.total, 3, 'the client walks 3 tiles backwards, never 33 forwards');
});

test('a ROADBLOCK reports the TRUNCATED distance and records the explosion', () => {
  const state = trapGameState({ activeTraps: [{ tileIndex: 23, type: 'ROADBLOCK', ownerId: 'gp-bob', expiresAtRound: 10 }] });
  state.players[1] = { ...state.players[1], movementHand: ['MOVE_6'], currentPosition: 20 };
  const { gameState } = transitionTurn(state, board, { type: 'PLAY_MOVEMENT_CARD', payload: { cardId: 'MOVE_6' } });

  assert.equal(gameState.players.find((p) => p.id === 'gp-alice').currentPosition, 23);
  assert.equal(gameState.lastRoll.total, 3, 'the walk really was 3 tiles, not the nominal 6 printed on the card');
  assert.deepEqual(gameState.lastTrapHits, [{ tileIndex: 23, type: 'ROADBLOCK' }]);
  assert.equal(gameState.lastTrapHitSeq, 1);
});

test('a TOLL_BOOTH crossing is reported as an explosion even though the trap survives', () => {
  const state = trapGameState({ activeTraps: [{ tileIndex: 23, type: 'TOLL_BOOTH', ownerId: 'gp-bob', expiresAtRound: 10 }] });
  state.players[1] = { ...state.players[1], movementHand: ['MOVE_6'], currentPosition: 20, currentBalance: 1500 };
  const { gameState } = transitionTurn(state, board, { type: 'PLAY_MOVEMENT_CARD', payload: { cardId: 'MOVE_6' } });

  assert.deepEqual(gameState.lastTrapHits, [{ tileIndex: 23, type: 'TOLL_BOOTH' }]);
  assert.equal(gameState.activeTraps.length, 1, 'reporting the hit does not consume it');
});

test('a clean move CLEARS the previous explosion so it cannot replay', () => {
  const state = trapGameState({ lastTrapHits: [{ tileIndex: 3, type: 'ROADBLOCK' }], lastTrapHitSeq: 4 });
  state.players[1] = { ...state.players[1], movementHand: ['MOVE_6'], currentPosition: 20 };
  const { gameState } = transitionTurn(state, board, { type: 'PLAY_MOVEMENT_CARD', payload: { cardId: 'MOVE_6' } });

  assert.deepEqual(gameState.lastTrapHits, []);
  assert.equal(gameState.lastTrapHitSeq, 4, 'unchanged — the counter only moves when something actually fires');
});

test('END_TURN, on the real round-wrap boundary, prunes expired traps but keeps live ones', () => {
  const state = baseGameState({
    ruleset: 'ASYMMETRIC',
    phase: 'POST_ACTIONS',
    currentTurnIndex: 1, // Bob's turn — ending it wraps back to Alice (turnOrder 0), a real round boundary
    roundNumber: 4,
    activeTraps: [
      { tileIndex: 1, type: 'ROADBLOCK', ownerId: 'gp-alice', expiresAtRound: 4 }, // expires exactly this round
      { tileIndex: 2, type: 'ROADBLOCK', ownerId: 'gp-bob', expiresAtRound: 9 }, // still well within its window
    ],
  });
  const { gameState } = transitionTurn(state, board, { type: 'END_TURN' });

  assert.equal(gameState.roundNumber, 5, 'the round really did wrap');
  assert.deepEqual(gameState.activeTraps.map((t) => t.tileIndex), [2], 'the round-4 trap is pruned, the round-9 one survives');
});

// ===========================================================================
// PLAY_MOVEMENT_CARD defects found by fuzzing (2026-09-04). The whole path was
// unreachable in production until socketServer.js's missing MOVEMENT_CARDS
// import was fixed — once it executed, three more defects sat behind it. One
// regression test each, so none of them can come back quietly.
// ===========================================================================

// Every buyable tile needs a real Property row — resolveTile refuses a buyable
// landing without one, exactly as a real game (initializeGameState creates one
// per buyable tile up front). `owned` assigns owners by tile id.
function movementCardState({ position = 0, balance = 1500, hand = ['MOVE_6'], owned = {} } = {}) {
  const board = buildSmallBoard();
  const properties = board
    .filter((t) => ['property', 'transport', 'utility'].includes(t.tileType))
    .map((t) => createProperty({ id: 'pr-' + t.id, gameId: 'g', boardTileId: t.id, ownerId: owned[t.id] ?? null }));
  return createGameState({
    id: 'g', roomId: 'r', boardId: 'small', ruleset: 'ASYMMETRIC', status: 'in_progress',
    phase: 'PLAYING_CARD', currentTurnIndex: 0,
    players: [
      createPlayerGameState({ id: 'bank', gameId: 'g', isBank: true, currentBalance: 17000 }),
      createPlayerGameState({ id: 'mc1', gameId: 'g', playerId: 'mu1', turnOrder: 0, currentBalance: balance, currentPosition: position, movementHand: hand }),
      createPlayerGameState({ id: 'mc2', gameId: 'g', playerId: 'mu2', turnOrder: 1, currentBalance: 1500 }),
    ],
    properties,
  });
}

const playMovementCard = (gs, cardId) =>
  transitionTurn(
    gs,
    buildSmallBoard(),
    { type: 'PLAY_MOVEMENT_CARD', payload: { playerId: 'mc1', cardId }, clientActionId: 'mc-1' },
    '2026-09-04T00:00:00.000Z'
  );

test('PLAY_MOVEMENT_CARD: landing on a utility does not throw — resolveLanding gets a real dice value, not `now`', () => {
  // resolveLanding's signature is (gameState, boardTiles, playerId, diceTotal,
  // now); this call site passed only four arguments, so `now` (an ISO string)
  // landed in the diceTotal slot and calculateRent rejected it with "diceRoll
  // is required for utility rent". t6 is the utility, 6 steps from GO.
  const result = playMovementCard(movementCardState({ position: 0, hand: ['MOVE_6'], owned: { t6: 'mc2' } }), 'MOVE_6');

  assert.equal(result.gameState.players.find((p) => p.id === 'mc1').currentPosition, 6);
  // UTILITY_DICE_FALLBACK (7) x 4 for a single-utility owner — the same
  // convention moveByStepsAndResolve already uses for card-driven landings —
  // then INFRA's own +25% landing rider (§2.3, wired 2026-09-04), which is why
  // this is 35 and not the bare 28 it asserted when the archetype was inert:
  // floor(28 x 1.25). The exact figure is incidental to what this test is for
  // (proving resolveLanding receives a real dice value rather than `now`), but
  // it is asserted rather than loosened, so a change to either half stays
  // visible instead of quietly cancelling out.
  const rentTx = result.transactions.find((t) => t.transactionType === 'rent');
  assert.ok(rentTx, 'landing on an owned utility must produce a rent transaction');
  assert.equal(rentTx.amount, 35);
});

test('PLAY_MOVEMENT_CARD: crossing GO pays the salary under the listed transactionType', () => {
  // This site said 'pass_go', which is not in applyTransaction's
  // TRANSACTION_TYPES — so any movement card that lapped the board threw.
  const result = playMovementCard(movementCardState({ position: 33, hand: ['MOVE_5'] }), 'MOVE_5');

  assert.equal(result.gameState.players.find((p) => p.id === 'mc1').currentPosition, 2);
  assert.ok(
    result.transactions.find((t) => t.transactionType === 'pass_go_salary'),
    'passing GO by movement card must credit the salary'
  );
});

test('PLAY_MOVEMENT_CARD: a card the player cannot afford is a clean domain rejection, not a negative balance', () => {
  // applyTransaction's own RangeError says an unaffordable VOLUNTARY purchase
  // must be refused before reaching it; nothing checked, so $43 playing
  // SPRINT_12 ($100) drove the balance to -$57 and reported INTERNAL_ERROR.
  assert.throws(
    () => playMovementCard(movementCardState({ balance: 43, hand: ['SPRINT_12'] }), 'SPRINT_12'),
    (err) => err.name === 'InvalidMovementCardError' && err.reason === 'INSUFFICIENT_BALANCE'
  );
});

test('PLAY_MOVEMENT_CARD: a card the player CAN afford still charges exactly its cost', () => {
  const result = playMovementCard(movementCardState({ balance: 500, hand: ['STEP_2'] }), 'STEP_2');
  assert.equal(result.transactions.find((t) => t.transactionType === 'movement_card_cost').amount, 50);
  assert.equal(result.gameState.players.find((p) => p.id === 'mc1').currentPosition, 2);
});

// --- FORFEIT_MATCH when the same step leaves NOBODY standing (2026-09-04) ---
//
// Found by fuzzing. A live auction whose leader has since been drained below
// their own winning bid is settled as part of the current player's forfeit —
// so one action bankrupts two players: the forfeiter by forfeiting, the leader
// by a bid they can no longer cover. checkElimination tested `=== 1` survivor,
// so zero read as "not over", and resolveForfeit fell through to advanceTurn(),
// whose next-player scan found nobody: `TypeError: Cannot read properties of
// undefined (reading 'turnOrder')`. errorCodeFor maps a bare TypeError to
// MALFORMED_PAYLOAD, so the player who pressed "Đầu hàng" was told their
// payload was malformed — and the room was unrecoverable from there, because
// every retry failed identically.
test('FORFEIT_MATCH: a forfeit that leaves zero solvent players ends the match instead of crashing', () => {
  const board = buildSmallBoard();
  const properties = board
    .filter((t) => ['property', 'transport', 'utility'].includes(t.tileType))
    .map((t) => createProperty({ id: 'zs-' + t.id, gameId: 'g', boardTileId: t.id }));

  const gs = createGameState({
    id: 'g', roomId: 'r', boardId: 'small', status: 'in_progress',
    phase: 'POST_ACTIONS', currentTurnIndex: 3,
    players: [
      createPlayerGameState({ id: 'bank', gameId: 'g', isBank: true, currentBalance: 14000 }),
      createPlayerGameState({ id: 'z0', gameId: 'g', playerId: 'zu0', turnOrder: 0, currentBalance: 0, bankrupt: true, bankruptAt: '2026-09-04T01:00:00.000Z' }),
      createPlayerGameState({ id: 'z1', gameId: 'g', playerId: 'zu1', turnOrder: 1, currentBalance: 283 }),
      createPlayerGameState({ id: 'z2', gameId: 'g', playerId: 'zu2', turnOrder: 2, currentBalance: 0, bankrupt: true, bankruptAt: '2026-09-04T02:00:00.000Z' }),
      createPlayerGameState({ id: 'z3', gameId: 'g', playerId: 'zu3', turnOrder: 3, currentBalance: 528 }),
    ],
    properties,
    // z1 leads at 369 holding only 283 — the settlement cannot be paid.
    pendingAuction: {
      propertyId: 'zs-t2', basePrice: 349, currentBid: 369,
      highestBidderId: 'z1', activeBidders: ['z1', 'z3'], initiatorId: 'z0',
      bankId: 'bank', bids: [{ playerId: 'z1', amount: 369 }],
    },
  });

  const result = transitionTurn(
    gs,
    board,
    { type: 'FORFEIT_MATCH', payload: { playerId: 'z3' }, clientActionId: 'zs-1' },
    '2026-09-04T03:00:00.000Z'
  );

  assert.equal(result.gameState.status, 'finished');
  assert.equal(result.gameState.phase, null);
  for (const p of result.gameState.players.filter((x) => !x.isBank)) {
    assert.ok(Number.isInteger(p.finalRank), 'player ' + p.id + ' must carry a finalRank');
  }
});
