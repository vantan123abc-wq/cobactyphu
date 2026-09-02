// Flash Auction — V2 "Nhà Môi Giới" (Broker) Contract. Pure function: no I/O, no database
// driver, no Express, no Socket.IO, no timers — same boundary as V1.
//
// V2 supersedes V1's "Strategic Denial" framing with a richer three-way
// decision triangle: the player who lands on unowned property now has three
// distinct actions (BOARD_SPECIFICATION.md §"Flash Auction V2"):
//
//   BUY_PROPERTY  — pay basePrice, own it immediately.
//   SKIP_PURCHASE — free, end your obligation, land stays unowned.
//   FORCE_AUCTION — pay a fee (calculateAuctionFee) to open a live auction;
//                   in return, receive a broker commission (calculateBrokerCommission)
//                   of 20% of the final winning bid, paid by the Bank.
//
// The commission is Bank-funded (not extracted from the winner's bid price),
// preserving the closed-economy invariant (ECONOMY_SPECIFICATION.md §4):
// the winner pays their bid to the Bank normally; the Bank then separately
// pays the commission to the initiator — two real applyTransaction calls,
// both conserving. The initiator's net position is:
//   commission (20% × winningBid) − fee (5% × basePrice, clamped [20, 80])
// which can be negative if the auction settles barely above base price.
//
// Anti-abuse rule (prevents "fee-free market research"): after a FAILED
// auction the initiator cannot buy the property in the same turn. The
// caller (turnMachine.js's settleAuction) enforces this by always routing
// to POST_ACTIONS regardless of auction outcome — never back to
// AWAITING_PURCHASE.
//
// V1 change log preserved here for traceability:
//   V0 → V1: opening bid changed from 50% to 100% of basePrice (denial tool).
//   V1 → V2: DECLINE_PURCHASE split into SKIP_PURCHASE (free) and
//             FORCE_AUCTION (fee + broker commission). Commission replaces
//             Near-Miss reward as the primary player-facing incentive.
//             Near-Miss reward is RETAINED as a secondary incentive for
//             active bidders who narrowly lost — unchanged from V1.
//
// Rounding: same convention as V1 — floor when the player receives money,
// ceil when the player pays — the only precedent in this codebase.

// New in V1, not present before: calculateAuctionFee, the initiator concept
// on AuctionState, a per-bid history log (needed for Near-Miss eligibility,
// which depends on a bidder's own bid count and their own highest bid, not
// just the single global current-high), and settlement intents that name an
// explicit playerId per intent — unlike a normal turn action, an auction's
// settlement touches multiple distinct players (the winner pays, zero or
// more near-miss losers get a consolation reward), so there's no single
// "current player" context to imply a target the way turnMachine.js's
// other settlements can.
//
// Rounding: neither this task nor any doc states a rounding rule for the
// two fractional formulas below (auction fee, near-miss reward). Applied
// propertyEconomy.js's own documented convention here — floor when the
// player receives money, ceil when the player pays — since it's the only
// precedent in this codebase and the fee/reward clamps (20/80/50) are
// already integers either way.

export class InvalidBidError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'InvalidBidError';
    this.reason = reason;
  }
}

/**
 * @typedef {Object} AuctionBid
 * @property {string} playerId
 * @property {number} amount
 */

/**
 * @typedef {Object} AuctionState
 * @property {string} propertyId - Property.id (properties table row), not the static Tile.id
 * @property {number} basePrice - the property's normal purchase price; also the auction's opening bid floor
 * @property {number} currentBid - highest absolute bid so far; starts equal to basePrice
 * @property {string|null} highestBidderId - PlayerGameState.id of the current leader; null until the first accepted bid
 * @property {string[]} activeBidders - PlayerGameState.id[] of players still eligible to bid (haven't folded)
 * @property {string} initiatorId - PlayerGameState.id of the player who paid the fee and receives broker commission on SETTLED (V2)
 * @property {string} bankId - PlayerGameState.id of the Bank sentinel row; used to generate commission transfer intents (V2)
 * @property {AuctionBid[]} bids - append-only log of every accepted bid, in the order placed; drives Near-Miss eligibility in resolveAuction
 */

/**
 * Rule 1 — the cost to open a FORCE_AUCTION. 5% of basePrice, clamped to
 * [20, 80]; ceiled within that range since this is money the initiator pays
 * (never round a cost down in the payer's favor).
 * @param {number} basePrice
 * @returns {number}
 */
export function calculateAuctionFee(basePrice) {
  if (typeof basePrice !== 'number' || basePrice <= 0) {
    throw new TypeError(`calculateAuctionFee: basePrice must be a positive number — got ${basePrice}`);
  }
  return Math.ceil(Math.max(20, Math.min(80, basePrice * 0.05)));
}

/**
 * Rule 1b (V2) — the broker commission the initiator earns when the auction
 * SETTLES. 20% of the final winning bid, floored (received money).
 * Paid by the Bank to the initiator — two separate intents in resolveAuction
 * so the closed-economy invariant stays exact. A commission that floors to 0
 * is a degenerate case (winningBid would need to be < $5) — handled by
 * resolveAuction omitting the pair of intents entirely.
 * @param {number} winningBid
 * @returns {number}
 */
export function calculateBrokerCommission(winningBid) {
  if (typeof winningBid !== 'number' || winningBid <= 0) {
    throw new TypeError(`calculateBrokerCommission: winningBid must be a positive number — got ${winningBid}`);
  }
  return Math.floor(winningBid * 0.20);
}


function requireActiveBidder(auction, playerId, fnName) {
  if (!auction.activeBidders.includes(playerId)) {
    throw new InvalidBidError(
      'BIDDER_NOT_ACTIVE',
      `${fnName}: '${playerId}' is not an active bidder in this auction (never eligible, or already folded)`
    );
  }
}

/**
 * Rule 2 (V2) — starts an auction at the property's full base price.
 * Called by turnMachine.js's FORCE_AUCTION handler after the fee has
 * already been charged. `bankId` is new in V2: needed so resolveAuction
 * can generate the correct commission intents (Bank → initiator) without
 * this module needing to know how to locate the Bank from GameState.
 * @param {string} propertyId - Property.id
 * @param {number} basePrice - the property's normal purchase price
 * @param {string} initiatorId - PlayerGameState.id of the player who paid the fee
 * @param {string[]} allPlayers - PlayerGameState.id[] of every eligible bidder (caller excludes Bank and bankrupt)
 * @param {string} bankId - PlayerGameState.id of the Bank sentinel row
 * @returns {AuctionState}
 */
export function startAuction(propertyId, basePrice, initiatorId, allPlayers, bankId) {
  if (typeof basePrice !== 'number' || basePrice <= 0) {
    throw new TypeError(`startAuction: basePrice must be a positive number — got ${basePrice}`);
  }
  if (!bankId) {
    throw new TypeError('startAuction: bankId is required for V2 commission settlement');
  }

  return {
    propertyId,
    basePrice,
    currentBid: basePrice,
    highestBidderId: null,
    activeBidders: [...allPlayers],
    initiatorId,
    bankId,
    bids: [],
  };
}


/**
 * Absolute bid, strictly above the current high — unchanged from before,
 * still validated the same way. Now also appended to `bids`, which
 * resolveAuction's Near-Miss calculation depends on. No money moves here.
 * @param {AuctionState} auction
 * @param {string} bidderId
 * @param {number} amount
 * @param {number} bidderBalance
 * @returns {AuctionState}
 * @throws {InvalidBidError} bidder not active, bid not above currentBid, or insufficient balance
 */
export function placeBid(auction, bidderId, amount, bidderBalance) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new TypeError(`placeBid: amount must be a positive integer — got ${amount}`);
  }
  requireActiveBidder(auction, bidderId, 'placeBid');

  if (amount <= auction.currentBid) {
    throw new InvalidBidError(
      'BID_TOO_LOW',
      `placeBid: amount ${amount} does not exceed the current bid ${auction.currentBid}`
    );
  }
  if (bidderBalance < amount) {
    throw new InvalidBidError(
      'INSUFFICIENT_BALANCE',
      `placeBid: bidder balance ${bidderBalance} is less than bid amount ${amount}`
    );
  }

  return {
    ...auction,
    currentBid: amount,
    highestBidderId: bidderId,
    bids: [...auction.bids, { playerId: bidderId, amount }],
  };
}

/**
 * Voluntary withdrawal from further bidding — unchanged from before. Only
 * removes eligibility to raise again; does not retract a bid already
 * placed (still on the `bids` log, still counts toward Near-Miss), and the
 * current highest bidder may fold and still win.
 * @param {AuctionState} auction
 * @param {string} playerId
 * @returns {AuctionState}
 * @throws {InvalidBidError} playerId is not currently an active bidder
 */
export function foldBidder(auction, playerId) {
  requireActiveBidder(auction, playerId, 'foldBidder');
  const activeBidders = auction.activeBidders.filter((id) => id !== playerId);

  // Folding WITHDRAWS the folder's bids (fixed 2026-09-02, found by fuzzing).
  // This used to drop the player from `activeBidders` and leave
  // `highestBidderId`/`currentBid` untouched, so a leader who folded still
  // won the auction and was charged for it — which made FOLD_AUCTION
  // meaningless for the one player it matters most to.
  //
  // The same line corrupted state on a path nobody drives by hand:
  // applyBankruptcy folds a bankrupt/forfeiting player out of a live auction,
  // so an eliminated player could still be named winner and have the property
  // TRANSFERRED TO THEM after their own bankruptcy settlement had already
  // run — leaving a bankrupt player owning property, which every other part
  // of the engine assumes cannot happen.
  //
  // The fix reads the winner back off the `bids` log (append-only, already
  // maintained for Near-Miss) restricted to bidders who are still in: the
  // auction falls back to the best surviving bid, or to FAILED (highestBidderId
  // null) if nobody is left holding one. `bids` itself is deliberately NOT
  // pruned — Near-Miss eligibility is about who genuinely competed, and a
  // player who bid and later folded still did.
  const survivingBids = auction.bids.filter((b) => activeBidders.includes(b.playerId));
  const best = survivingBids.reduce((top, b) => (top === null || b.amount > top.amount ? b : top), null);

  return {
    ...auction,
    activeBidders,
    highestBidderId: best ? best.playerId : null,
    currentBid: best ? best.amount : auction.basePrice,
  };
}

/**
 * Rule 3 (V2) — settlement, with broker commission and Near-Miss rewards.
 *
 * FAILED: highestBidderId is still null — no bids were accepted. Property
 * stays unowned. No commission (fee is already paid and non-refundable by
 * design — the risk of FORCE_AUCTION). Empty intents. commissionAmount null.
 *
 * SETTLED: four groups of intents in order:
 *   1. Winner pays their bid: REMOVE_MONEY winner → Bank (normal purchase).
 *   2. Property transfers to winner: TRANSFER_PROPERTY.
 *   3. Broker commission — Bank pays initiator 20% of winning bid:
 *        REMOVE_MONEY from bankId + ADD_MONEY to initiatorId.
 *      Omitted entirely if commission floors to 0 (degenerate; winningBid
 *      would need to be < $5). initiator === winner is allowed — they opened
 *      a market they also won; commission still applies.
 *   4. Near-Miss rewards (unchanged from V1): any loser with >= 2 bids whose
 *      highest bid >= 90% of winning bid earns 2% of the premium, floored,
 *      capped at $50; a $0 reward is omitted.
 *
 * @param {AuctionState} auction
 * @returns {{
 *   status: 'FAILED'|'SETTLED',
 *   propertyId: string,
 *   winnerId: string|null,
 *   commissionAmount: number|null,
 *   intents: Array<
 *     | { action: 'REMOVE_MONEY', playerId: string, amount: number }
 *     | { action: 'ADD_MONEY', playerId: string, amount: number }
 *     | { action: 'TRANSFER_PROPERTY', propertyId: string, toPlayerId: string }
 *   >,
 * }}
 */
export function resolveAuction(auction) {
  if (!auction) {
    throw new TypeError('resolveAuction: auction is required');
  }

  if (auction.highestBidderId === null) {
    return { status: 'FAILED', propertyId: auction.propertyId, winnerId: null, commissionAmount: null, intents: [] };
  }

  const winnerId = auction.highestBidderId;
  const winningBid = auction.currentBid;

  // --- Broker commission (V2) — Bank → initiator ---
  // ADD_MONEY intent is sufficient: applyIntents routes ADD_MONEY as
  // { fromPlayerId: bankId, toPlayerId: initiatorId } internally, which is
  // a normal applyTransaction and correctly debits the Bank. A separate
  // REMOVE_MONEY intent for the Bank would incorrectly route through
  // chargePlayer() → applyTransaction({ from: bank, to: bank }), crashing
  // with "fromPlayerId and toPlayerId must differ".
  const commission = calculateBrokerCommission(winningBid);
  const commissionIntents = commission > 0
    ? [{ action: 'ADD_MONEY', playerId: auction.initiatorId, amount: commission }]
    : [];

  // --- Near-Miss rewards (unchanged from V1) ---
  const statsByPlayer = new Map();
  for (const bid of auction.bids) {
    const existing = statsByPlayer.get(bid.playerId) ?? { count: 0, highestBid: -Infinity };
    statsByPlayer.set(bid.playerId, {
      count: existing.count + 1,
      highestBid: Math.max(existing.highestBid, bid.amount),
    });
  }

  const nearMissIntents = [];
  for (const [playerId, stats] of statsByPlayer) {
    if (playerId === winnerId) continue;

    const eligible = stats.count >= 2 && stats.highestBid >= winningBid * 0.9;
    if (!eligible) continue;

    const reward = Math.min(50, Math.floor((winningBid - auction.basePrice) * 0.02));
    if (reward <= 0) continue;

    nearMissIntents.push({ action: 'ADD_MONEY', playerId, amount: reward });
  }

  return {
    status: 'SETTLED',
    propertyId: auction.propertyId,
    winnerId,
    commissionAmount: commission > 0 ? commission : null,
    intents: [
      { action: 'REMOVE_MONEY', playerId: winnerId, amount: winningBid },
      { action: 'TRANSFER_PROPERTY', propertyId: auction.propertyId, toPlayerId: winnerId },
      ...commissionIntents,
      ...nearMissIntents,
    ],
  };
}

