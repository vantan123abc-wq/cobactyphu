// The 12 con giáp (zodiac animal) player pieces (2026-08-22) — single
// backend source of truth for the valid set, mirrored client-side the same
// way every other backend enum/constant already is in this codebase (no
// shared package crosses the frontend/backend boundary here — see
// GameControls.jsx's JAIL_FINE, PropertyManager.jsx's MAX_UPGRADE_LEVEL,
// etc. for precedent).
//
// Order is the traditional 12-year cycle starting from Tý (rat) — arbitrary
// for gameplay purposes, but a real, recognizable ordering rather than an
// invented one.
export const ZODIAC_KEYS = Object.freeze([
  'ty', // Chuột (rat)
  'suu', // Trâu (buffalo)
  'dan', // Hổ (tiger)
  'mao', // Mèo (cat)
  'thin', // Rồng (dragon)
  'ty2', // Rắn (snake) — distinct key from 'ty' (rat); real Vietnamese names for both start with the same syllable, the trailing digit only disambiguates the *key*, never shown to a player
  'ngo', // Ngựa (horse)
  'mui', // Dê (goat)
  'than', // Khỉ (monkey)
  'dau', // Gà (rooster)
  'tuat', // Chó (dog)
  'hoi', // Lợn (pig)
]);

export function isValidZodiac(value) {
  return typeof value === 'string' && ZODIAC_KEYS.includes(value);
}

export function randomZodiac() {
  return ZODIAC_KEYS[Math.floor(Math.random() * ZODIAC_KEYS.length)];
}
