// Tile resolution — the dispatcher behind GAME_STATE_MACHINE.md's
// `LANDING -->` fan-out. Pure function: no I/O, no database driver, no
// Express, no Socket.IO — only the domain shapes from P04-T01.
//
// Scope correction from IMPLEMENTATION_PLAN.md's original P05-T02 wording:
// that wording said "pure dispatch by tile.type", but GAME_STATE_MACHINE.md
// (the supreme source of truth for game logic) actually forks the
// property/transport/utility branch on ownership, not tile.type alone:
//   LANDING --> AWAITING_PURCHASE: unowned property
//   LANDING --> PAYING_RENT: owned by another
// So this dispatcher takes the landed Tile, its corresponding Property
// (ownership state; only meaningful for buyable tile types), and the
// landing player's id — not tile.type in isolation.

import { TILE_TYPES } from '../domain/tile.js';

// The tile types GAME_DESIGN_SPEC.md §9 calls the "Property system"
// (tiles where type = property | transport | utility) — the only types that
// carry a Property (ownership) row at all.
const BUYABLE_TILE_TYPES = Object.freeze(['property', 'transport', 'utility']);

/**
 * @param {import('../domain/property.js').Property} property
 * @param {string} currentPlayerId - PlayerGameState.id of the player who landed (same id space as Property.ownerId — not profiles.id)
 * @param {string} tileType - 'property' | 'transport' | 'utility'; only 'property' can ever take a house
 * @returns {'AWAITING_PURCHASE'|'PAYING_RENT'|'AWAITING_UPGRADE'|'POST_ACTIONS'}
 */
function resolveBuyableTile(property, currentPlayerId, tileType) {
  if (!property) {
    throw new TypeError(
      'resolveTile: property is required for a buyable tile type (property/transport/utility)'
    );
  }

  if (property.ownerId === null) {
    return 'AWAITING_PURCHASE';
  }
  if (property.ownerId === currentPlayerId) {
    // Landed on your own property — show build popup.
    //
    // Only STREET tiles, though (2026-08-25, found by fuzzing): stations and
    // utilities can never take a house, so routing them here put the player
    // into a phase whose only two legal actions are BUILD_HOUSE — which
    // handleBuildHouse rejects outright as "not a house-eligible tile" — and
    // DECLINE_UPGRADE. Not a deadlock (AWAITING_UPGRADE has its own 15s
    // timeout, and the frontend correctly greys the button out with a real
    // reason), but a pointless prompt plus a wasted timer on every landing on
    // your own station. Nothing is buildable there, so there is nothing to
    // decide: straight to POST_ACTIONS, exactly like landing on any other
    // tile with no decision attached.
    return tileType === 'property' ? 'AWAITING_UPGRADE' : 'POST_ACTIONS';
  }
  if (property.mortgaged) {
    // GAME_DESIGN_SPEC.md §11: no rent is owed on a mortgaged property
    // We go to POST_ACTIONS since they can't take over a mortgaged property easily? Or can they?
    // Let's just say mortgaged properties cannot be taken over to keep it simple, or maybe they can?
    // For now, let's keep it POST_ACTIONS.
    return 'POST_ACTIONS';
  }
  return 'PAYING_RENT';
}

/**
 * @param {import('../domain/tile.js').Tile} tile - the tile just landed on
 * @param {import('../domain/property.js').Property|null} [property] - required (non-null) when tile.tileType is 'property'/'transport'/'utility'; ignored otherwise
 * @param {string} [currentPlayerId] - PlayerGameState.id of the landing player; required when tile.tileType is buyable
 * @returns {'AWAITING_PURCHASE'|'PAYING_RENT'|'DRAWING_CARD'|'PAYING_TAX'|'POST_ACTIONS'}
 */
export function resolveTile(tile, property, currentPlayerId) {
  if (!TILE_TYPES.includes(tile.tileType)) {
    throw new TypeError(`Unknown tileType: ${tile.tileType}`);
  }

  switch (tile.tileType) {
    case 'property':
    case 'transport':
    case 'utility':
      return resolveBuyableTile(property, currentPlayerId, tile.tileType);

    case 'chance':
    case 'fortune':
      return 'DRAWING_CARD';

    case 'tax':
      return 'PAYING_TAX';

    case 'go':
    case 'jail': // just visiting
    case 'free_parking':
    case 'go_to_jail': // relocating the player onto the jail tile is a separate concern from this dispatcher
      return 'POST_ACTIONS';

    default:
      // Exhaustiveness guard (IMPLEMENTATION_PLAN.md's own risk note): if
      // TILE_TYPES ever grows without this switch being updated too, fail
      // loudly here rather than silently mis-resolving that tile category.
      // Unreachable today — the TILE_TYPES check above already rejects
      // anything not in the list — but stays as a safety net against drift
      // between the two.
      throw new Error(`resolveTile: no branch defined for tileType '${tile.tileType}'`);
  }
}

export { BUYABLE_TILE_TYPES };
