// Draft Phase (ASYMMETRIC_MODE_SPEC.md §1.3, "Constrained Draft") — pure
// logic for the snake-order, 4-tile-offer draft that seeds every player's
// opening archetype before Turn 1. The number of rounds scales with the seat
// count (draftRoundsFor) rather than being fixed at 2.
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
// Transport/utility tiles USED to be excluded from the offer pool, to stop a
// player drafting both stations in round 1 and opening at MOBILITY's top
// tier. That exclusion was reversed on 2026-09-07 — see
// DRAFTABLE_TILE_TYPES's own comment for the measurements that forced the
// reversal, and for why the snowball it guarded against never materialised.
//
// Pure and side-effect free except for the injected `randomSource` (same
// dice.js/serverGeneratedFields convention: real Math.random in production,
// overridable for deterministic tests) — no gameState mutation, no I/O.
// turnMachine.js's handleDraftPick/handleDraftPass own every state change
// and every applyTransaction call, the same split movementMiddleware/
// synergyEngine already established for movement and rent.

/**
 * Draft rounds, by how many players are seated.
 *
 * NOT a constant any more (2026-09-07). It was 2 for every player count, and
 * that is the single biggest reason a 4-player match plays nothing like a
 * 2-player one: the small board has 26 buyable tiles and boards.sql seats 2-4
 * players on it, so a player goes from ~12 tiles each at 2 players to ~6 at 4
 * — while the synergy thresholds (2/4/5 tiles) stayed absolute. Measured over
 * 250 four-player matches with 2 rounds, a CONTROL specialist finished with
 * an average of 1.7 CONTROL tiles and reached NO tier at all in 49% of
 * matches; INFRA reached none in 56%. Half of every "pick an archetype" match
 * was resolving with the archetype switched off.
 *
 * The draft is the right lever because it is the only guaranteed acquisition
 * in the mode — everything after it depends on landing on the right tile
 * before three other players do. Scaling it with the seat count keeps the
 * PLAYER's experience constant (you can commit to a colour) instead of
 * keeping the BOARD's numbers constant.
 *
 * @param {number} playerCount
 * @returns {number}
 */
export function draftRoundsFor(playerCount) {
  return playerCount >= 4 ? 4 : playerCount === 3 ? 3 : 2;
}

/**
 * @deprecated Use draftRoundsFor(playerCount). Kept as the 2-player value
 * only, which is what it always was.
 */
export const DRAFT_ROUNDS = 2;
export const DRAFT_OFFER_SIZE = 4;

/**
 * How many tiles a round offers, by seat count.
 *
 * One offer is shared by every picker in a round, and (as of 2026-09-07) a
 * tile leaves that offer the moment someone drafts it. At the old fixed 4,
 * that made a 4-player round degenerate: 4 choices, then 3, then 2, then the
 * last player has exactly one "choice". Seats + 2 keeps a real decision for
 * everyone — and returns exactly 4 at two players, so the 2-player draft is
 * bit-for-bit what it was.
 */
export function draftOfferSizeFor(playerCount) {
  return Math.max(DRAFT_OFFER_SIZE, playerCount + 2);
}

/**
 * What the draft may offer. Stations and utilities are INCLUDED as of
 * 2026-09-07, reversing ASYMMETRIC_MODE_SPEC.md §1.4's "CẤM Draft Bến Xe và
 * Công Ty".
 *
 * That ban was written to stop a player drafting both stations on turn 0 and
 * owning MOBILITY's top tier for free. The measurement says it did something
 * much worse than the thing it prevented: MOBILITY and INFRA are 2 tiles each
 * on the small board and were the ONLY archetypes the draft could not reach,
 * so their specialists had to land on one of two specific tiles before anyone
 * else bought it. In 4-player matches they finished having activated NO tier
 * at all 48% and 56% of the time — an "archetype" that simply did not happen
 * in half of the games where somebody chose it. Adding draft rounds did not
 * help them by a single tile (0.7 owned at 2 rounds, 0.7 at 5) precisely
 * because of this exclusion.
 *
 * Lifting it, measured: tier-0 rate falls to 18% (MOBILITY) and 20% (INFRA)
 * at 4 players, and 2-player balance IMPROVES rather than degrades — the
 * spread between strongest and weakest archetype went 11.9 -> 6.8 points at
 * n=300. The feared snowball does not appear: owning both stations from turn
 * 0 is a real advantage but not a dominant one, and it costs both of a
 * player's early draft picks to get.
 */
const DRAFTABLE_TILE_TYPES = Object.freeze(['property', 'transport', 'utility']);

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
  // Every EVEN round reverses, not just round 2 — the original `round === 2`
  // was correct only while the draft was fixed at two rounds. With
  // draftRoundsFor() able to return 3 or 4, rounds 3 and 4 would otherwise
  // both run ascending and hand the first seat a compounding advantage,
  // which is the exact unfairness snake order exists to prevent.
  return round % 2 === 0 ? [...playerIdsAscending].reverse() : [...playerIdsAscending];
}

/**
 * Random offer of up to `count` still-unowned buyable tiles — property,
 * transport and utility alike (DRAFTABLE_TILE_TYPES). Returns fewer than `count` if the
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
  const pool = boardTiles.filter((t) => DRAFTABLE_TILE_TYPES.includes(t.tileType) && !ownedTileIds.has(t.id));

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
    availableTileIds: offerDraftTiles(boardTiles, new Set(), randomSource, draftOfferSizeFor(playerIdsInTurnOrder.length)),
  };
}

/**
 * Advances draftState by one pick (called after both a real DRAFT_PICK and a
 * DRAFT_PASS — passing still consumes your turn in the order, it just skips
 * the purchase). Three outcomes:
 *   - more picks left this round -> same round, next index in pickOrder
 *   - a round just finished and more remain -> next round starts with a fresh
 *     4-tile offer (excluding everything already drafted) and, on even rounds,
 *     reversed order
 *   - the LAST round just finished -> draft is over. How many rounds that is
 *     depends on the seat count: draftRoundsFor(playerIdsInTurnOrder.length)
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

  if (draftState.round >= draftRoundsFor(playerIdsInTurnOrder.length)) {
    return { done: true, draftState: null };
  }

  const nextRound = draftState.round + 1;
  return {
    done: false,
    draftState: {
      round: nextRound,
      pickOrder: buildSnakeOrder(playerIdsInTurnOrder, nextRound),
      currentPickIndex: 0,
      availableTileIds: offerDraftTiles(boardTiles, ownedTileIds, randomSource, draftOfferSizeFor(playerIdsInTurnOrder.length)),
    },
  };
}
