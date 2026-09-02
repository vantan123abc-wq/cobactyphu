// Server-side dice rolling — GAME_DESIGN_SPEC.md §6, GAME_STATE_MACHINE.md §0/§6.
// Pure function: no I/O, no network. The client never supplies or influences
// these values (SOCKET_CONTRACT.md `game:roll_dice`, SECURITY_DESIGN.md threat #2).

// PROPOSED, GAME_STATE_MACHINE.md §0 — a 3rd consecutive double sends the
// player to jail instead of continuing to move.
export const MAX_CONSECUTIVE_DOUBLES = 2;

function rollOneDie(randomSource) {
  return Math.floor(randomSource() * 6) + 1;
}

/**
 * @param {number} doublesStreak - consecutive doubles already rolled this turn (0 if none)
 * @param {() => number} randomSource - injectable RNG, defaults to Math.random.
 *   Production callers never need to pass this; tests use it for deterministic coverage.
 */
export function rollDice(doublesStreak = 0, randomSource = Math.random) {
  if (!Number.isInteger(doublesStreak) || doublesStreak < 0) {
    throw new TypeError('doublesStreak must be a non-negative integer');
  }

  const die1 = rollOneDie(randomSource);
  const die2 = rollOneDie(randomSource);
  const isDouble = die1 === die2;
  const streakIfDouble = doublesStreak + 1;
  const sentToJail = isDouble && streakIfDouble > MAX_CONSECUTIVE_DOUBLES;

  return {
    die1,
    die2,
    total: die1 + die2,
    isDouble,
    doublesStreak: isDouble && !sentToJail ? streakIfDouble : 0,
    sentToJail,
  };
}
