// Trade proposal — pure data shape, mirrors property.js/room.js: no I/O, no
// database driver, no framework import. Not persisted anywhere yet — lives
// only on GameState.pendingTrades (domain/gameState.js), the same
// "in-memory only, no schema change" standing as GameState.pendingAuction.
// No `trades` Postgres table exists; this is intentional, not an oversight
// — see stateMachine/tradeMachine.js's file header for the "asset lock
// computed on the fly, not persisted" decision this shape supports.

export const TRADE_STATUSES = Object.freeze(['PROPOSED', 'COUNTERED', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'EXPIRED']);

// GAME_DESIGN_SPEC.md §10's own [OPEN DESIGN DECISION] ("what's tradeable...
// multi-item offers; counter-offers?") is answered here, on explicit
// instruction, same standing as Flash Auction V0's confirmation: strictly
// 1-vs-1, properties + money only (no jail-free cards or other asset types —
// nothing elsewhere in this codebase models one as tradeable), no
// conditional trades, counters allowed up to MAX_COUNTER_DEPTH.
export const MAX_COUNTER_DEPTH = 5;
export const TRADE_EXPIRY_SECONDS = 60;

/**
 * @typedef {Object} TradeOffer
 * @property {string[]} properties - Property.id[] (properties.id, the game-scoped ownership row) — NOT board_tiles.id/tileIndex, matching every other property-referencing action already shipped (BUILD_HOUSE/SELL_HOUSE/MORTGAGE/UNMORTGAGE all use propertyId)
 * @property {number} money - non-negative integer
 */

/**
 * @typedef {Object} Trade
 * @property {string} id - uuid
 * @property {string} roomId
 * @property {string} proposerId - PlayerGameState.id
 * @property {string} targetId - PlayerGameState.id
 * @property {TradeOffer} proposerOffer
 * @property {TradeOffer} targetOffer
 * @property {(typeof TRADE_STATUSES[number])} status - only ever 'PROPOSED' for an entry actually sitting in GameState.pendingTrades; the other five are terminal and imply removal from that array (see tradeMachine.js) — kept on the type for completeness/future persistence, not because a live entry's status ever varies today
 * @property {string} createdAt - ISO timestamp
 * @property {string} expiresAt - ISO timestamp, createdAt + TRADE_EXPIRY_SECONDS
 * @property {number} counterDepth - 0 for an original proposal; +1 per COUNTER_TRADE
 * @property {string|null} previousTradeId - the trade this one countered, if any — null for an original proposal
 */

/**
 * @param {Partial<Trade>} fields
 * @returns {Trade}
 */
export function createTrade(fields) {
  if (!TRADE_STATUSES.includes(fields.status)) {
    throw new TypeError(`createTrade: unknown status '${fields.status}'`);
  }
  const counterDepth = fields.counterDepth ?? 0;
  if (!Number.isInteger(counterDepth) || counterDepth < 0) {
    throw new TypeError(`createTrade: counterDepth must be a non-negative integer — got ${counterDepth}`);
  }
  if (fields.proposerId === fields.targetId) {
    throw new TypeError('createTrade: proposerId and targetId must differ');
  }

  return {
    id: fields.id,
    roomId: fields.roomId,
    proposerId: fields.proposerId,
    targetId: fields.targetId,
    proposerOffer: { properties: [...(fields.proposerOffer?.properties ?? [])], money: fields.proposerOffer?.money ?? 0 },
    targetOffer: { properties: [...(fields.targetOffer?.properties ?? [])], money: fields.targetOffer?.money ?? 0 },
    status: fields.status,
    createdAt: fields.createdAt,
    expiresAt: fields.expiresAt,
    counterDepth,
    previousTradeId: fields.previousTradeId ?? null,
  };
}
