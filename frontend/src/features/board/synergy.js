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

// ── Panel data (2026-09-04) ────────────────────────────────────────────────
// Everything below exists for SynergyPanel.jsx — the "what does each colour
// actually DO, and how close am I" readout. Deliberately describes what the
// ENGINE does, not what ASYMMETRIC_MODE_SPEC.md proposes: the two have
// drifted, and a panel that promises an effect the code never applies is
// worse than no panel. Verified against engine/synergyEngine.js's own
// passThroughEffect()/landingEffect() switch arms, arm by arm:
//   - CONTROL   pass-through STEP_LOSS 1        · landing: nothing extra
//   - ECONOMY   pass-through CARD_REROLL        · landing: owner draws 2
//   - DENIAL    pass-through REVEAL_NEXT_CARD   · landing: reveals hand 2 rounds
//   - EXECUTION pass-through TOLL 75×level      · landing: nothing extra
//   - MOBILITY  pass-through NUDGE 1            · landing: TELEPORT, tier 2 only
//   - INFRA     nothing at all — see INFRA's own entry below.
// The spec additionally promises CONTROL "Rent ×1.5" and EXECUTION a
// confiscation on landing; neither exists in landingEffect(), so neither is
// claimed here.

const ARCHETYPE_EFFECTS = {
  CONTROL: {
    passThrough: 'Đối thủ đi ngang qua bị trừ 1 bước',
    landing: null,
  },
  ECONOMY: {
    passThrough: 'Đối thủ đi ngang qua phải bỏ 1 lá bài và rút lá khác',
    landing: 'Đối thủ dừng lại: bạn rút ngay 2 lá bài',
  },
  DENIAL: {
    passThrough: 'Đối thủ đi ngang qua bị lộ 1 lá bài cho bạn',
    landing: 'Đối thủ dừng lại: lộ toàn bộ tay bài trong 2 vòng',
  },
  EXECUTION: {
    passThrough: 'Đối thủ đi ngang qua trả phí $75 × cấp nhà',
    landing: null,
  },
  MOBILITY: {
    passThrough: 'Đối thủ đi ngang qua bị đẩy 1 bước về phía đất của bạn',
    landing: 'Đối thủ dừng lại: bị teleport tới đất đắt nhất của bạn',
    landingTier: 2, // gated behind tier 2 in landingEffect(); the others are not tier-gated
  },
  INFRA: {
    // Not an oversight in this file: engine/synergyEngine.js has no INFRA arm
    // in either passThroughEffect() or landingEffect(), so owning utilities
    // currently grants nothing. Stated plainly rather than quietly omitted —
    // a player who buys both utilities expecting a synergy deserves to know.
    passThrough: null,
    landing: null,
    unimplemented: true,
  },
}

/** Display order for the panel — cheapest/most-trafficked archetypes first. */
export const ARCHETYPE_ORDER = ['CONTROL', 'ECONOMY', 'DENIAL', 'EXECUTION', 'MOBILITY', 'INFRA']

/** Which colour groups (or tile types) feed each archetype. */
export const ARCHETYPE_MEMBERS = {
  CONTROL: ['red', 'cyan'],
  ECONOMY: ['purple', 'orange'],
  DENIAL: ['yellow', 'green'],
  EXECUTION: ['blue', 'darkblue'],
  MOBILITY: [], // every `transport` tile
  INFRA: [], // every `utility` tile
}

export function archetypeEffects(archetype) {
  return ARCHETYPE_EFFECTS[archetype] ?? null
}

export function tierThresholds(archetype) {
  return TIERS[archetype] ?? []
}

/**
 * One row per archetype for a single player: how many they hold, what tier
 * that reaches, how many more to the next tier, and how many exist on the
 * board at all (the ceiling).
 *
 * `mortgaged` is reported separately and NOT counted, mirroring
 * synergyEngine.js's archetypeCount() exactly — a mortgaged deed collects no
 * rent, so letting it keep feeding a synergy would make "mortgage everything,
 * keep the tier" a free ride. It is surfaced because that is a genuinely
 * surprising way to lose a tier you thought you had.
 */
export function playerSynergies(properties, boardTiles, playerId) {
  const tileById = new Map((boardTiles ?? []).map((t) => [t.id, t]))
  const owned = new Map()
  const mortgaged = new Map()
  const onBoard = new Map()

  for (const tile of boardTiles ?? []) {
    const a = archetypeOf(tile)
    if (a) onBoard.set(a, (onBoard.get(a) ?? 0) + 1)
  }
  for (const property of properties ?? []) {
    if (property.ownerId !== playerId) continue
    const a = archetypeOf(tileById.get(property.boardTileId))
    if (!a) continue
    if (property.mortgaged) mortgaged.set(a, (mortgaged.get(a) ?? 0) + 1)
    else owned.set(a, (owned.get(a) ?? 0) + 1)
  }

  return ARCHETYPE_ORDER.map((archetype) => {
    const thresholds = TIERS[archetype] ?? []
    const count = owned.get(archetype) ?? 0
    const tier = thresholds.filter((t) => count >= t).length
    const nextThreshold = thresholds.find((t) => count < t) ?? null
    return {
      archetype,
      owned: count,
      mortgaged: mortgaged.get(archetype) ?? 0,
      onBoard: onBoard.get(archetype) ?? 0,
      tier,
      thresholds,
      nextThreshold,
      meta: ARCHETYPE_META[archetype],
      effects: ARCHETYPE_EFFECTS[archetype],
    }
  })
}
