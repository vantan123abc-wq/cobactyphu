// Trap system (ROADBLOCK / TOLL_BOOTH) — the last unimplemented piece of
// docs/ASYMMETRIC_MODE_SPEC.md's ORIGINAL V1 draft. `GameState.activeTraps`
// and movementMiddleware.js's own ROADBLOCK check have existed since this
// mode was first sketched, with zero writers anywhere in the codebase —
// this file is the first one.
//
// Note on scope: the CURRENT spec (V4, the archetype/synergy system this
// branch actually built and Monte-Carlo-tuned — CONTROL/ECONOMY/EXECUTION/
// MOBILITY) never mentions traps at all. CONTROL's STEP_LOSS already covers
// "force an opponent to stop early" and EXECUTION's toll already covers
// "charge money for crossing a hazard" — but both are PASSIVE and tied to
// owning enough tiles of an archetype. A trap is deliberately a different
// lever: an ACTIVE, one-turn-cost, placeable-on-ANY-tile tool — you can
// strike a tile you don't own, which nothing else in this mode lets you do.
// That is a genuinely different design space, not a duplicate of what
// shipped already, which is why this is worth building as its own thing
// rather than folding into synergyEngine.js.
//
// Design choices made here, all deliberate (see git history for the fuller
// reasoning):
//   - Placing a trap SPENDS a movement card (any card — its own steps/cost
//     become irrelevant) instead of moving this turn. No new phase, no new
//     deck entries — reuses PLAYING_CARD verbatim, and costs a whole turn's
//     tempo, the most expensive currency in this ruleset.
//   - ROADBLOCK is consumed the instant it stops someone (a one-shot
//     ambush); TOLL_BOOTH persists and charges every crossing until it
//     expires (a standing hazard, weaker per hit, recurring income to its
//     owner) — see this file's earlier review notes on why a permanently-
//     stacking ROADBLOCK was flagged as a real lockdown risk.
//   - Traps affect EVERYONE who crosses them, including their own owner —
//     unlike an archetype tile (which explicitly exempts its owner), a
//     placed trap is a physical hazard with no "safe at home" exemption.
//     Placing one is a real commitment, not a free lever.
//   - Expiry is lazy (expiresAtRound, compared against gameState.roundNumber)
//     rather than a decrementing counter — the same convention
//     synergyEngine.js's handRevealedTo already uses, and the one that
//     avoids V1's exact bug (a `duration` field nothing ever decremented).
//     Actual pruning of expired entries happens once per real round
//     boundary, in turnMachine.js's advanceTurn() — the same "wrapped"
//     checkpoint rentModifierPercent/buildCostModifierAmount already reset
//     on — so the array can't grow unbounded over a 45-round match even
//     though every single movement step reads it.

export const TRAP_TYPES = Object.freeze(['ROADBLOCK', 'TOLL_BOOTH']);
export const MAX_TRAPS_PER_PLAYER = 2;
export const TRAP_DURATION_ROUNDS = 5;
export const TOLL_BOOTH_AMOUNT = 100;

/** @param {{expiresAtRound: number}} trap @param {number} roundNumber */
export function isTrapActive(trap, roundNumber) {
  return roundNumber <= trap.expiresAtRound;
}

/**
 * @param {import('../domain/gameState.js').GameState} gameState
 * @returns {object[]} activeTraps filtered to not-yet-expired entries only
 */
export function activeTrapsOf(gameState) {
  return (gameState.activeTraps ?? []).filter((t) => isTrapActive(t, gameState.roundNumber));
}

/**
 * @param {import('../domain/gameState.js').GameState} gameState
 * @param {string} placerId
 * @param {number} targetPosition
 * @param {string} trapType
 * @param {number} boardTileCount
 * @returns {string|null} a rejection reason, or null when the placement is legal
 */
export function validateTrapPlacement(gameState, placerId, targetPosition, trapType, boardTileCount) {
  if (!TRAP_TYPES.includes(trapType)) {
    return 'UNKNOWN_TRAP_TYPE';
  }
  if (!Number.isInteger(targetPosition) || targetPosition < 0 || targetPosition >= boardTileCount) {
    return 'INVALID_POSITION';
  }

  const active = activeTrapsOf(gameState);
  // The user's own explicit requirement: no stacking two traps on one tile.
  // Checked against ANY owner's trap, not just the placer's own — a tile
  // already booby-trapped by someone else is just as occupied.
  if (active.some((t) => t.tileIndex === targetPosition)) {
    return 'TILE_OCCUPIED';
  }
  if (active.filter((t) => t.ownerId === placerId).length >= MAX_TRAPS_PER_PLAYER) {
    return 'TRAP_LIMIT_REACHED';
  }
  return null;
}

/**
 * @param {string} placerId
 * @param {number} targetPosition
 * @param {string} trapType
 * @param {number} roundNumber - gameState.roundNumber AT PLACEMENT time
 * @returns {{tileIndex: number, type: string, ownerId: string, expiresAtRound: number}}
 */
export function createTrap(placerId, targetPosition, trapType, roundNumber) {
  return { tileIndex: targetPosition, type: trapType, ownerId: placerId, expiresAtRound: roundNumber + TRAP_DURATION_ROUNDS };
}
