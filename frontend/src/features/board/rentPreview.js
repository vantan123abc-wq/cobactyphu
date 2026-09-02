// Shared "what would landing here cost right now" preview — extracted
// 2026-08-25 when BoardTile.jsx needed the identical logic MyPortfolio.jsx
// already had as a private `rentLabel` function (a real user correction:
// the on-tile price badge was showing the purchase price, when landing on
// an OWNED tile obviously charges rent, not the price paid for it).
//
// Deliberately NOT the final server-computed figure for the DICE-dependent
// cases — utility rent has no fixed dollar figure since it depends on a
// future roll, so it prints "N× xúc xắc" instead of inventing one.
//
// The monopoly ×2 bonus, on the other hand, IS folded in as of 2026-09-02.
// That bonus used to be a fiddly per-property rule (only helped an unimproved
// member), so reproducing it here risked drift and it was left to a separate
// badge. Since the 2026-09-02 revision it is a flat ×2 whenever one player
// owns the whole colour group with nothing mortgaged — a simple, exact,
// dice-free condition — and it is now the single largest factor in property
// rent (measured: ~10% of all rent paid). Showing half the real figure on a
// monopolised tile was the bigger error, so the preview now doubles it and
// says so.

/**
 * How many transport/utility tiles `ownerId` currently holds — the only
 * cross-tile context `rentLabel` below needs, since transport/utility rent
 * scales with how many of that TYPE the same owner holds (property rent
 * does not; it only ever depends on the one tile's own upgradeLevel).
 * @param {object[]} properties - gameState.properties
 * @param {object[]} tiles - staticBoard.tiles
 * @param {string} ownerId
 * @returns {{ transportCount: number, utilityCount: number }}
 */
export function ownerTypeCounts(properties, tiles, ownerId) {
  let transportCount = 0
  let utilityCount = 0
  for (const property of properties) {
    if (property.ownerId !== ownerId) continue
    const tile = tiles.find((t) => t.id === property.boardTileId)
    if (tile?.tileType === 'transport') transportCount++
    else if (tile?.tileType === 'utility') utilityCount++
  }
  return { transportCount, utilityCount }
}

/**
 * True iff `ownerId` owns every tile in `tile`'s colour group and none of
 * those holdings are mortgaged — the exact hasGroupBonus() condition from
 * backend/src/engine/calculateRent.js, minus its old upgradeLevel check
 * (removed there 2026-09-02: the bonus applies at every level now).
 * @param {object} tile
 * @param {object[]} properties - gameState.properties
 * @param {object[]} tiles - staticBoard.tiles
 * @param {string} ownerId
 * @returns {boolean}
 */
export function ownsFullGroup(tile, properties, tiles, ownerId) {
  if (!tile.groupId) return false
  const groupTileIds = tiles.filter((t) => t.groupId === tile.groupId).map((t) => t.id)
  if (groupTileIds.length === 0) return false
  return groupTileIds.every((tid) => {
    const p = properties.find((x) => x.boardTileId === tid)
    return p != null && p.ownerId === ownerId && !p.mortgaged
  })
}

/**
 * @param {object} tile - a staticBoard tile
 * @param {object} property - the game-scoped ownership row
 * @param {{ transportCount: number, utilityCount: number }} counts - this owner's own holdings of each type (ownerTypeCounts above)
 * @param {boolean} [hasGroupBonus=false] - ownsFullGroup(...) for this tile's owner; doubles the printed property rent
 * @returns {string}
 */
export function rentLabel(tile, property, { transportCount, utilityCount }, hasGroupBonus = false) {
  if (property.mortgaged) return 'Cầm cố' // GAME_DESIGN_SPEC.md §11: no rent is owed on a mortgaged property — showing a dollar figure here would be a real, factual lie, not just an approximation.

  if (tile.tileType === 'property') {
    const printed = property.upgradeLevel === 0 ? tile.baseRent : tile.rentTable?.[property.upgradeLevel - 1]
    if (typeof printed !== 'number') return '—'
    return hasGroupBonus ? `$${printed * 2} (×2 độc quyền)` : `$${printed}`
  }
  if (tile.tileType === 'transport') {
    return typeof tile.baseRent === 'number' ? `$${tile.baseRent * Math.pow(2, transportCount - 1)}` : '—'
  }
  if (tile.tileType === 'utility') {
    return utilityCount >= 2 ? '10× xúc xắc' : '4× xúc xắc'
  }
  return '—'
}
