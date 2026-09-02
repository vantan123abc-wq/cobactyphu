// Rent formulas — GAME_DESIGN_SPEC.md §11 (street/railroad/utility amounts),
// ECONOMY_SPECIFICATION.md §2 (monopoly/group bonus). Pure function: no I/O,
// no database driver, no Express, no Socket.IO.
//
// Terminology: 'transport' is this project's actual tile type (see
// tile.js's own terminology note) — §11's literal "railroad" wording maps
// onto it directly, same formula.
//
// This function does not itself re-check "is this tile owned by someone
// other than the payer, and unmortgaged" — resolveTile.js (P05-T02) already
// guarantees PAYING_RENT is only reached for exactly that case, so
// calculateRent's job is purely the amount formula, not eligibility.

const BUYABLE_TILE_TYPES = Object.freeze(['property', 'transport', 'utility']);

// Monopoly/group rent multiplier — REVISED 2026-09-02, and the revision is
// as much about WHERE it applies as about its size.
//
// It used to apply only to an UNIMPROVED group (ECONOMY_SPECIFICATION.md §2,
// "before any houses are built"), which is the classic rule. That rule works
// in classic Monopoly because building is gated behind owning the group: the
// ×2 is a stepping stone on the way to houses. This project removed that gate
// on 2026-08-25 — building needs no monopoly here — and with the gate gone the
// old shape quietly made the bonus and building MUTUALLY EXCLUSIVE: the bonus
// vanished the instant you built, and building was worth far more.
//
// Measured over 250 matches on the real board before this change: building one
// house on each lot of a group out-earns the unimproved ×2 bonus by 2.2-2.6× in
// EVERY group, and only **0.3%** of all rent paid ($1,992 of $666,281) was
// attributable to the bonus at all. It was dead weight. (Monopoly holders did
// win far more often — 46% vs 12.9% — but that is owning lots of property
// winning, not the bonus: the 0.3% is what separates correlation from cause.)
//
// The fix is not a bigger number in the same wrong place. A monopoly should
// MULTIPLY a developed group, not compete with developing it — you can hold
// both, and holding both should be the strongest position on the board. So the
// multiplier now applies at every upgrade level, unimproved through hotel.
// Unimproved rent is unchanged at ×2; what changes is that the bonus no longer
// evaporates the moment you build.
const GROUP_BONUS_MULTIPLIER = 2;

/**
 * True iff targetProperty qualifies for the monopoly/group bonus: every tile
 * sharing targetTile.groupId owned by the same owner, none of them mortgaged.
 * Gracefully returns false — never throws — when group data (targetTile.groupId
 * or groupTiles) isn't available.
 *
 * Note the absence of an upgradeLevel check: as of 2026-09-02 the bonus applies
 * at every development level (see GROUP_BONUS_MULTIPLIER above).
 * @param {import('../domain/tile.js').Tile} targetTile
 * @param {import('../domain/property.js').Property} targetProperty
 * @param {Array<{tile: import('../domain/tile.js').Tile, property: import('../domain/property.js').Property}>} ownerHoldings
 * @param {import('../domain/tile.js').Tile[]|undefined} groupTiles
 * @returns {boolean}
 */
function hasGroupBonus(targetTile, targetProperty, ownerHoldings, groupTiles) {
  if (!targetTile.groupId) {
    return false; // no group assigned to this tile — nothing to bonus (P02-T03 placeholder content, or a non-grouped property)
  }
  if (!groupTiles || groupTiles.length === 0) {
    return false; // graceful no-op: board-level group membership data wasn't supplied
  }

  const tilesInGroup = groupTiles.filter((t) => t.groupId === targetTile.groupId);
  if (tilesInGroup.length === 0) {
    return false;
  }

  return tilesInGroup.every((groupTile) => {
    const holding = ownerHoldings.find((h) => h.tile.id === groupTile.id);
    return Boolean(holding) && holding.property.ownerId === targetProperty.ownerId && !holding.property.mortgaged;
  });
}

/**
 * @param {Object} params
 * @param {import('../domain/tile.js').Tile} params.targetTile - the tile rent is owed on
 * @param {import('../domain/property.js').Property} params.targetProperty - its ownership state
 * @param {Array<{tile: import('../domain/tile.js').Tile, property: import('../domain/property.js').Property}>} params.ownerHoldings
 *   - every {tile, property} pair currently owned by targetProperty.ownerId, including the target itself
 * @param {import('../domain/tile.js').Tile[]} [params.groupTiles] - every Tile sharing targetTile.groupId
 *   (full board-level group membership, regardless of owner); omit/empty if group data isn't available yet — the group bonus then correctly no-ops
 * @param {number} [params.diceRoll] - required when targetTile.tileType is 'utility'
 * @param {string} [params.ruleset] - 'CLASSIC' or 'ASYMMETRIC'
 * @returns {number}
 */
export function calculateRent({ targetTile, targetProperty, ownerHoldings, groupTiles, diceRoll, ruleset = 'CLASSIC' }) {
  if (!BUYABLE_TILE_TYPES.includes(targetTile.tileType)) {
    throw new TypeError(`calculateRent: tileType '${targetTile.tileType}' has no rent`);
  }
  if (targetProperty.ownerId === null) {
    throw new TypeError('calculateRent: targetProperty has no owner — no rent is owed on an unowned tile');
  }

  switch (targetTile.tileType) {
    case 'transport': {
      const ownedCount = ownerHoldings.filter((h) => h.tile.tileType === 'transport').length;
      return targetTile.baseRent * Math.pow(2, ownedCount - 1);
    }

    case 'utility': {
      if (typeof diceRoll !== 'number') {
        throw new TypeError('calculateRent: diceRoll is required for utility rent');
      }
      const ownedCount = ownerHoldings.filter((h) => h.tile.tileType === 'utility').length;
      const multiplier = ownedCount >= 2 ? 10 : 4; // GAME_DESIGN_SPEC.md §11: diceRoll × (ownsBothUtilities ? 10 : 4)
      return diceRoll * multiplier;
    }

    case 'property': {
      const baseAmount =
        targetProperty.upgradeLevel === 0
          ? targetTile.baseRent
          : targetTile.rentTable[targetProperty.upgradeLevel - 1];

      const ownsGroup = hasGroupBonus(targetTile, targetProperty, ownerHoldings, groupTiles);

      if (ruleset === 'ASYMMETRIC') {
        // ASYMMETRIC Mode: No classic x2 multiplier. Buffs are handled via passive abilities elsewhere or specific custom rent multipliers here.
        // For now, no group multiplier is applied to rent in asymmetric mode unless a specific color dictates it.
        return baseAmount;
      } else {
        // CLASSIC Mode: x2 rent if owning the group
        return ownsGroup ? baseAmount * GROUP_BONUS_MULTIPLIER : baseAmount;
      }
    }

    default:
      // Exhaustiveness guard, same convention as resolveTile.js — unreachable
      // given the BUYABLE_TILE_TYPES check above, kept as a safety net.
      throw new Error(`calculateRent: no formula defined for tileType '${targetTile.tileType}'`);
  }
}
