import { movePlayer as classicMovePlayer } from './movement.js';
import { passThroughEffect } from './synergyEngine.js';

/**
 * Middleware để di chuyển người chơi.
 * Hỗ trợ chế độ CLASSIC (tiến bình thường) và ASYMMETRIC (bẫy + pass-through).
 *
 * ASYMMETRIC walks the board one tile at a time rather than doing the classic
 * single modulo jump, because docs/ASYMMETRIC_MODE_SPEC.md §1.2's whole design
 * turns on what a player CROSSES, not only where they stop. The Monte-Carlo
 * run behind that spec (scripts/asymmetric-sim.mjs) measured crossings at
 * ~5:1 against landings, so this loop — not resolveLanding — is where most of
 * the mode's economy actually happens.
 *
 * Pure and side-effect free: it never mutates gameState and never moves money
 * itself. Tolls are RETURNED as a list for handlePlayMovementCard to settle
 * through applyTransaction, because that is the only path that keeps the
 * ledger and the "balance never goes negative" invariant intact.
 *
 * @param {import('../domain/gameState.js').GameState} gameState
 * @param {string} playerId
 * @param {number} steps
 * @param {number} direction 1 = forward, -1 = backward
 * @param {number} boardTileCount
 * @param {object} [options]
 * @param {import('../domain/tile.js').Tile[]} [options.boardTiles] - required for pass-through; omit for movement-only
 * @param {boolean} [options.ignorePassThrough] - JUMP cards (movementDictionary.js) cross immune
 * @returns {{newPosition: number, passedGo: boolean, stoppedByTrap: boolean, stepsLost: number, tolls: object[], cardEffects: object[]}}
 */
export function resolveMovement(gameState, playerId, steps, direction = 1, boardTileCount, options = {}) {
  const player = gameState.players.find((p) => p.id === playerId);
  if (!player) throw new Error('Player not found');

  if (gameState.ruleset === 'CLASSIC') {
    const classic = classicMovePlayer(player.currentPosition, steps, boardTileCount);
    return { ...classic, stoppedByTrap: false, stepsLost: 0, tolls: [], cardEffects: [] };
  }

  const { boardTiles = null, ignorePassThrough = false } = options;

  let currentPos = player.currentPosition;
  let remaining = steps;
  let passedGo = false;
  let stoppedByTrap = false;
  let stepsLost = 0;
  const tolls = [];
  const cardEffects = [];

  // A guard, not a rule: CONTROL removes steps, and a long enough chain of
  // owned CONTROL tiles could in principle keep removing them. The simulation
  // put "turns moving <= 1 tile" at 0.1% even with the cap removed entirely,
  // so this should never bind in a real match — it exists so that a future
  // effect with a larger STEP_LOSS cannot turn into an unbounded loop.
  let iterations = 0;
  const maxIterations = steps + boardTileCount;

  while (remaining > 0 && iterations++ < maxIterations) {
    const rawPosition = currentPos + direction;
    if (direction === 1 && rawPosition >= boardTileCount) {
      passedGo = true;
    }
    currentPos = (rawPosition + boardTileCount) % boardTileCount;
    remaining--;

    // The tile the player STOPS on is a landing, not a crossing. resolveTile /
    // resolveLanding owns everything that happens there; this loop must not
    // also charge it a pass-through, or every landing would be billed twice.
    if (remaining === 0) break;

    const traps = gameState.activeTraps || [];
    const trap = traps.find((t) => t.tileIndex === currentPos);
    if (trap && trap.type === 'ROADBLOCK') {
      stoppedByTrap = true;
      break;
    }

    // JUMP cards pay for their immunity in tempo (2-3 steps against a 5-9
    // baseline). Simulated at 700 matches: charging money for it instead
    // drained ~$1.8k/match to the bank and cut EXECUTION's toll income by 70%,
    // because players bought it anyway and then could not afford to build.
    if (ignorePassThrough || !boardTiles) continue;

    const tile = boardTiles.find((t) => t.position === currentPos);
    if (!tile) continue;

    const effect = passThroughEffect(gameState, boardTiles, tile, playerId);
    if (!effect) continue;

    if (effect.type === 'STEP_LOSS') {
      remaining -= effect.amount;
      stepsLost += effect.amount;
      // Losing the last step means stopping HERE, inside the zone that took
      // it — ASYMMETRIC_MODE_SPEC.md §2.1's "phải dừng lại sớm hơn dự tính
      // bên trong vùng kiểm soát". The tile therefore becomes a landing and
      // must not also be billed as a crossing, same rule as the break above.
      if (remaining <= 0) break;
    } else if (effect.type === 'TOLL') {
      tolls.push({ ownerId: effect.ownerId, amount: effect.amount, tileId: tile.id });
    } else {
      // CARD_REROLL / REVEAL_NEXT_CARD. Returned rather than applied because
      // both touch player hands, and this function is deliberately pure —
      // handlePlayMovementCard owns every mutation, the same split the tolls
      // above already use for money.
      cardEffects.push({ ...effect, tileId: tile.id });
    }
  }

  return { newPosition: currentPos, passedGo, stoppedByTrap, stepsLost, tolls, cardEffects };
}
