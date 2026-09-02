// The 12 con giáp player pieces (2026-08-22) — mirrors
// backend/src/domain/zodiac.js's ZODIAC_KEYS exactly (no shared package
// crosses the frontend/backend boundary in this repo — same standing as
// every other mirrored backend constant/enum here, e.g. GameControls.jsx's
// JAIL_FINE, PropertyManager.jsx's MAX_UPGRADE_LEVEL).
//
// Emoji, not a hand-drawn SVG — a deliberate, flagged exception to
// TileIcon.jsx's own precedent (which moved *away* from emoji specifically
// for small tile-type icons, citing inconsistent cross-platform rendering).
// 12 full animal glyphs is disproportionate to hand-draw for this feature,
// and a player piece renders far larger on the board than the compact tile
// icons that motivated that rule — legibility risk is much lower here.
export const ZODIAC = [
  { key: 'ty', label: 'Chuột', emoji: '🐭' },
  { key: 'suu', label: 'Trâu', emoji: '🐂' },
  { key: 'dan', label: 'Hổ', emoji: '🐯' },
  { key: 'mao', label: 'Mèo', emoji: '🐱' },
  { key: 'thin', label: 'Rồng', emoji: '🐲' },
  { key: 'ty2', label: 'Rắn', emoji: '🐍' },
  { key: 'ngo', label: 'Ngựa', emoji: '🐴' },
  { key: 'mui', label: 'Dê', emoji: '🐐' },
  { key: 'than', label: 'Khỉ', emoji: '🐵' },
  { key: 'dau', label: 'Gà', emoji: '🐔' },
  { key: 'tuat', label: 'Chó', emoji: '🐶' },
  { key: 'hoi', label: 'Lợn', emoji: '🐷' },
]

const BY_KEY = Object.fromEntries(ZODIAC.map((z) => [z.key, z]))

/** @returns {string|null} the emoji for a real zodiac key, or null (caller falls back to playerInitial()) for an unset/unrecognized one */
export function zodiacEmoji(key) {
  return BY_KEY[key]?.emoji ?? null
}

export function zodiacLabel(key) {
  return BY_KEY[key]?.label ?? null
}
