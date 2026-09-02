// Bank sentinel handling — ECONOMY_SPECIFICATION.md §0: the Bank is a
// finite ledger participant whose balance is allowed to go negative, with
// no bankruptcy consequence of its own. Pure function: no I/O, no database
// driver, no Express, no Socket.IO.
//
// There is no separate "derive from scratch" formula here on purpose:
// PlayerGameState.currentBalance for the isBank:true row is already the
// correctly, incrementally derived balance for the current stateVersion —
// applyTransaction.js (P06-T01) updates it exactly like any other
// participant's, with no special-casing and no `>= 0` check. This file's
// job is just to expose that safely, plus the explicit test coverage this
// task calls for (going negative should be a "do nothing extra" case, not
// something worth guessing about).

/**
 * @param {import('../domain/gameState.js').GameState} gameState
 * @returns {import('../domain/gameState.js').PlayerGameState} the Bank sentinel row
 */
export function getBankPlayer(gameState) {
  const bankPlayers = gameState.players.filter((p) => p.isBank);

  if (bankPlayers.length === 0) {
    throw new TypeError('getBankPlayer: gameState.players has no Bank sentinel row (isBank: true)');
  }
  if (bankPlayers.length > 1) {
    throw new TypeError(
      `getBankPlayer: expected exactly one Bank sentinel row, found ${bankPlayers.length}`
    );
  }

  return bankPlayers[0];
}

/**
 * @param {import('../domain/gameState.js').GameState} gameState
 * @returns {number} the Bank's current balance — may be negative, that's not an error (ECONOMY_SPECIFICATION.md §0)
 */
export function getBankBalance(gameState) {
  return getBankPlayer(gameState).currentBalance;
}
