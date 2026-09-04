import { calculateRent } from './calculateRent.js';
import { archetypeOf, synergyTier } from './synergyEngine.js';

/**
 * Rent for both rulesets. CLASSIC returns calculateRent()'s figure verbatim
 * on the first branch, so nothing here can regress the shipped mode.
 *
 * ASYMMETRIC layers the landing half of ASYMMETRIC_MODE_SPEC.md's §1.2
 * grammar on top: crossing a tile is handled in movementMiddleware, stopping
 * on one is handled here.
 *
 * REPLACES (2026-09-03) an `activePerks` lookup that could never fire. The
 * previous version read `targetTile.color === 'BLUE'`, but Tile has no
 * `color` field at all — domain/tile.js's createTile() builds an explicit
 * whitelist and every real board tile comes through it
 * (infrastructure/repositories/boardRepository.js), so the comparison was
 * `undefined === 'BLUE'` in every real game. Its unit test passed only
 * because it hand-built `{ color: 'BLUE' }` instead of calling createTile.
 * Colour groups are `groupId`, lower-case ('blue', 'darkblue'), and are now
 * read through synergyEngine so rent and movement agree on what a set is.
 *
 * @param {import('../domain/gameState.js').GameState} gameState
 * @param {string} payerId
 * @param {string} ownerId
 * @param {import('../domain/tile.js').Tile} targetTile
 * @param {import('../domain/property.js').Property} targetProperty
 * @param {*} ownerHoldings
 * @param {import('../domain/tile.js').Tile[]} groupTiles
 * @param {number} diceRoll
 * @param {import('../domain/tile.js').Tile[]} [boardTiles] - the full board; required for ASYMMETRIC synergy lookups, unused by CLASSIC
 */
export function calculateFinalRent(
  gameState,
  payerId,
  ownerId,
  targetTile,
  targetProperty,
  ownerHoldings,
  groupTiles,
  diceRoll,
  boardTiles = []
) {
  const baseRent = calculateRent({
    targetTile,
    targetProperty,
    ownerHoldings,
    groupTiles,
    diceRoll,
    ruleset: gameState.ruleset,
  });

  if (gameState.ruleset !== 'ASYMMETRIC') {
    return baseRent;
  }

  const owner = gameState.players.find((p) => p.id === ownerId);
  const payer = gameState.players.find((p) => p.id === payerId);
  if (!owner || !payer) return baseRent;

  // Multipliers are summed into one modifier and clamped, never chained.
  // Chaining was the previous shape and it made two "strong" perks cancel
  // out exactly (x2 then x0.5 is the base rent back), while any third one
  // would have compounded unpredictably. A summed, clamped modifier keeps
  // every future archetype's contribution readable and bounded.
  let modifier = 0;

  // CONTROL (§2.1): +50% on landing. Its pass-through half (one step) is the
  // cheap, frequent part; this is the rare, punishing part. Replaced the
  // "lose your next turn" version from V2, which was the harshest effect in
  // the document sitting on the cheapest archetype on the board ($440).
  if (archetypeOf(targetTile) === 'CONTROL' && synergyTier(gameState, boardTiles, ownerId, 'CONTROL') > 0) {
    modifier += 0.5;
  }

  // INFRA (§2.3, wired 2026-09-04) — the SUPPORT archetype. Unlike every
  // other modifier here it does not care which tile was landed on: holding
  // utilities "powers" the owner's whole portfolio, so this applies to every
  // rent they collect, including on tiles of a completely different
  // archetype. See synergyEngine.js's own INFRA arm for why the spec's
  // reserve-fund version was not built and this was.
  //
  // Small on purpose. +25% on EVERYTHING is worth more than CONTROL's +50%
  // on one archetype's tiles, and INFRA is the cheapest set on the board
  // ($400 for both utilities, reachable in two purchases).
  const infraTier = synergyTier(gameState, boardTiles, ownerId, 'INFRA');
  if (infraTier > 0) {
    modifier += infraTier >= 2 ? INFRA_RENT_BONUS_MAX : INFRA_RENT_BONUS_BASE;
  }

  const finalRent = baseRent * clamp(1 + modifier, MIN_RENT_MULTIPLIER, MAX_RENT_MULTIPLIER);
  return Math.floor(finalRent);
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// Bounds exist so a future stack of archetypes can never produce a rent no
// player could have anticipated. Nothing today comes close to either end.
// INFRA's portfolio-wide rent support, by tier. Summed into the modifier above
// with everything else, so a CONTROL tile owned by a full-INFRA player is
// 1 + 0.5 + 0.25 = x1.75 — comfortably inside MAX_RENT_MULTIPLIER, which is
// exactly the bounded, readable stacking that modifier's own comment
// anticipated for "a future archetype".
export const INFRA_RENT_BONUS_BASE = 0.1;
export const INFRA_RENT_BONUS_MAX = 0.25;

export const MIN_RENT_MULTIPLIER = 0.25;
export const MAX_RENT_MULTIPLIER = 3;
