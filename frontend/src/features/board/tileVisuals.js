// Shared tile visual constants — split out of BoardTile.jsx (P11-T07) once
// PropertyActionDrawer.jsx needed the identical color/icon mappings for its
// own card header (duplicating them there would risk the two drifting
// apart — a property card showing a different color/icon than its own
// board tile would read as a bug). Plain constants only, no component, so
// this file doesn't trip oxlint's react(only-export-components) rule the
// way exporting these from BoardTile.jsx itself did.

// Real group_id slugs, matching backend/supabase/seed/boards.sql exactly
// (applied to the live board 2026-08-19) — 'red'/'cyan'/'purple'/'orange'/
// 'yellow'/'green'/'blue'/'darkblue', not the earlier 'group-1'..'group-8'
// placeholder keys this file shipped with before real content existed.
// Found stale while building RentRiskChoice.jsx (2026-08-21), which reuses
// this same lookup: the placeholder keys never matched any real tile's
// groupId, so every property's color header has silently fallen back to
// the neutral default background since the real seed went live, on every
// component that uses this map (BoardTile.jsx, FlashAuction.jsx,
// PropertyActionDrawer.jsx, PropertyManager.jsx, TradeOfferColumn.jsx).
export const GROUP_COLORS = {
  red: '#d32f2f',
  cyan: '#22b8cf',
  purple: '#8e44ad',
  orange: '#f2994a',
  yellow: '#f1c40f',
  green: '#27ae60',
  blue: '#2980b9',
  darkblue: '#1a3a6e',
}

// Re-themed 2026-08-22 (user request — "Vé Số Kiến Thiết"/lottery for Cơ
// Hội, "Xin Xăm"/bamboo fortune-sticks for Khí Vận), superseding
// BOARD_SPECIFICATION.md §confirmed's older "red CƠ HỘI / yellow KHÍ VẬN"
// pairing (that doc not yet updated to match — flagged here, not silently
// left contradicting the shipped colors): chance is now the bright
// lottery-stall gold this brief calls for, fortune a deep jade/emerald
// ("Xanh ngọc bích", the brief's own second suggested option over navy —
// picked for better contrast against the gold GO tile and the red-heavy
// property groups elsewhere on the board).
export const CHANCE_FORTUNE_COLOR = { chance: '#f4c430', fortune: '#0f6b5c' }

// TILE_ICON (plain emoji: 🚉💡❓🍀💸) removed 2026-08-21 — superseded by
// `./TileIcon.jsx`'s hand-drawn SVG set (a real, live-screenshot legibility
// complaint about the isometric board, generalized to every place a tile
// icon appears, not just the board itself). Not moved into this file:
// `TileIcon` is a component, and this file is deliberately plain-constants-
// only (see the header above) — importers switch from
// `TILE_ICON[tile.tileType]` to `<TileIcon type={tile.tileType} />`.

// Player token colors — moved here from BoardTile.jsx (2026-08-21) when the
// board animation slice moved token rendering out of individual tile cells
// into GameBoard.jsx's own absolutely-positioned overlay (CSS Grid can't
// transition a grid-row/grid-column change, so a token sliding smoothly
// between two tiles needs to be positioned independently of the grid it
// slides across). Same "plain constants, not a component" reasoning this
// file's own header already gives for GROUP_COLORS/CHANCE_FORTUNE_COLOR/
// TILE_ICON — keeps GameBoard.jsx importable without tripping oxlint's
// react(only-export-components) rule. Distinct from the property palette so
// a player token is never confused with a property's color header. Cycles
// by turnOrder — up to MAX_PLAYERS=6 (GAME_DESIGN_SPEC.md §0), the same cap
// this project's backend already enforces.
export const PLAYER_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22']

export function playerColor(player) {
  return PLAYER_COLORS[(player.turnOrder ?? 0) % PLAYER_COLORS.length]
}

export function playerInitial(player) {
  return (player.playerId ?? '?').charAt(0).toUpperCase()
}
