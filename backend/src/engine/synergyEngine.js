// Synergy (Hệ Tộc) evaluation for the ASYMMETRIC ruleset —
// docs/ASYMMETRIC_MODE_SPEC.md §2.
//
// Set levels are counted across a whole ARCHETYPE, not per colour group.
// That is the spec's own deliberate departure from classic Monopoly and it
// exists to fix a real balance hole: darkblue is only 2 tiles on both boards,
// so a per-group ladder handed EXECUTION its top tier for two purchases while
// ECONOMY needed six. Counting per archetype makes every top tier cost a
// comparable number of tiles (5 or 6).
//
// Consequence worth knowing when reading the rest of the engine: synergy
// progress and BUILDING progress now advance on different axes. Houses still
// require a complete colour group (handleBuildHouse's own INCOMPLETE_GROUP
// check, unchanged), so a player can sit at EXECUTION tier 2 with four tiles
// and still be unable to build on any of them. That is intended — the two
// systems reward different shapes of portfolio — but it is not obvious.
//
// Pure: no I/O, no randomness, no mutation. Everything is derived from
// gameState + boardTiles on each call rather than cached on the player, so
// there is no stored `activePerks` array to fall out of sync the moment a
// trade, auction, hostile buyout or bankruptcy moves a deed. That
// derive-don't-store choice is the whole reason this file exists separately.

/** groupId -> archetype. ASYMMETRIC_MODE_SPEC.md §2's own quadrant mapping. */
const GROUP_ARCHETYPE = Object.freeze({
  red: 'CONTROL',
  cyan: 'CONTROL',
  purple: 'ECONOMY',
  orange: 'ECONOMY',
  yellow: 'DENIAL',
  green: 'DENIAL',
  blue: 'EXECUTION',
  darkblue: 'EXECUTION',
});

/**
 * Tile-count thresholds per archetype, ascending. Index 0 is tier 1.
 * A tier is reached at `>=` its threshold, so an archetype the board happens
 * to be short of (MOBILITY is 2 stations on `small`, 4 on `large`) simply
 * tops out lower rather than exposing an unreachable tier — the fix for V2's
 * "Trạm Trung Chuyển is physically impossible on the small board" hole.
 */
const TIERS = Object.freeze({
  CONTROL: [2, 4, 5],
  ECONOMY: [2, 4, 6],
  DENIAL: [2, 4, 6],
  EXECUTION: [2, 4, 5],
  MOBILITY: [1, 2],
  INFRA: [1, 2],
});

/**
 * @param {import('../domain/tile.js').Tile} tile
 * @returns {string|null} archetype key, or null for a tile that belongs to none
 */
export function archetypeOf(tile) {
  if (!tile) return null;
  if (tile.tileType === 'transport') return 'MOBILITY';
  if (tile.tileType === 'utility') return 'INFRA';
  return GROUP_ARCHETYPE[tile.groupId] ?? null;
}

/**
 * How many tiles of `archetype` a player owns. Mortgaged deeds deliberately
 * do NOT count: a mortgaged property already collects no rent
 * (calculateRent's own rule), and letting it keep feeding a synergy would
 * make "mortgage everything, keep the tier" a free ride — the same reasoning
 * handleBuildHouse uses to refuse building on a group with a mortgaged member.
 *
 * @param {import('../domain/gameState.js').GameState} gameState
 * @param {import('../domain/tile.js').Tile[]} boardTiles
 * @param {string} playerId
 * @param {string} archetype
 * @returns {number}
 */
export function archetypeCount(gameState, boardTiles, playerId, archetype) {
  let count = 0;
  for (const property of gameState.properties) {
    if (property.ownerId !== playerId || property.mortgaged) continue;
    const tile = boardTiles.find((t) => t.id === property.boardTileId);
    if (archetypeOf(tile) === archetype) count++;
  }
  return count;
}

/**
 * Which tier (0 = none, 1..n) a player has reached in `archetype`.
 *
 * @returns {number} 0 when below the first threshold
 */
export function synergyTier(gameState, boardTiles, playerId, archetype) {
  const thresholds = TIERS[archetype];
  if (!thresholds) return 0;
  const owned = archetypeCount(gameState, boardTiles, playerId, archetype);
  let tier = 0;
  for (const threshold of thresholds) {
    if (owned >= threshold) tier++;
  }
  return tier;
}

/**
 * The pass-through effect an opponent triggers by CROSSING (not landing on)
 * `tile`, given who owns it. Returns null when nothing fires — an unowned
 * tile, the crosser's own tile, a mortgaged one, or an archetype whose owner
 * has not reached tier 1.
 *
 * Only the two Phase-1 movement-layer archetypes produce an effect here.
 * ECONOMY (discard/draw) and MOBILITY (nudge) are deliberately absent: both
 * need decisions and card-state that movement resolution has no business
 * reaching into, and both are still open design questions at hand size 2.
 * Adding them means adding a case here, nothing else.
 *
 * @returns {{type: 'STEP_LOSS', amount: number}|{type: 'TOLL', amount: number, ownerId: string}|null}
 */
export function passThroughEffect(gameState, boardTiles, tile, crosserId) {
  const property = gameState.properties.find((p) => p.boardTileId === tile.id);
  if (!property || !property.ownerId || property.ownerId === crosserId || property.mortgaged) {
    return null;
  }

  const archetype = archetypeOf(tile);
  const tier = synergyTier(gameState, boardTiles, property.ownerId, archetype);
  if (tier === 0) return null;

  // CONTROL (§2.1): a flat 1 step, at every tier. The -2 step at max tier was
  // cut in V3 and the simulation supports keeping it cut — CONTROL is the
  // cheapest archetype on the board ($440 for all five tiles) and already
  // collects 12.4 crossings per $100 invested against EXECUTION's 2.95.
  if (archetype === 'CONTROL') {
    return { type: 'STEP_LOSS', amount: 1 };
  }

  // EXECUTION (§3.2): scales with development, so it pays nothing until the
  // owner actually builds. $75/level is the simulated figure — at $25 the
  // toll was 1.5% of all money movement, i.e. decorative.
  if (archetype === 'EXECUTION') {
    const amount = property.upgradeLevel * EXECUTION_TOLL_PER_LEVEL;
    return amount > 0 ? { type: 'TOLL', amount, ownerId: property.ownerId } : null;
  }

  return null;
}

export const EXECUTION_TOLL_PER_LEVEL = 75;
