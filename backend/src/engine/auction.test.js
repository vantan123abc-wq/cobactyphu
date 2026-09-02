import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateAuctionFee,
  calculateBrokerCommission,
  startAuction,
  placeBid,
  foldBidder,
  resolveAuction,
  InvalidBidError,
} from './auction.js';

// Convenience: all tests that call startAuction now pass bankId='bank'
// (V2 requirement). The Bank is excluded from activeBidders by the caller
// in turnMachine.js, so tests here do not include 'bank' in allPlayers.
const BANK_ID = 'bank';

// ---- calculateAuctionFee (Rule 1) ----

test('calculateAuctionFee: 5% of basePrice when within [20, 80]', () => {
  assert.equal(calculateAuctionFee(1000), 50); // 5% of 1000 = 50, no clamp
});

test('calculateAuctionFee: clamps to a minimum of 20', () => {
  assert.equal(calculateAuctionFee(100), 20); // 5% of 100 = 5, clamped up to 20
});

test('calculateAuctionFee: clamps to a maximum of 80', () => {
  assert.equal(calculateAuctionFee(2000), 80); // 5% of 2000 = 100, clamped down to 80
});

test('calculateAuctionFee: a fractional 5% within the clamp range is rounded up (payer-side rounding)', () => {
  assert.equal(calculateAuctionFee(530), 27); // 5% of 530 = 26.5 -> ceil -> 27
});

test('calculateAuctionFee: rejects a non-positive basePrice', () => {
  assert.throws(() => calculateAuctionFee(0), TypeError);
  assert.throws(() => calculateAuctionFee(-100), TypeError);
});

// ---- calculateBrokerCommission (Rule 1b — V2) ----

test('calculateBrokerCommission: 20% of winningBid, floored', () => {
  assert.equal(calculateBrokerCommission(800), 160);  // 20% of 800 = 160
  assert.equal(calculateBrokerCommission(500), 100);  // 20% of 500 = 100
  assert.equal(calculateBrokerCommission(123), 24);   // 20% of 123 = 24.6 -> floor -> 24
});

test('calculateBrokerCommission: rejects a non-positive winningBid', () => {
  assert.throws(() => calculateBrokerCommission(0), TypeError);
  assert.throws(() => calculateBrokerCommission(-1), TypeError);
});

// ---- startAuction (Rule 2) ----

test('startAuction: currentBid starts exactly at basePrice, bankId stored', () => {
  const auction = startAuction('p1', 400, 'initiator', ['initiator', 'p2', 'p3'], BANK_ID);
  assert.equal(auction.basePrice, 400);
  assert.equal(auction.currentBid, 400);
  assert.equal(auction.highestBidderId, null);
  assert.equal(auction.bankId, BANK_ID);
});

test('startAuction: records propertyId, initiatorId, the full bidder pool, and an empty bid log', () => {
  const auction = startAuction('p1', 400, 'initiator', ['initiator', 'p2', 'p3'], BANK_ID);
  assert.equal(auction.propertyId, 'p1');
  assert.equal(auction.initiatorId, 'initiator');
  assert.deepEqual(auction.activeBidders, ['initiator', 'p2', 'p3']);
  assert.deepEqual(auction.bids, []);
});

test('startAuction: rejects a non-positive basePrice', () => {
  assert.throws(() => startAuction('p1', 0, 'initiator', ['initiator'], BANK_ID), TypeError);
});

test('startAuction: rejects a missing bankId', () => {
  assert.throws(() => startAuction('p1', 400, 'initiator', ['initiator']), TypeError);
});

// ---- placeBid (unchanged validation, now also logs to `bids`) ----

test('placeBid: the opening bid must strictly exceed basePrice — matching it is rejected', () => {
  const auction = startAuction('p1', 300, 'initiator', ['p2'], BANK_ID);
  assert.throws(() => placeBid(auction, 'p2', 300, 1500), InvalidBidError);
});

test('placeBid: a valid bid updates currentBid/highestBidderId and appends to the bid log', () => {
  const auction = startAuction('p1', 300, 'initiator', ['p2'], BANK_ID);
  const after = placeBid(auction, 'p2', 350, 1500);
  assert.equal(after.currentBid, 350);
  assert.equal(after.highestBidderId, 'p2');
  assert.deepEqual(after.bids, [{ playerId: 'p2', amount: 350 }]);
});

test('placeBid: rejects a bidder who is not active, or an insufficient balance', () => {
  const auction = startAuction('p1', 300, 'initiator', ['p2'], BANK_ID);
  assert.throws(() => placeBid(auction, 'p3', 350, 1500), InvalidBidError);
  assert.throws(() => placeBid(auction, 'p2', 350, 100), InvalidBidError);
});

// ---- foldBidder (unchanged) ----

test('foldBidder: removes eligibility to bid again, without erasing bid history', () => {
  let auction = startAuction('p1', 300, 'initiator', ['p2', 'p3'], BANK_ID);
  auction = placeBid(auction, 'p2', 350, 1500);
  auction = foldBidder(auction, 'p2');

  assert.deepEqual(auction.activeBidders, ['p3']);
  assert.deepEqual(auction.bids, [{ playerId: 'p2', amount: 350 }]); // still on record
});

// ---- resolveAuction — FAILED cases ----

test('resolveAuction: FAILED when no bids were ever made — no intents, commissionAmount null', () => {
  const auction = startAuction('p1', 300, 'initiator', ['p2', 'p3'], BANK_ID);
  const result = resolveAuction(auction);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.propertyId, 'p1');
  assert.equal(result.winnerId, null);
  assert.equal(result.commissionAmount, null);
  assert.deepEqual(result.intents, []);
});

test('resolveAuction: FAILED when every bidder folds at base price without ever bidding', () => {
  let auction = startAuction('p1', 300, 'initiator', ['p2', 'p3'], BANK_ID);
  auction = foldBidder(auction, 'p2');
  auction = foldBidder(auction, 'p3');

  const result = resolveAuction(auction);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.commissionAmount, null);
  assert.deepEqual(result.intents, []);
});

// ---- resolveAuction — SETTLED with broker commission (V2) ----

test('resolveAuction: SETTLED — winner pays, property transfers, initiator receives 20% commission from Bank', () => {
  let auction = startAuction('p1', 300, 'initiator', ['p2'], BANK_ID);
  auction = placeBid(auction, 'p2', 400, 1500);

  const settlement = resolveAuction(auction);
  assert.equal(settlement.status, 'SETTLED');
  assert.equal(settlement.winnerId, 'p2');
  // commission = floor(400 * 0.20) = 80 — Bank pays this via ADD_MONEY intent
  // (applyIntents routes ADD_MONEY as fromBank→toInitiator internally; no REMOVE_MONEY needed)
  assert.equal(settlement.commissionAmount, 80);
  assert.deepEqual(settlement.intents, [
    { action: 'REMOVE_MONEY', playerId: 'p2', amount: 400 },
    { action: 'TRANSFER_PROPERTY', propertyId: 'p1', toPlayerId: 'p2' },
    { action: 'ADD_MONEY', playerId: 'initiator', amount: 80 },
  ]);
});


test('resolveAuction: commission is 20% of the winning bid, floored', () => {
  let auction = startAuction('p1', 200, 'initiator', ['p2'], BANK_ID);
  auction = placeBid(auction, 'p2', 213, 1500); // floor(213*0.20) = floor(42.6) = 42
  const settlement = resolveAuction(auction);
  assert.equal(settlement.commissionAmount, 42);
  assert.ok(settlement.intents.some((i) => i.action === 'ADD_MONEY' && i.playerId === 'initiator' && i.amount === 42));
});

test('resolveAuction: commission applies even when initiator is the winner (they opened and won their own auction)', () => {
  let auction = startAuction('p1', 300, 'initiator', ['initiator', 'p2'], BANK_ID);
  auction = placeBid(auction, 'initiator', 500, 2000);

  const settlement = resolveAuction(auction);
  assert.equal(settlement.winnerId, 'initiator');
  assert.equal(settlement.commissionAmount, 100); // floor(500*0.20)
  assert.ok(settlement.intents.some((i) => i.action === 'ADD_MONEY' && i.playerId === 'initiator' && i.amount === 100));
});

// ---- resolveAuction — Near-Miss rewards (unchanged from V1) ----

test('resolveAuction: Near-Miss eligible loser (>=2 bids, highest >= 90% of winning bid) gets an ADD_MONEY reward', () => {
  let auction = startAuction('p1', 200, 'initiator', ['p2', 'p3'], BANK_ID);
  auction = placeBid(auction, 'p2', 250, 1500); // p2 bid #1
  auction = placeBid(auction, 'p3', 300, 1500); // p3 bid #1
  auction = placeBid(auction, 'p2', 380, 1500); // p2 bid #2, highest 380
  auction = placeBid(auction, 'p3', 400, 1500); // p3 wins at 400

  // threshold = 400 * 0.9 = 360; p2's highest (380) clears it, and p2 has 2 bids.
  const settlement = resolveAuction(auction);
  assert.equal(settlement.winnerId, 'p3');
  // near-miss reward = floor((400-200)*0.02) = 4
  assert.ok(settlement.intents.some((i) => i.action === 'ADD_MONEY' && i.playerId === 'p2' && i.amount === 4));
});

test('resolveAuction: Near-Miss ineligible when the loser only bid once', () => {
  let auction = startAuction('p1', 200, 'initiator', ['p2', 'p3'], BANK_ID);
  auction = placeBid(auction, 'p2', 380, 1500); // only one bid
  auction = placeBid(auction, 'p3', 500, 1500);

  const settlement = resolveAuction(auction);
  // p2 has no near-miss reward; commission intents present but no ADD_MONEY for p2
  assert.ok(!settlement.intents.some((i) => i.action === 'ADD_MONEY' && i.playerId === 'p2'));
});

test('resolveAuction: Near-Miss ineligible when the loser has >=2 bids but never got within 90% of winning bid', () => {
  let auction = startAuction('p1', 200, 'initiator', ['p2', 'p3'], BANK_ID);
  auction = placeBid(auction, 'p2', 210, 1500);
  auction = placeBid(auction, 'p2', 220, 1500); // p2's highest 220
  auction = placeBid(auction, 'p3', 500, 1500); // threshold 450; 220 < 450

  const settlement = resolveAuction(auction);
  assert.ok(!settlement.intents.some((i) => i.action === 'ADD_MONEY' && i.playerId === 'p2'));
});

test('resolveAuction: Near-Miss reward is capped at 50', () => {
  let auction = startAuction('p1', 200, 'initiator', ['p2', 'p3'], BANK_ID);
  auction = placeBid(auction, 'p2', 3000, 10000);
  auction = placeBid(auction, 'p3', 3200, 10000);
  auction = placeBid(auction, 'p2', 4700, 10000); // p2 bid #2, highest 4700
  auction = placeBid(auction, 'p3', 5200, 10000); // p3 wins at 5200

  // uncapped reward = floor((5200-200)*0.02) = 100 -> capped to 50
  const settlement = resolveAuction(auction);
  const p2Reward = settlement.intents.find((i) => i.action === 'ADD_MONEY' && i.playerId === 'p2');
  assert.equal(p2Reward.amount, 50);
});

test('resolveAuction: a Near-Miss reward that floors to 0 is omitted', () => {
  let auction = startAuction('p1', 1000, 'initiator', ['p2', 'p3'], BANK_ID);
  auction = placeBid(auction, 'p2', 1001, 10000);
  auction = placeBid(auction, 'p2', 1002, 10000);
  auction = placeBid(auction, 'p3', 1003, 10000); // reward = floor((1003-1000)*0.02) = 0

  const settlement = resolveAuction(auction);
  assert.ok(!settlement.intents.some((i) => i.action === 'ADD_MONEY' && i.playerId === 'p2'));
});

test('resolveAuction: a folded bidder is still Near-Miss eligible', () => {
  let auction = startAuction('p1', 200, 'initiator', ['p2', 'p3'], BANK_ID);
  auction = placeBid(auction, 'p2', 250, 1500);
  auction = placeBid(auction, 'p2', 380, 1500);
  auction = foldBidder(auction, 'p2');
  auction = placeBid(auction, 'p3', 400, 1500);

  const settlement = resolveAuction(auction);
  assert.ok(settlement.intents.some((i) => i.action === 'ADD_MONEY' && i.playerId === 'p2' && i.amount === 4));
});

test('resolveAuction: the winner is never included in the Near-Miss reward list', () => {
  let auction = startAuction('p1', 200, 'initiator', ['p2'], BANK_ID);
  auction = placeBid(auction, 'p2', 250, 1500);
  auction = placeBid(auction, 'p2', 400, 1500);

  const settlement = resolveAuction(auction);
  // commission goes to initiator (not p2); no near-miss for p2 (they won)
  const addMoneyIntents = settlement.intents.filter((i) => i.action === 'ADD_MONEY' && i.playerId === 'p2');
  assert.equal(addMoneyIntents.length, 0);
});

test('resolveAuction: throws if auction is null', () => {
  assert.throws(() => resolveAuction(null), TypeError);
});


// ---- Folding withdraws the folder's bid (2026-09-02, found by fuzzing) ----
//
// foldBidder used to remove the player from activeBidders and leave
// highestBidderId/currentBid alone, so a leader who folded still won and was
// charged. The same line let applyBankruptcy hand a property to a player it
// had just eliminated — see turnMachine.test.js for that integration case.

test('foldBidder: a leader who folds withdraws their bid and the auction falls back to the best surviving one', () => {
  let auction = startAuction('p1', 100, 'initiator', ['p2', 'p3'], BANK_ID);
  auction = placeBid(auction, 'p2', 200, 1000);
  auction = placeBid(auction, 'p3', 300, 1000);
  assert.equal(auction.highestBidderId, 'p3');

  auction = foldBidder(auction, 'p3'); // the LEADER folds
  assert.equal(auction.highestBidderId, 'p2', 'falls back to the best bid still standing');
  assert.equal(auction.currentBid, 200);

  const settled = resolveAuction(auction);
  assert.equal(settled.status, 'SETTLED');
  assert.equal(settled.winnerId, 'p2', 'the folder must not win');
});

test('foldBidder: the last bidder folding leaves the auction with no winner at all', () => {
  let auction = startAuction('p1', 100, 'initiator', ['p2', 'p3'], BANK_ID);
  auction = placeBid(auction, 'p2', 250, 1000);
  auction = foldBidder(auction, 'p2');

  assert.equal(auction.highestBidderId, null);
  assert.equal(auction.currentBid, 100, 'resets to basePrice — no live bid remains');
  assert.equal(resolveAuction(auction).status, 'FAILED');
});

test('foldBidder: the bid log itself is never pruned — Near-Miss is about who competed', () => {
  let auction = startAuction('p1', 100, 'initiator', ['p2', 'p3'], BANK_ID);
  auction = placeBid(auction, 'p2', 200, 1000);
  auction = placeBid(auction, 'p3', 300, 1000);
  const before = auction.bids.length;
  auction = foldBidder(auction, 'p3');
  assert.equal(auction.bids.length, before, 'a folder still genuinely bid');
});
