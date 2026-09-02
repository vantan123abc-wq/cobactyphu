// Event Card resolution engine — the "Decision & Moment System" companion
// to domain/eventDictionary.js. Pure functions: no I/O, no database driver,
// no Express, no Socket.IO, no internal randomness — probabilityRoll always
// arrives as an input (same convention dice.js/turnMachine.js already use
// for external unpredictability: generated outside, never in here), so the
// same inputs always produce the same output.
//
// Deliberately decoupled from domain/eventDictionary.js: none of these
// functions import it. Each takes whatever card/option object matches the
// shape, same as engine/calculateRent.js takes a Tile without importing
// tile.js — keeps this testable against plain fixtures, not just the real
// dictionary.

import { EVENT_CARD_TYPES } from '../domain/eventDictionary.js';

export class EventChoiceError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'EventChoiceError';
    this.reason = reason;
  }
}

/**
 * Draws the top card and cycles it to the bottom — GAME_DESIGN_SPEC.md
 * §13's documented deck behavior ("card cycles to bottom"). Does not special
 * -case get_out_of_jail_free's own "held, not cycled" exception from that
 * same spec row — this dictionary has no such card yet, and that's a
 * decision for whoever wires a real deck, not this generic draw mechanic.
 * @param {string[]} deck - card ids, top of deck at index 0
 * @returns {{drawnCardId: string, newDeck: string[]}}
 */
export function drawCard(deck) {
  if (!Array.isArray(deck) || deck.length === 0) {
    throw new TypeError('drawCard: deck must be a non-empty array');
  }

  const [drawnCardId, ...rest] = deck;
  return { drawnCardId, newDeck: [...rest, drawnCardId] };
}

/**
 * @param {import('../domain/eventDictionary.js').EventCardDictionaryEntry} card
 * @returns {import('../domain/eventDictionary.js').SettlementIntent[] | {type: 'REQUIRE_CHOICE', options: import('../domain/eventDictionary.js').EventCardOption[]}}
 */
export function evaluateEvent(card) {
  if (!EVENT_CARD_TYPES.includes(card.type)) {
    throw new TypeError(`evaluateEvent: unknown card type '${card.type}'`);
  }

  if (card.type === 'INSTANT') {
    return card.intents;
  }

  return { type: 'REQUIRE_CHOICE', options: card.options };
}

/**
 * Resolves a player's choice on a CHOICE card into a final, flat array of
 * settlement intents — a PROBABILITY intent never survives into the
 * returned array, it's replaced by whichever branch probabilityRoll landed
 * on.
 * @param {import('../domain/gameState.js').GameState} gameState
 * @param {string} playerId - PlayerGameState.id
 * @param {import('../domain/eventDictionary.js').EventCardDictionaryEntry} card
 * @param {string} optionId
 * @param {number} [probabilityRoll] - in [0, 1); required only if the chosen option contains a PROBABILITY intent
 * @param {number} [dieFaceRoll] - 1-6; required only if the chosen option contains a DIE_FACE_REWARD intent (2026-08-22, C05/C11's own dice-face-tiered reward tables — same "always arrives as an input, never generated here" convention probabilityRoll already established)
 * @returns {import('../domain/eventDictionary.js').SettlementIntent[]}
 * @throws {EventChoiceError} unknown option, or balance below the option's validation.amount
 */
export function resolveChoice(gameState, playerId, card, optionId, probabilityRoll, dieFaceRoll) {
  if (card.type !== 'CHOICE') {
    throw new TypeError(`resolveChoice: card '${card.id}' is not a CHOICE card`);
  }

  const option = card.options.find((o) => o.id === optionId);
  if (!option) {
    throw new EventChoiceError(
      'UNKNOWN_OPTION',
      `resolveChoice: '${optionId}' is not a valid option for card '${card.id}'`
    );
  }

  if (option.validation) {
    const player = gameState.players.find((p) => p.id === playerId);
    if (!player) {
      throw new TypeError(`resolveChoice: playerId '${playerId}' not found in gameState.players`);
    }
    if (player.currentBalance < option.validation.amount) {
      throw new EventChoiceError(
        'INSUFFICIENT_BALANCE',
        `resolveChoice: player balance ${player.currentBalance} is below the required ${option.validation.amount} for option '${optionId}'`
      );
    }
  }

  const settlementIntents = [];
  for (const intent of option.intents) {
    if (intent.action === 'PROBABILITY') {
      if (typeof probabilityRoll !== 'number' || probabilityRoll < 0 || probabilityRoll >= 1) {
        throw new TypeError('resolveChoice: probabilityRoll must be a number in [0, 1) for an option with a PROBABILITY intent');
      }
      const outcome = probabilityRoll < intent.chance ? intent.onSuccess : intent.onFailure;
      settlementIntents.push(...outcome);
      continue;
    }

    if (intent.action === 'DIE_FACE_REWARD') {
      if (!Number.isInteger(dieFaceRoll) || dieFaceRoll < 1 || dieFaceRoll > 6) {
        throw new TypeError('resolveChoice: dieFaceRoll must be an integer in [1, 6] for an option with a DIE_FACE_REWARD intent');
      }
      const outcome = intent.table[String(dieFaceRoll)] ?? [];
      settlementIntents.push(...outcome);
      continue;
    }

    settlementIntents.push(intent);
  }

  return settlementIntents;
}
