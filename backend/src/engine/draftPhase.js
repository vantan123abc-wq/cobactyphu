// Draft Phase (ASYMMETRIC_MODE_SPEC.md §1.3, "Constrained Draft") — pure
// logic for the 2-round, snake-order, 4-tile-offer draft that seeds every
// player's opening archetype before Turn 1.
//
// Why this exists at all: without it, a player's archetype is decided
// entirely by which cards the movement deck happens to hand them (see the
// Monte-Carlo discussion behind this branch) — there was no way to
// deliberately "build toward" CONTROL or EXECUTION. Constraining the draft to
// a random 4-tile offer per pick (rather than free choice from the whole
// board) is what keeps this from just calcifying into "everyone always picks
// ô5-17" — the exact meta-solve risk raised when an unconstrained draft was
// first proposed.
//
// Deliberately excludes transport/utility tiles from the offer pool: a
// player who wins the pick order could otherwise draft BOTH stations (or
// both utilities) in round 1 alone and start Turn 1 already at MOBILITY's
// or the Hạ Tầng archetype's top tier — a real balance hole in an earlier
// draft of this design, closed by restricting the pool to `property` tiles
// only.
//
// Pure and side-effect free except for the injected `randomSource` (same
// dice.js/serverGeneratedFields convention: real Math.random in production,
// overridable for deterministic tests) — no gameState mutation, no I/O.
// turnMachine.js's handleDraftPick/handleDraftPass own every state change
// and every applyTransaction call, the same split movementMiddleware/
// synergyEngine already established for movement and rent.

export const DRAFT_ROUNDS = 2;
export const DRAFT_OFFER_SIZE = 4;

/**
 * This round's pick order — ascending turn order for round 1, reversed
 * ("snake") for round 2, so the player who picks last in round 1 picks
 * first in round 2 rather than being disadvantaged twice in a row.
 *
 * @param {string[]} playerIdsAscending - real players' ids, already sorted by turnOrder
 * @param {number} round - 1 or 2
 * @returns {string[]}
 */
export function buildSnakeOrder(playerIdsAscending, round) {
  return round === 2 ? [...playerIdsAscending].reverse() : [...playerIdsAscending];
}

/**
 * Random offer of up to `count` still-unowned PROPERTY tiles (never
 * transport/utility — see file header). Returns fewer than `count` if the
 * board doesn't have that many left; never throws. Both real boards (22+
 * properties on Small, more on Large) have enough headroom that this can
 * never actually bind at realistic player counts (2 rounds x up to ~8
 * players x 1 tile each), but nothing here assumes that — a shrinking offer
 * degrades gracefully instead of crashing a still-plausible edge case.
 *
 * @param {import('../domain/tile.js').Tile[]} boardTiles
 * @param {Set<string>} ownedTileIds - boardTileId of every already-owned property (this round AND prior rounds)
 * @param {() => number} [randomSource]
 * @param {number} [count]
 * @returns {string[]} tile ids
 */
export function offerDraftTiles(boardTiles, ownedTileIds, randomSource = Math.random, count = DRAFT_OFFER_SIZE) {
  const pool = boardTiles.filter((t) => t.tileType === 'property' && !ownedTileIds.has(t.id));

  // Fisher-Yates, not a plain sort-by-random-key — the latter's bias is a
  // real, well-known footgun and this deck is small enough that avoiding it
  // costs nothing.
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(randomSource() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count).map((t) => t.id);
}

/**
 * The draftState a match starts with, before any pick has happened.
 *
 * @param {string[]} playerIdsInTurnOrder - real players' ids, ascending turnOrder
 * @param {import('../domain/tile.js').Tile[]} boardTiles
 * @param {() => number} [randomSource]
 */
export function initialDraftState(playerIdsInTurnOrder, boardTiles, randomSource = Math.random) {
  return {
    round: 1,
    pickOrder: buildSnakeOrder(playerIdsInTurnOrder, 1),
    currentPickIndex: 0,
    availableTileIds: offerDraftTiles(boardTiles, new Set(), randomSource),
  };
}

/**
 * Advances draftState by one pick (called after both a real DRAFT_PICK and a
 * DRAFT_PASS — passing still consumes your turn in the order, it just skips
 * the purchase). Three outcomes:
 *   - more picks left this round -> same round, next index in pickOrder
 *   - round 1 just finished -> round 2 starts, fresh 4-tile offer (excluding
 *     everything drafted in round 1), reversed order
 *   - round 2 just finished -> draft is over
 *
 * @param {object} draftState - the CURRENT draftState (before this advance)
 * @param {string[]} playerIdsInTurnOrder - ascending turnOrder, same array initialDraftState was built from
 * @param {import('../domain/tile.js').Tile[]} boardTiles
 * @param {Set<string>} ownedTileIds - every owned tile AFTER the pick/pass that triggered this advance
 * @param {() => number} [randomSource]
 * @returns {{done: true, draftState: null}|{done: false, draftState: object}}
 */
export function advanceDraftState(draftState, playerIdsInTurnOrder, boardTiles, ownedTileIds, randomSource = Math.random) {
  const nextIndex = draftState.currentPickIndex + 1;
  if (nextIndex < draftState.pickOrder.length) {
    return { done: false, draftState: { ...draftState, currentPickIndex: nextIndex } };
  }

  if (draftState.round >= DRAFT_ROUNDS) {
    return { done: true, draftState: null };
  }

  const nextRound = draftState.round + 1;
  return {
    done: false,
    draftState: {
      round: nextRound,
      pickOrder: buildSnakeOrder(playerIdsInTurnOrder, nextRound),
      currentPickIndex: 0,
      availableTileIds: offerDraftTiles(boardTiles, ownedTileIds, randomSource),
    },
  };
}
