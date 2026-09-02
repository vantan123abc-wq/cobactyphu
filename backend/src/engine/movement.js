// Deterministic token movement from a dice roll — GAME_DESIGN_SPEC.md §6,
// ADAPTIVE_BOARD_DESIGN.md (board tile count is 36 or 44, by board size).
// Pure function: same inputs always produce the same output.
//
// Scope note: this covers only forward movement driven by a dice total.
// Card-effect movement (move_to/move_relative, GAME_DESIGN_SPEC.md §13) is
// out of scope for this task — see the implementation report.

const APPROVED_TILE_COUNTS = [36, 44]; // ADAPTIVE_BOARD_DESIGN.md, locked values

/**
 * @param {number} currentPosition - 0-indexed position before this move
 * @param {number} steps - a dice total (2-12) for a real roll, or a small
 *   positive step count for card-driven relative movement (turnMachine.js's
 *   own moveByStepsAndResolve — 2026-08-22, C01 "Lối Tắt" can move as little
 *   as 1 tile, below a real die total's own minimum, so the lower bound here
 *   is steps themselves being a positive integer, not "looks like 2 dice")
 * @param {number} boardTileCount - 36 (Small) or 44 (Large)
 * @returns {{ newPosition: number, passedGo: boolean }}
 */
export function movePlayer(currentPosition, steps, boardTileCount) {
  if (!APPROVED_TILE_COUNTS.includes(boardTileCount)) {
    throw new RangeError(
      `boardTileCount must be one of ${APPROVED_TILE_COUNTS.join('/')} (ADAPTIVE_BOARD_DESIGN.md) — got ${boardTileCount}`
    );
  }
  if (!Number.isInteger(currentPosition) || currentPosition < 0 || currentPosition >= boardTileCount) {
    throw new RangeError(`currentPosition must be in [0, ${boardTileCount}) — got ${currentPosition}`);
  }
  // Upper bound is the BOARD size, not a dice maximum (fixed 2026-08-25,
  // found by fuzzing). The old `> 12` ceiling was the largest possible
  // two-die total, but this function is shared with card-driven movement —
  // the same reason its lower bound was already loosened to 1 for C01.
  // C02 ("move to the nearest unowned property ahead") searches the whole
  // board via turnMachine.js's findNearestUnownedAhead and legitimately
  // returns up to boardTileCount steps, so any draw where the next unowned
  // tile sat more than 12 ahead — routine once the early board is bought
  // up — crashed with a RangeError instead of moving the player.
  if (!Number.isInteger(steps) || steps < 1 || steps > boardTileCount) {
    throw new RangeError(`steps must be a positive integer up to ${boardTileCount} — got ${steps}`);
  }

  const rawPosition = currentPosition + steps;
  const newPosition = rawPosition % boardTileCount;
  const passedGo = rawPosition >= boardTileCount;

  return { newPosition, passedGo };
}
