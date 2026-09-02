// Real bankruptcy settlement — Win Condition design (2026-08-19),
// GAME_DESIGN_SPEC.md §16. Pure function: no I/O, no mutation, same
// "compute, don't apply" boundary bankruptcy.js's own header already draws
// ("does not move any coins or transfer any property. That's P06's job") —
// turnMachine.js is what actually mutates GameState from this function's
// output, the same relationship auction.js's resolveAuction()/trade.js's
// acceptTrade() already have with their own callers.
//
// Deliberately NOT the same shape as checkSolvency()'s creditorReceives —
// that figure describes a cash-liquidation settlement ("sell things,  pay
// the difference in cash"), which is what LIQUIDATION_REQUIRED does while
// a player is merely cash-short but still solvent. Genuine bankruptcy
// (checkSolvency().isBankrupt === true) is a different, simpler moment:
// hand over everything remaining, in kind — every property exactly as it
// sits (mortgage flag untouched; the new owner inherits the mortgage, not
// forced to clear it on transfer) plus whatever cash is left. This matches
// GAME_DESIGN_SPEC.md §16's own prose ("that player's remaining properties
// transfer to the creditor... if owed to the Bank, properties return to
// the Bank, unowned, purchasable again") rather than checkSolvency()'s
// cash-centric framing, which was never meant to describe this step.

/**
 * @param {import('../domain/gameState.js').GameState} gameState
 * @param {string} debtorId - PlayerGameState.id, the bankrupt player
 * @param {string} creditorId - PlayerGameState.id of whoever was owed the debt (a real player, or the Bank sentinel row)
 * @returns {{
 *   propertyTransfers: Array<{ propertyId: string, toPlayerId: string|null }>,
 *   cashAmount: number,
 * }}
 */
export function computeBankruptcySettlement(gameState, debtorId, creditorId) {
  const debtor = gameState.players.find((p) => p.id === debtorId);
  const creditor = gameState.players.find((p) => p.id === creditorId);
  const ownedProperties = gameState.properties.filter((p) => p.ownerId === debtorId);

  // A debt owed to the Bank reverts properties to unowned (ownerId null,
  // purchasable again) rather than "owned by the Bank" — GAME_DESIGN_SPEC.md
  // §16's own distinction between the two creditor cases.
  const newOwnerId = creditor.isBank ? null : creditorId;

  return {
    propertyTransfers: ownedProperties.map((p) => ({ propertyId: p.id, toPlayerId: newOwnerId })),
    cashAmount: debtor.currentBalance,
  };
}
