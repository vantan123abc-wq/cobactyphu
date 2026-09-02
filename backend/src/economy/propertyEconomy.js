// Property economy functions — ECONOMY_SPECIFICATION.md §3 (Money Flows,
// rows 2/11/12/13/14) and §8 (Balance Model). Pure function: no I/O, no
// database driver, no Express, no Socket.IO, no business-rule validation
// (e.g. "upgradeLevel must be 0 to mortgage") — that belongs to a later
// orchestration/validation layer, not here. Each function returns an
// intent object — amount, direction, transactionType — ready to feed
// applyTransaction.js (P06-T01); none of them move any coins themselves.
//
// Rounding: neither §3 nor §8 states a rounding rule for the two
// fractional cases (HOUSE_SELLBACK_RATIO × houseCost, MORTGAGE_INTEREST_RATE
// × mortgageValue) — both are still "BALANCE TBD". Convention used here,
// consistent with bankruptcy.js: floor when the player receives money
// (never round a payout up in their favor), ceil when the player pays
// money (never round a cost down in their favor). One-house/hotel unit at
// a time for build/sell — not scaled by upgradeLevel, unlike
// bankruptcy.js's full-liquidation scenario, which is a different context.

export const HOUSE_SELLBACK_RATIO = 0.5; // ECONOMY_SPECIFICATION.md §8, classic half-price, BALANCE TBD
export const MORTGAGE_INTEREST_RATE = 1.1; // ECONOMY_SPECIFICATION.md §3 row 14 / §8, BALANCE TBD

/**
 * @typedef {Object} TransactionIntent
 * @property {number} amount
 * @property {('purchase'|'mortgage'|'unmortgage'|'build'|'sell_house')} transactionType
 * @property {('player_to_bank'|'bank_to_player')} direction
 */

/** §3 row 2. @param {import('../domain/tile.js').Tile} tile @returns {TransactionIntent} */
export function calculatePurchase(tile) {
  return { amount: tile.price, transactionType: 'purchase', direction: 'player_to_bank' };
}

/** §3 row 13. @param {import('../domain/tile.js').Tile} tile @returns {TransactionIntent} */
export function calculateMortgage(tile) {
  return { amount: tile.mortgageValue, transactionType: 'mortgage', direction: 'bank_to_player' };
}

/**
 * §3 row 14. Integer-safe equivalent of `tile.mortgageValue * MORTGAGE_INTEREST_RATE`
 * (1.1 === 11/10 exactly) — the float-multiplication form overcharged the
 * player by $1 on ~5% of mortgageValue values (e.g. `100 * 1.1 ===
 * 110.00000000000001` in IEEE-754, so `Math.ceil` rounded up to 111 instead
 * of 110). Finding #26, PROJECT_STATUS.md. If MORTGAGE_INTEREST_RATE's value
 * ever changes from 1.1, this literal `11/10` must change with it.
 * @param {import('../domain/tile.js').Tile} tile @returns {TransactionIntent}
 */
export function calculateUnmortgage(tile) {
  return {
    amount: Math.ceil((tile.mortgageValue * 11) / 10),
    transactionType: 'unmortgage',
    direction: 'player_to_bank',
  };
}

/** §3 row 11, one house/hotel unit. @param {import('../domain/tile.js').Tile} tile @returns {TransactionIntent} */
export function calculateBuildHouse(tile) {
  return { amount: tile.houseCost, transactionType: 'build', direction: 'player_to_bank' };
}

/** §3 row 12, one house/hotel unit. @param {import('../domain/tile.js').Tile} tile @returns {TransactionIntent} */
export function calculateSellHouse(tile) {
  return {
    amount: Math.floor(tile.houseCost * HOUSE_SELLBACK_RATIO),
    transactionType: 'sell_house',
    direction: 'bank_to_player',
  };
}
