// Bankruptcy detection — ECONOMY_SPECIFICATION.md §5, GAME_DESIGN_SPEC.md
// §16. Pure calculation: no I/O, no database driver, no Express, no
// Socket.IO. Computes *whether* and *how much* is recoverable only — it
// does not move any coins or transfer any property. That's P06's job
// (SECURITY_DESIGN.md threat #15's atomic-transaction concern lives there,
// not here).
//
// Imports HOUSE_SELLBACK_RATIO from economy/propertyEconomy.js (P06-T03)
// rather than a second hardcoded /2 — one named constant, not two
// independently-maintained magic numbers for the same "half price" rule.
// Still a pure-to-pure import (no DB/Express/Socket.IO either side).

import { HOUSE_SELLBACK_RATIO } from '../economy/propertyEconomy.js';

/**
 * House/hotel sell-back value alone — HOUSE_SELLBACK_RATIO of houseCost per
 * upgrade level, 0 if mortgaged (can't have houses while mortgaged, the
 * upgrade system's own precondition) or unimproved. Split out from
 * propertyLiquidationValue (Win Condition design, 2026-08-19) so
 * engine/netWorth.js can reuse exactly this term for its own building-value
 * component, without also pulling in the mortgage-recoverable term below —
 * net worth values land differently than a forced liquidation does (see
 * netWorth.js's own file header), so it needed the house term in isolation,
 * not the combined figure.
 * @param {import('../domain/tile.js').Tile} tile
 * @param {import('../domain/property.js').Property} property
 * @returns {number}
 */
export function houseSellBackValue(tile, property) {
  return !property.mortgaged && tile.houseCost != null && property.upgradeLevel > 0
    ? Math.floor(property.upgradeLevel * tile.houseCost * HOUSE_SELLBACK_RATIO)
    : 0;
}

/**
 * Liquidation value of a single held property: houseSellBackValue() above,
 * plus the full mortgageValue if not already mortgaged. An already-
 * mortgaged property contributes 0 for both terms — its mortgage value was
 * already realized. Checked explicitly here rather than assumed, since
 * this function doesn't control its own inputs.
 * @param {import('../domain/tile.js').Tile} tile
 * @param {import('../domain/property.js').Property} property
 * @returns {number}
 */
export function propertyLiquidationValue(tile, property) {
  const mortgageRecoverable =
    !property.mortgaged && tile.mortgageValue != null ? tile.mortgageValue : 0;

  return houseSellBackValue(tile, property) + mortgageRecoverable;
}

/**
 * @param {Object} params
 * @param {number} params.cashOnHand - the player's current cash
 * @param {number} params.debt - the amount owed
 * @param {Array<{tile: import('../domain/tile.js').Tile, property: import('../domain/property.js').Property}>} params.holdings
 *   - every property this player owns (mortgaged or not, improved or not)
 * @returns {{
 *   canPayInCash: boolean,
 *   totalLiquidatableValue: number,
 *   isBankrupt: boolean,
 *   creditorReceives: number,
 *   shortfall: number,
 * }}
 */
export function checkSolvency({ cashOnHand, debt, holdings }) {
  const canPayInCash = cashOnHand >= debt;

  const totalLiquidatableValue = holdings.reduce(
    (sum, { tile, property }) => sum + propertyLiquidationValue(tile, property),
    0
  );

  const totalAvailable = cashOnHand + totalLiquidatableValue;
  const isBankrupt = totalAvailable < debt;

  return {
    canPayInCash,
    totalLiquidatableValue,
    isBankrupt,
    // ECONOMY_SPECIFICATION.md §5: if liquidation still leaves a shortfall,
    // the creditor receives everything the bankrupt player had — not the
    // full sticker debt amount. If solvent, the debt is paid in full as
    // normal.
    creditorReceives: isBankrupt ? totalAvailable : debt,
    shortfall: isBankrupt ? debt - totalAvailable : 0,
  };
}
