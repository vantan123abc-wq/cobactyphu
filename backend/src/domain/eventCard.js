// Chance/Fortune event card shape — GAME_DESIGN_SPEC.md §13.
// Pure data shape: no I/O, no database driver, no framework import.
//
// §13 itself is tagged [PROPOSED] structure / [OPEN] actual card text/count/
// theme — content, not architecture, same "structural placeholder" status as
// P02-T03's board content. `deck` uses 'fortune' (not §13's literal
// 'community_chest'), consistent with tile.js's terminology note.

export const EVENT_CARD_DECKS = Object.freeze(['chance', 'fortune']);

// The exact effect kinds GAME_DESIGN_SPEC.md §13 lists, one-to-one:
//   pay(n) | receive(n) | move_to(tile) | move_relative(n) | go_to_jail
//   | get_out_of_jail_free | pay_each_player(n) | receive_from_each_player(n)
//   | property_repair(perHouse, perHotel)
export const EVENT_CARD_EFFECT_TYPES = Object.freeze([
  'pay',
  'receive',
  'move_to',
  'move_relative',
  'go_to_jail',
  'get_out_of_jail_free',
  'pay_each_player',
  'receive_from_each_player',
  'property_repair',
]);

/**
 * @typedef {Object} EventCardEffect
 * @property {('pay'|'receive'|'move_to'|'move_relative'|'go_to_jail'|'get_out_of_jail_free'|'pay_each_player'|'receive_from_each_player'|'property_repair')} type
 * @property {number} [amount] - for pay / receive / pay_each_player / receive_from_each_player
 * @property {number} [position] - target tile position, for move_to
 * @property {number} [steps] - relative movement, for move_relative (may be negative)
 * @property {number} [perHouse] - for property_repair
 * @property {number} [perHotel] - for property_repair
 */

/**
 * @typedef {Object} EventCard
 * @property {string} id
 * @property {('chance'|'fortune')} deck
 * @property {string} text - content, TBD per §13's [OPEN] note; structural placeholder until designed
 * @property {EventCardEffect} effect
 */

/**
 * @param {Partial<EventCard>} fields
 * @returns {EventCard}
 */
export function createEventCard(fields) {
  if (!EVENT_CARD_DECKS.includes(fields.deck)) {
    throw new TypeError(`Unknown deck: ${fields.deck}`);
  }
  if (!fields.effect || !EVENT_CARD_EFFECT_TYPES.includes(fields.effect.type)) {
    throw new TypeError(`Unknown effect type: ${fields.effect?.type}`);
  }

  return {
    id: fields.id,
    deck: fields.deck,
    text: fields.text,
    effect: fields.effect,
  };
}
