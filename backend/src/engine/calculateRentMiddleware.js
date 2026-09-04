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

  // INFRA (§2.3) "+25% Rent", wired 2026-09-04. Until now this archetype was
  // the one entry in TIERS with no effect anywhere — `archetypeOf` returned
  // 'INFRA' for every utility and `synergyTier` counted them, but neither
  // passThroughEffect nor landingEffect nor this function had a branch, so
  // holding both utilities in ASYMMETRIC did literally nothing beyond classic
  // utility rent. Two of the board's tiles were inert in this ruleset.
  //
  // Scales per tier (+25% at one utility, +50% at both) rather than flat like
  // CONTROL. That is a decision the user made on 2026-09-04, replacing §2.3's
  // other two clauses outright — see below — and it exists to give the SECOND
  // utility a real synergy reason. Without it, INFRA's only tier-2 payoff
  // would be the base-rate jump calculateRent already does on its own
  // (`diceRoll × (ownsBoth ? 10 : 4)`, GAME_DESIGN_SPEC §11), and the
  // archetype layer would add nothing at max tier that it did not already add
  // at tier 1. Net effect at a 7 roll: 28 -> 35 with one utility, 70 -> 105
  // with both.
  //
  // WHAT WAS DROPPED, and why this is a replacement rather than a partial
  // implementation: §2.3's two other clauses ("Phí quá cảnh +10% vào quỹ dự
  // trữ", "Trích Rent vào Quỹ Dự trữ") both depend on a "Quỹ dự trữ" that is
  // defined NOWHERE — verified 2026-09-04, the phrase and "Overload" appear in
  // §2.3's two bullet lines and in no other document, schema, or line of code,
  // with nothing saying what the fund is for, who owns it, whether it is
  // spendable, or whether it counts toward net worth. A new money pool is also
  // a closed-economy question (ECONOMY_SPECIFICATION §4), not a local one. Put
  // to the user with the alternatives (a bankruptcy buffer matching the
  // archetype's own "SUSTAIN" name, or a Final-Phase net-worth bonus); they
  // chose to drop the fund entirely and put the archetype's whole budget into
  // this rider. So INFRA is deliberately a landing-only archetype: it has no
  // pass-through half at all, unlike every other archetype in §2/§3.
  const infraTier = archetypeOf(targetTile) === 'INFRA' ? synergyTier(gameState, boardTiles, ownerId, 'INFRA') : 0;
  if (infraTier > 0) {
    modifier += infraTier >= 2 ? 0.5 : 0.25;
  }

  const finalRent = baseRent * clamp(1 + modifier, MIN_RENT_MULTIPLIER, MAX_RENT_MULTIPLIER);
  return Math.floor(finalRent);
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// Bounds exist so a future stack of archetypes can never produce a rent no
// player could have anticipated. Nothing today comes close to either end.
export const MIN_RENT_MULTIPLIER = 0.25;
export const MAX_RENT_MULTIPLIER = 3;
