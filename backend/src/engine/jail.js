// Jail — GAME_DESIGN_SPEC.md §15, GAME_STATE_MACHINE.md's JAIL_DECISION
// state. Pure function: no I/O, no database driver, no Express, no
// Socket.IO.
//
// Financial side effects (the JAIL_FINE payment) are never applied directly
// to PlayerGameState.currentBalance here — per P04-T01's own documented
// invariant, currentBalance is denormalized from SUM(game_transactions), the
// true source of truth. payFine/rollForExit instead return `fineOwed`
// alongside the updated player; recording the actual ledger entry and
// debiting currentBalance is the future orchestration layer's job, not this
// pure function's.

export const JAIL_FINE = 50; // GAME_DESIGN_SPEC.md §0, PROPOSED classic value
export const MAX_JAIL_TURNS = 3; // GAME_DESIGN_SPEC.md §0, PROPOSED classic value — "must pay or leave by the 3rd attempt"

function requireInJail(player, fnName) {
  if (!player.inJail) {
    throw new TypeError(`${fnName}: player is not in jail`);
  }
}

/**
 * Entry — GAME_DESIGN_SPEC.md §15: landing on go_to_jail, drawing a matching
 * card, or a 3rd consecutive double (dice.js's rollDice() `sentToJail`). All
 * three triggers converge on the same effect: relocate to the jail tile,
 * mark inJail, reset jailTurns — which trigger fired is the caller's
 * concern, not jail.js's.
 * @param {import('../domain/gameState.js').PlayerGameState} player
 * @param {number} jailPosition - board position of the Jail tile (Tile.position where tileType === 'jail')
 * @returns {import('../domain/gameState.js').PlayerGameState}
 */
export function sendToJail(player, jailPosition) {
  return { ...player, inJail: true, currentPosition: jailPosition, jailTurns: 0 };
}

/**
 * Exit path 1: pay JAIL_FINE, leave immediately.
 * @param {import('../domain/gameState.js').PlayerGameState} player
 * @returns {{ player: import('../domain/gameState.js').PlayerGameState, fineOwed: number }}
 */
export function payFine(player) {
  requireInJail(player, 'payFine');
  return { player: { ...player, inJail: false, jailTurns: 0 }, fineOwed: JAIL_FINE };
}

/**
 * Exit path 2: use a held get_out_of_jail_free card. Verifying the player
 * actually holds one, and removing it from their inventory, is the caller's
 * job — jail.js has no card-inventory field to check (not part of
 * PlayerGameState's P04-T01 shape).
 * @param {import('../domain/gameState.js').PlayerGameState} player
 * @returns {import('../domain/gameState.js').PlayerGameState}
 */
export function useCard(player) {
  requireInJail(player, 'useCard');
  return { ...player, inJail: false, jailTurns: 0 };
}

/**
 * Exit path 3: attempt to roll doubles. Rolling doubles releases the player
 * immediately (GAME_DESIGN_SPEC.md §15). Failing increments jailTurns; once
 * that reaches MAX_JAIL_TURNS the player is force-released and owes
 * JAIL_FINE regardless (GAME_STATE_MACHINE.md: "failed 3rd roll attempt ...
 * MAX_JAIL_TURNS reached ... END_TURN"; GAME_DESIGN_SPEC.md §15: "at
 * MAX_JAIL_TURNS, fine is charged automatically and they're released").
 * @param {import('../domain/gameState.js').PlayerGameState} player
 * @param {{ isDouble: boolean }} rollResult - from dice.js's rollDice(); a
 *   fresh attempt (doublesStreak 0) each time, not the normal-turn streak
 * @returns {{ player: import('../domain/gameState.js').PlayerGameState, released: boolean, fineOwed: number|null }}
 */
export function rollForExit(player, rollResult) {
  requireInJail(player, 'rollForExit');

  if (rollResult.isDouble) {
    return { player: { ...player, inJail: false, jailTurns: 0 }, released: true, fineOwed: null };
  }

  const jailTurns = player.jailTurns + 1;
  if (jailTurns >= MAX_JAIL_TURNS) {
    return { player: { ...player, inJail: false, jailTurns: 0 }, released: true, fineOwed: JAIL_FINE };
  }

  return { player: { ...player, jailTurns }, released: false, fineOwed: null };
}
