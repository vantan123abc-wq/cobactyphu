// Trade engine — GAME_DESIGN_SPEC.md §10's own [OPEN DESIGN DECISION],
// answered here on explicit instruction (see domain/trade.js's header for
// what was decided). Pure functions: no I/O, no database driver, no
// Express, no Socket.IO, no internal randomness or wall-clock reads — `now`
// and every id (`id`/`newTradeId`) always arrive as inputs, same convention
// dice.js/applyTransaction.js/timers.js already established. Same
// "compute, don't apply" boundary as auction.js/eventResolver.js: these
// functions return a new Trade record, or (acceptTrade) explicit
// {fromPlayerId, toPlayerId, amount} money transfers + {propertyId,
// toPlayerId} property transfers — deliberately NOT turnMachine.js's
// applyIntents vocabulary, whose ADD_MONEY/REMOVE_MONEY are hard-coded
// Bank-mediated and wrong for a direct player-to-player trade payment; see
// acceptTrade's own docstring below for the full reasoning. None of these
// functions mutate GameState themselves.
//
// Asset locking (crucial requirement) is computed on the fly from
// `pendingTrades` — every property/amount of money already offered in some
// *other* active trade is unavailable to a new proposal or counter, checked
// fresh against live GameState at both propose-time and accept-time (never
// trusted from when the offer was first made). No schema change, no
// persisted `locked` flag — same "GameState must be self-contained, no new
// DB column" precedent GameState.pendingAuction already set.

import { createTrade, TRADE_EXPIRY_SECONDS, MAX_COUNTER_DEPTH } from '../domain/trade.js';

function newlyProposedTrade({ id, roomId, proposerId, targetId, proposerOffer, targetOffer, now, counterDepth, previousTradeId }) {
  return createTrade({
    id,
    roomId,
    proposerId,
    targetId,
    proposerOffer,
    targetOffer,
    status: 'PROPOSED',
    createdAt: now,
    expiresAt: new Date(new Date(now).getTime() + TRADE_EXPIRY_SECONDS * 1000).toISOString(),
    counterDepth,
    previousTradeId,
  });
}

export class InvalidTradeError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'InvalidTradeError';
    this.reason = reason;
  }
}

function offerIsWellFormed(offer) {
  return (
    Boolean(offer) &&
    Array.isArray(offer.properties) &&
    offer.properties.every((id) => typeof id === 'string') &&
    new Set(offer.properties).size === offer.properties.length &&
    Number.isInteger(offer.money) &&
    offer.money >= 0
  );
}

/**
 * Every propertyId currently offered in any *other* active trade in
 * `pendingTrades` (excludeTradeId lets a trade's own offer re-validate
 * against itself at accept-time without self-locking).
 */
function lockedPropertyIds(pendingTrades, excludeTradeId) {
  const locked = new Set();
  for (const trade of pendingTrades) {
    if (trade.id === excludeTradeId) continue;
    for (const id of trade.proposerOffer.properties) locked.add(id);
    for (const id of trade.targetOffer.properties) locked.add(id);
  }
  return locked;
}

/** Sum of money playerId has already committed across other active trades. */
function lockedMoneyFor(pendingTrades, playerId, excludeTradeId) {
  let total = 0;
  for (const trade of pendingTrades) {
    if (trade.id === excludeTradeId) continue;
    if (trade.proposerId === playerId) total += trade.proposerOffer.money;
    if (trade.targetId === playerId) total += trade.targetOffer.money;
  }
  return total;
}

/**
 * Validates one side of a deal against live GameState: the offering player
 * really owns every offered property, none of it (property or money) is
 * already committed elsewhere, and the player's *unlocked* balance covers
 * the offered money. Shared by proposeTrade/counterTrade/acceptTrade for
 * both offer sides — the one place "cannot offer an asset you don't own or
 * is already locked" (the brief's own crucial requirement) is enforced.
 * @throws {TypeError} malformed offer shape or an unknown propertyId
 * @throws {InvalidTradeError} PLAYER_BANKRUPT / NOT_OWNER / ASSET_LOCKED / INSUFFICIENT_BALANCE
 */
function validateOffer(gameState, pendingTrades, playerId, offer, excludeTradeId) {
  if (!offerIsWellFormed(offer)) {
    throw new TypeError(`trade offer for '${playerId}' is malformed`);
  }

  // 2026-08-25: a bankrupt player is eliminated — spectator only, no
  // actions of any kind (GAME_DESIGN_SPEC.md §17). Every OTHER route was
  // already closed: advanceTurn() skips them so they can never be the
  // current player (which the socket layer's own NOT_YOUR_TURN guard then
  // blocks every turn-scoped action on), startAuction() excludes them from
  // eligibleBidders, and applyBankruptcy() drops any pending trade naming
  // them at the moment they go bankrupt. Trades were the one real hole:
  // they route through tradeMachine.js deliberately independent of both
  // turn and phase, so nothing stopped a NEW trade being proposed by — or
  // to — an already-eliminated player afterwards. A solvent player could
  // gift them property and effectively resurrect them mid-match.
  //
  // Checked here rather than in proposeTrade/counterTrade separately
  // because this one function is the shared choke point all three entry
  // points already funnel both offer sides through — which also means
  // acceptTrade re-checks it, correctly rejecting a trade whose
  // counterparty went bankrupt in between proposing and accepting.
  const offeringPlayer = gameState.players.find((p) => p.id === playerId);
  if (offeringPlayer?.bankrupt) {
    throw new InvalidTradeError('PLAYER_BANKRUPT', `'${playerId}' is bankrupt and can no longer take part in a trade`);
  }

  const lockedProperties = lockedPropertyIds(pendingTrades, excludeTradeId);
  for (const propertyId of offer.properties) {
    const property = gameState.properties.find((p) => p.id === propertyId);
    if (!property) {
      throw new TypeError(`trade offer references unknown propertyId '${propertyId}'`);
    }
    if (property.ownerId !== playerId) {
      throw new InvalidTradeError('NOT_OWNER', `'${playerId}' does not own property '${propertyId}'`);
    }
    if (lockedProperties.has(propertyId)) {
      throw new InvalidTradeError('ASSET_LOCKED', `property '${propertyId}' is already offered in another active trade`);
    }
  }

  if (offer.money > 0) {
    const player = gameState.players.find((p) => p.id === playerId);
    const alreadyLocked = lockedMoneyFor(pendingTrades, playerId, excludeTradeId);
    const available = player.currentBalance - alreadyLocked;
    if (offer.money > available) {
      throw new InvalidTradeError(
        'INSUFFICIENT_BALANCE',
        `'${playerId}' has ${available} unlocked balance (${player.currentBalance} total, ${alreadyLocked} locked in other trades) — offered ${offer.money}`
      );
    }
  }
}

/**
 * PROPOSE_TRADE. Validates both sides' offers against live GameState +
 * every other currently-active trade, then constructs a fresh Trade at
 * counterDepth 0.
 * @param {Object} params
 * @param {string} params.id - fresh uuid, caller-supplied (impure id generation lives at the Socket.IO layer, not here)
 * @param {string} params.roomId
 * @param {import('../domain/gameState.js').GameState} params.gameState
 * @param {import('../domain/trade.js').Trade[]} params.pendingTrades - already pruned of expired trades by the caller
 * @param {string} params.proposerId
 * @param {string} params.targetId
 * @param {import('../domain/trade.js').TradeOffer} params.proposerOffer
 * @param {import('../domain/trade.js').TradeOffer} params.targetOffer
 * @param {string} params.now - ISO timestamp
 * @returns {import('../domain/trade.js').Trade}
 */
export function proposeTrade({ id, roomId, gameState, pendingTrades, proposerId, targetId, proposerOffer, targetOffer, now }) {
  if (proposerId === targetId) {
    throw new InvalidTradeError('SELF_TRADE', 'proposeTrade: proposerId and targetId must differ');
  }
  const target = gameState.players.find((p) => p.id === targetId);
  if (!target || target.isBank) {
    throw new InvalidTradeError('NOT_A_PARTICIPANT', `proposeTrade: '${targetId}' is not a real player in this game`);
  }

  validateOffer(gameState, pendingTrades, proposerId, proposerOffer, null);
  validateOffer(gameState, pendingTrades, targetId, targetOffer, null);

  return newlyProposedTrade({ id, roomId, proposerId, targetId, proposerOffer, targetOffer, now, counterDepth: 0, previousTradeId: null });
}

/**
 * COUNTER_TRADE. The countering party is always `existingTrade.targetId`
 * (the recipient of the original offer) — flips to become the new trade's
 * proposerId, with the original proposerId as the new targetId. Rejects at
 * MAX_COUNTER_DEPTH (the brief's own anti-infinite-loop cap); the caller
 * (tradeMachine.js) is responsible for removing existingTrade from
 * pendingTrades, freeing its locks before this function is even reachable
 * via the normal flow — but pendingTrades passed in here should still
 * exclude it explicitly (excludeTradeId) so this function is correct
 * whether or not the caller already did that.
 * @param {Object} params
 * @param {string} params.id - fresh uuid for the new (counter) trade
 * @param {import('../domain/gameState.js').GameState} params.gameState
 * @param {import('../domain/trade.js').Trade[]} params.pendingTrades
 * @param {import('../domain/trade.js').Trade} params.existingTrade
 * @param {{ proposerOffer: import('../domain/trade.js').TradeOffer, targetOffer: import('../domain/trade.js').TradeOffer }} params.counterOffer
 * @param {string} params.now
 * @returns {import('../domain/trade.js').Trade}
 */
export function counterTrade({ id, gameState, pendingTrades, existingTrade, counterOffer, now }) {
  if (existingTrade.counterDepth >= MAX_COUNTER_DEPTH) {
    throw new InvalidTradeError(
      'MAX_COUNTER_DEPTH_EXCEEDED',
      `counterTrade: trade '${existingTrade.id}' is already at the maximum counter depth (${MAX_COUNTER_DEPTH})`
    );
  }

  const newProposerId = existingTrade.targetId;
  const newTargetId = existingTrade.proposerId;

  validateOffer(gameState, pendingTrades, newProposerId, counterOffer.proposerOffer, existingTrade.id);
  validateOffer(gameState, pendingTrades, newTargetId, counterOffer.targetOffer, existingTrade.id);

  return newlyProposedTrade({
    id,
    roomId: existingTrade.roomId,
    proposerId: newProposerId,
    targetId: newTargetId,
    proposerOffer: counterOffer.proposerOffer,
    targetOffer: counterOffer.targetOffer,
    now,
    counterDepth: existingTrade.counterDepth + 1,
    previousTradeId: existingTrade.id,
  });
}

/**
 * ACCEPT_TRADE. Only `trade.targetId` may accept — you accept a deal made
 * *to* you, never your own proposal. Re-validates both offers against live
 * GameState (never trusted just because they passed validation when the
 * trade was first proposed/countered — ownership or balance could have
 * changed since).
 *
 * Returns explicit {fromPlayerId, toPlayerId, amount} money transfers and
 * {propertyId, toPlayerId} property transfers — deliberately NOT
 * turnMachine.js's applyIntents ADD_MONEY/REMOVE_MONEY vocabulary. That
 * vocabulary's ADD_MONEY/REMOVE_MONEY are hard-coded Bank-mediated
 * (fromPlayerId/toPlayerId is always the Bank on one side, see
 * applyIntents' own implementation) — correct for auction settlements and
 * event-card payouts, both always player-vs-Bank, but wrong here: a trade
 * payment is a direct player-to-player transfer, and routing it through two
 * separate Bank-mediated legs would both misrepresent the transaction (two
 * ledger rows through the Bank instead of one direct row between the two
 * real parties) and silently launder it through the Bank's balance for no
 * reason. The correct precedent already in this codebase is
 * turnMachine.js's settleDebt() (rent payments) calling
 * economy/applyTransaction.js directly with the real fromPlayerId/
 * toPlayerId — tradeMachine.js's ACCEPT_TRADE handler does the same, one
 * applyTransaction call per direction (up to 2, kept separate rather than
 * netted, matching DATABASE_DESIGN.md §12's "one row is one complete,
 * atomic money movement" philosophy), plus a direct properties-array
 * update for each property transfer.
 * @param {Object} params
 * @param {import('../domain/gameState.js').GameState} params.gameState
 * @param {import('../domain/trade.js').Trade[]} params.pendingTrades - excluding trade itself is not required; validateOffer's excludeTradeId handles that
 * @param {import('../domain/trade.js').Trade} params.trade
 * @param {string} params.actorId
 * @returns {{
 *   moneyTransfers: Array<{ fromPlayerId: string, toPlayerId: string, amount: number }>,
 *   propertyTransfers: Array<{ propertyId: string, toPlayerId: string }>,
 * }}
 */
export function acceptTrade({ gameState, pendingTrades, trade, actorId }) {
  if (actorId !== trade.targetId) {
    throw new InvalidTradeError('NOT_TARGET', `acceptTrade: only '${trade.targetId}' may accept trade '${trade.id}'`);
  }

  validateOffer(gameState, pendingTrades, trade.proposerId, trade.proposerOffer, trade.id);
  validateOffer(gameState, pendingTrades, trade.targetId, trade.targetOffer, trade.id);

  const moneyTransfers = [];
  if (trade.proposerOffer.money > 0) {
    moneyTransfers.push({ fromPlayerId: trade.proposerId, toPlayerId: trade.targetId, amount: trade.proposerOffer.money });
  }
  if (trade.targetOffer.money > 0) {
    moneyTransfers.push({ fromPlayerId: trade.targetId, toPlayerId: trade.proposerId, amount: trade.targetOffer.money });
  }

  const propertyTransfers = [
    ...trade.proposerOffer.properties.map((propertyId) => ({ propertyId, toPlayerId: trade.targetId })),
    ...trade.targetOffer.properties.map((propertyId) => ({ propertyId, toPlayerId: trade.proposerId })),
  ];

  return { moneyTransfers, propertyTransfers };
}
