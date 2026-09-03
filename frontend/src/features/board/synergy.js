// Frontend mirror of backend/src/engine/synergyEngine.js's archetype system
// (Hệ Tộc — ASYMMETRIC_MODE_SPEC.md §2/§3), for the board's own "which tiles
// are currently powering a synergy" highlight.
//
// Mirrored rather than shared, same standing as every other duplicated
// backend constant in this codebase (JAIL_FINE in GameControls.jsx,
// MAX_UPGRADE_LEVEL in BoardTile.jsx, MOVEMENT_CARDS in movementCards.js) —
// there is no shared package between the two halves of this project. The
// three things copied here (GROUP_ARCHETYPE, TIERS, and the
// mortgaged-doesn't-count counting rule) must stay in step with
// synergyEngine.js; everything else about synergies stays server-side.
//
// Deliberately display-only. Nothing here decides anything: the server
// resolves every real effect, and this file only answers "should this tile
// glow, and how brightly." A drift between the two would therefore show up
// as a wrong highlight, never as a wrong game outcome.

/** groupId -> archetype. synergyEngine.js's own GROUP_ARCHETYPE. */
const GROUP_ARCHETYPE = {
  red: 'CONTROL',
  cyan: 'CONTROL',
  purple: 'ECONOMY',
  orange: 'ECONOMY',
  yellow: 'DENIAL',
  green: 'DENIAL',
  blue: 'EXECUTION',
  darkblue: 'EXECUTION',
}

/** synergyEngine.js's own TIERS — tile-count thresholds, ascending. */
const TIERS = {
  CONTROL: [2, 4, 5],
  ECONOMY: [2, 4, 6],
  DENIAL: [2, 4, 6],
  EXECUTION: [2, 4, 5],
  MOBILITY: [1, 2],
  INFRA: [1, 2],
}

// The spec's own Vietnamese names (ASYMMETRIC_MODE_SPEC.md §2-§3 headings)
// and a distinct colour each. The colours are NOT tileVisuals.js's
// GROUP_COLORS: an archetype spans two colour groups (red+cyan are one
// archetype), so reusing a group colour would make half of every archetype
// glow the "wrong" colour. Picked to stay legible against the board's dark
// wood ground and against each group's own colour band.
const ARCHETYPE_META = {
  CONTROL: { label: 'Bình Dân', color: '#ef4444', effect: 'Đi ngang qua: đối thủ bị trừ 1 bước' },
  ECONOMY: { label: 'Giao Thương', color: '#a855f7', effect: 'Đi ngang qua: nạn nhân bị đổi 1 lá bài' },
  DENIAL: { label: 'Thượng Lưu', color: '#f59e0b', effect: 'Đi ngang qua: lộ bài của nạn nhân' },
  EXECUTION: { label: 'Tử Địa', color: '#3b82f6', effect: 'Đi ngang qua: phí quá cảnh $75 × cấp nhà' },
  MOBILITY: { label: 'Bến Xe', color: '#14b8a6', effect: 'Đi ngang qua: đẩy đối thủ 1 bước' },
  INFRA: { label: 'Hạ Tầng', color: '#94a3b8', effect: 'Hệ hạ tầng' },
}

/** @returns {string|null} archetype key, or null for a tile belonging to none */
export function archetypeOf(tile) {
  if (!tile) return null
  if (tile.tileType === 'transport') return 'MOBILITY'
  if (tile.tileType === 'utility') return 'INFRA'
  return GROUP_ARCHETYPE[tile.groupId] ?? null
}

export function archetypeMeta(archetype) {
  return ARCHETYPE_META[archetype] ?? null
}

/** How many tiers an archetype has in total — drives the "2/3" readout. */
export function maxTier(archetype) {
  return TIERS[archetype]?.length ?? 0
}

/**
 * Every tile that is currently part of a LIVE synergy, keyed by boardTileId.
 *
 * Computed once per render in GameBoard.jsx rather than per tile: a tier is a
 * property of the OWNER, so every tile a given owner holds in a given
 * archetype shares one answer, and asking per-tile would recount the whole
 * portfolio for each of the board's 36-44 cells.
 *
 * Mortgaged deeds are excluded from the count AND never highlighted
 * themselves — synergyEngine.js's own archetypeCount does exactly this, and
 * for the reason its comment gives: a mortgaged tile collects no rent, so
 * letting it keep feeding a synergy would make "mortgage everything, keep the
 * tier" a free ride.
 *
 * @param {object[]} properties - gameState.properties
 * @param {object[]} boardTiles - staticBoard.tiles
 * @returns {Map<string, {archetype: string, tier: number, owned: number, ownerId: string}>}
 */
export function synergyByTileId(properties, boardTiles) {
  const result = new Map()
  if (!properties?.length || !boardTiles?.length) return result

  const tileById = new Map(boardTiles.map((t) => [t.id, t]))

  // ownerId -> archetype -> count, over unmortgaged holdings only.
  const counts = new Map()
  for (const property of properties) {
    if (!property.ownerId || property.mortgaged) continue
    const archetype = archetypeOf(tileById.get(property.boardTileId))
    if (!archetype) continue
    const perOwner = counts.get(property.ownerId) ?? new Map()
    perOwner.set(archetype, (perOwner.get(archetype) ?? 0) + 1)
    counts.set(property.ownerId, perOwner)
  }

  for (const property of properties) {
    if (!property.ownerId || property.mortgaged) continue
    const archetype = archetypeOf(tileById.get(property.boardTileId))
    if (!archetype) continue
    const owned = counts.get(property.ownerId)?.get(archetype) ?? 0
    const tier = (TIERS[archetype] ?? []).filter((threshold) => owned >= threshold).length
    if (tier === 0) continue // below tier 1: owned, but powering nothing yet
    result.set(property.boardTileId, { archetype, tier, owned, ownerId: property.ownerId })
  }

  return result
}
