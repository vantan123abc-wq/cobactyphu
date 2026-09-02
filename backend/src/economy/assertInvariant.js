// Closed-economy invariant assertion — ECONOMY_SPECIFICATION.md §4:
// Σ(player.balance for all players) + bank.balance = MATCH_POOL, at every
// point after MATCH_POOL is instantiated. Pure function: no I/O, no
// database driver, no Express, no Socket.IO.
//
// gameState.players (P04-T01) already includes the Bank sentinel row as
// one of its entries — so "Σ players + bank" from the doc's formula is
// just Σ(currentBalance) across the whole array here. Filtering the bank
// out and adding it back separately would risk double-counting or, worse,
// omitting it if the two halves aren't kept in sync — summing the array
// once, uniformly, sidesteps that class of bug entirely.
//
// MATCH_POOL (== BANK_RESERVE_INITIAL, ECONOMY_SPECIFICATION.md §0 — not
// BANK_RESERVE_INITIAL + playerCount×STARTING_BALANCE; players' starting
// cash is dealt *from* the Bank's reserve, not added on top of it) is a
// fixed value set once at match start. It isn't a GameState field — the
// caller supplies it, computed once at STARTING and reused for every check
// across the match's lifetime.
//
// Usable both as a test helper (this phase) and, later, wired into a
// monitoring job (P16-T01), per the plan's own implementation note.

export class EconomyInvariantError extends Error {
  /**
   * @param {number} matchPool - the expected, fixed total
   * @param {number} actualTotal - Σ(currentBalance) actually found in gameState.players
   */
  constructor(matchPool, actualTotal) {
    const difference = actualTotal - matchPool;
    const explanation =
      difference > 0
        ? `${difference} coin(s) appeared from nowhere`
        : `${-difference} coin(s) vanished`;
    super(
      `Economy invariant violated: expected total ${matchPool}, got ${actualTotal} (${explanation})`
    );
    this.name = 'EconomyInvariantError';
    this.matchPool = matchPool;
    this.actualTotal = actualTotal;
    this.difference = difference;
  }
}

/**
 * @param {import('../domain/gameState.js').GameState} gameState
 * @param {number} matchPool - the fixed total established at match start (== BANK_RESERVE_INITIAL)
 * @returns {true} if the invariant holds
 * @throws {EconomyInvariantError} if Σ(gameState.players[].currentBalance) !== matchPool
 */
export function verifyEconomyInvariant(gameState, matchPool) {
  const actualTotal = gameState.players.reduce((sum, player) => sum + player.currentBalance, 0);

  if (actualTotal !== matchPool) {
    throw new EconomyInvariantError(matchPool, actualTotal);
  }

  return true;
}
