// Synergy (Thế Lực) evaluation for the ASYMMETRIC ruleset —
// docs/ASYMMETRIC_MODE_SPEC.md §2.
//
// Set levels are counted across a whole ARCHETYPE, not per colour group.
// That is the spec's own deliberate departure from classic Monopoly and it
// exists to fix a real balance hole: darkblue is only 2 tiles on both boards,
// so a per-group ladder handed EXECUTION its top tier for two purchases while
// ECONOMY needed six. Counting per archetype makes every top tier cost a
// comparable number of tiles (5 or 6).
//
// Consequence worth knowing when reading the rest of the engine: synergy
// progress and BUILDING progress now advance on different axes. Houses still
// require a complete colour group (handleBuildHouse's own INCOMPLETE_GROUP
// check, unchanged), so a player can sit at EXECUTION tier 2 with four tiles
// and still be unable to build on any of them. That is intended — the two
// systems reward different shapes of portfolio — but it is not obvious.
//
// Pure: no I/O, no randomness, no mutation. Everything is derived from
// gameState + boardTiles on each call rather than cached on the player, so
// there is no stored `activePerks` array to fall out of sync the moment a
// trade, auction, hostile buyout or bankruptcy moves a deed. That
// derive-don't-store choice is the whole reason this file exists separately.

/** groupId -> archetype. ASYMMETRIC_MODE_SPEC.md §2's own quadrant mapping. */
const GROUP_ARCHETYPE = Object.freeze({
  red: 'CONTROL',
  cyan: 'CONTROL',
  purple: 'ECONOMY',
  orange: 'ECONOMY',
  yellow: 'DENIAL',
  green: 'DENIAL',
  blue: 'EXECUTION',
  darkblue: 'EXECUTION',
});

/**
 * Tile-count thresholds per archetype, ascending. Index 0 is tier 1.
 * A tier is reached at `>=` its threshold, so an archetype the board happens
 * to be short of (MOBILITY is 2 stations on `small`, 4 on `large`) simply
 * tops out lower rather than exposing an unreachable tier — the fix for V2's
 * "Trạm Trung Chuyển is physically impossible on the small board" hole.
 */
const TIERS = Object.freeze({
  CONTROL: [2, 4, 5],
  ECONOMY: [2, 4, 6],
  DENIAL: [2, 4, 6],
  EXECUTION: [2, 4, 5],
  MOBILITY: [1, 2],
  INFRA: [1, 2],
});

/**
 * @param {import('../domain/tile.js').Tile} tile
 * @returns {string|null} archetype key, or null for a tile that belongs to none
 */
export function archetypeOf(tile) {
  if (!tile) return null;
  if (tile.tileType === 'transport') return 'MOBILITY';
  if (tile.tileType === 'utility') return 'INFRA';
  return GROUP_ARCHETYPE[tile.groupId] ?? null;
}

/**
 * How many tiles of `archetype` a player owns. Mortgaged deeds deliberately
 * do NOT count: a mortgaged property already collects no rent
 * (calculateRent's own rule), and letting it keep feeding a synergy would
 * make "mortgage everything, keep the tier" a free ride — the same reasoning
 * handleBuildHouse uses to refuse building on a group with a mortgaged member.
 *
 * @param {import('../domain/gameState.js').GameState} gameState
 * @param {import('../domain/tile.js').Tile[]} boardTiles
 * @param {string} playerId
 * @param {string} archetype
 * @returns {number}
 */
export function archetypeCount(gameState, boardTiles, playerId, archetype) {
  let count = 0;
  for (const property of gameState.properties) {
    if (property.ownerId !== playerId || property.mortgaged) continue;
    const tile = boardTiles.find((t) => t.id === property.boardTileId);
    if (archetypeOf(tile) === archetype) count++;
  }
  return count;
}

/**
 * Which tier (0 = none, 1..n) a player has reached in `archetype`.
 *
 * @returns {number} 0 when below the first threshold
 */
export function synergyTier(gameState, boardTiles, playerId, archetype) {
  const thresholds = TIERS[archetype];
  if (!thresholds) return 0;
  const owned = archetypeCount(gameState, boardTiles, playerId, archetype);
  let tier = 0;
  for (const threshold of thresholds) {
    if (owned >= threshold) tier++;
  }
  return tier;
}

/**
 * The pass-through effect an opponent triggers by CROSSING (not landing on)
 * `tile`, given who owns it. Returns null when nothing fires — an unowned
 * tile, the crosser's own tile, a mortgaged one, or an archetype whose owner
 * has not reached tier 1.
 *
 * Only the two Phase-1 movement-layer archetypes produce an effect here.
 * ECONOMY (discard/draw) and MOBILITY (nudge) are deliberately absent: both
 * need decisions and card-state that movement resolution has no business
 * reaching into, and both are still open design questions at hand size 2.
 * Adding them means adding a case here, nothing else.
 *
 * `fromPosition` is the crosser's position AT THIS TILE — i.e. `tile.position`
 * itself, for any effect (like MOBILITY's NUDGE) that needs to know where the
 * crosser currently stands mid-walk. It must NOT be read off
 * `gameState.players[...].currentPosition`: that field is the player's
 * position at the START of the whole move (movementMiddleware never mutates
 * it until the walk finishes), so for anything beyond a 1-tile step it would
 * silently point at the wrong tile for every crossing after the first.
 * Callers other than movementMiddleware's own walk loop (tests, mainly) may
 * omit it; it then falls back to that same stale gameState value, which is
 * only correct for a single-tile move.
 *
 * @returns {{type: 'STEP_LOSS', amount: number}|{type: 'TOLL', amount: number, ownerId: string}|{type: 'NUDGE', amount: number, ownerId: string}|null}
 */
export function passThroughEffect(gameState, boardTiles, tile, crosserId, fromPosition) {
  const property = gameState.properties.find((p) => p.boardTileId === tile.id);
  if (!property || !property.ownerId || property.ownerId === crosserId || property.mortgaged) {
    return null;
  }

  const archetype = archetypeOf(tile);
  const tier = synergyTier(gameState, boardTiles, property.ownerId, archetype);
  if (tier === 0) return null;

  // CONTROL (§2.1): a flat 1 step, at every tier. The -2 step at max tier was
  // cut in V3 and the simulation supports keeping it cut — CONTROL is the
  // cheapest archetype on the board ($440 for all five tiles) and already
  // collects 12.4 crossings per $100 invested against EXECUTION's 2.95.
  if (archetype === 'CONTROL') {
    return { type: 'STEP_LOSS', amount: 1 };
  }

  // EXECUTION (§3.2): scales with development, so it pays nothing until the
  // owner actually builds. $75/level is the simulated figure — at $25 the
  // toll was 1.5% of all money movement, i.e. decorative.
  if (archetype === 'EXECUTION') {
    const amount = property.upgradeLevel * EXECUTION_TOLL_PER_LEVEL;
    return amount > 0 ? { type: 'TOLL', amount, ownerId: property.ownerId } : null;
  }

  // ECONOMY (§2.4): reroll, not confiscation. The victim loses a random card
  // and immediately draws a replacement, so their hand SIZE never drops —
  // that distinction is the whole design. Taking a card outright would leave
  // a 2-card hand at 1, which is the no-choice state this entire ruleset
  // exists to escape, and ECONOMY is the most-crossed region on the board
  // (81.6 crossings/match in the simulation) so it would happen constantly.
  //
  // What it does destroy is card HOARDING: a player saving a JUMP to punch
  // through CONTROL can have it shuffled away on the approach. That makes
  // ECONOMY the natural counter to JUMP, which is in turn the counter to
  // CONTROL — the loop the archetype matrix wanted and previously lacked.
  if (archetype === 'ECONOMY') {
    return { type: 'CARD_REROLL', ownerId: property.ownerId };
  }

  // DENIAL (§3.1): information, not denial of action. "Lock a card type" was
  // the V2 design and it could deadlock outright — a locked type against a
  // hand holding only that type leaves no legal move, in the one phase whose
  // action list has no always-legal fallback.
  //
  // ⚠️ INERT TODAY. socketServer.js broadcasts the whole GameState to every
  // player in the room with no per-recipient redaction, so every hand is
  // already visible to everyone. This records the intent so redaction has
  // something to read, and so the effect starts working the moment redaction
  // lands, but it changes nothing a player can observe right now.
  if (archetype === 'DENIAL') {
    return { type: 'REVEAL_NEXT_CARD', ownerId: property.ownerId };
  }

  // MOBILITY (§2.2): a 1-step shove, aimed automatically at whichever of the
  // station owner's tiles the victim is closest to. The spec's own wording is
  // "tự động hoàn toàn, không popup hỏi ý kiến" — and that is not only a UX
  // preference. A prompt here would mean pausing movement resolution to wait
  // on a DIFFERENT player, which needs a new phase with its own timer, in a
  // ruleset whose one phase without a timer already froze matches once.
  //
  // Automation costs the owner nothing: shoving the victim toward your own
  // property is what a rational owner picks every time, so resolving it
  // deterministically removes a decision that was never really a decision.
  if (archetype === 'MOBILITY') {
    const crosser = gameState.players.find((p) => p.id === crosserId);
    const effectiveFrom = fromPosition ?? crosser?.currentPosition ?? tile.position;
    const direction = nudgeDirection(gameState, boardTiles, property.ownerId, effectiveFrom);
    return direction === 0 ? null : { type: 'NUDGE', ownerId: property.ownerId, amount: direction };
  }

  return null;
}

/**
 * +1 / -1 — which way to shove a victim standing at `fromPosition` so they end
 * up nearer one of `ownerId`'s tiles. 0 when the owner holds nothing worth
 * being shoved toward, which makes the whole effect a no-op rather than a
 * coin flip.
 */
function nudgeDirection(gameState, boardTiles, ownerId, fromPosition) {
  const boardSize = boardTiles.length;
  if (!boardSize) return 0;

  // Only rentable, developed-or-not PROPERTY tiles are worth aiming at — a
  // station is the thing doing the shoving and pushing someone onto another
  // station would just chain shoves.
  const targets = gameState.properties
    .filter((p) => p.ownerId === ownerId && !p.mortgaged)
    .map((p) => boardTiles.find((t) => t.id === p.boardTileId))
    .filter((t) => t && t.tileType === 'property')
    .map((t) => t.position);
  if (targets.length === 0) return 0;

  const forwardDistance = (from, to) => (to - from + boardSize) % boardSize;
  const best = (offset) => Math.min(...targets.map((t) => forwardDistance((fromPosition + offset + boardSize) % boardSize, t)));

  const ahead = best(1);
  const behind = best(-1);
  if (ahead === behind) return 0;
  return ahead < behind ? 1 : -1;
}

/**
 * The extra effect (beyond rent) of STOPPING on `tile`. Rent itself is
 * calculateRentMiddleware's job; this is only the archetype rider.
 *
 * @returns {{type: string, ownerId: string, amount?: number, rounds?: number}|null}
 */
export function landingEffect(gameState, boardTiles, tile, landerId) {
  const property = gameState.properties.find((p) => p.boardTileId === tile.id);
  if (!property || !property.ownerId || property.ownerId === landerId || property.mortgaged) {
    return null;
  }

  const archetype = archetypeOf(tile);
  const tier = synergyTier(gameState, boardTiles, property.ownerId, archetype);
  if (tier === 0) return null;

  // §2.4: the rare, large version of the pass-through draw. Two cards, and
  // they may push the owner past HAND_SIZE up to HAND_CAP — that headroom is
  // what makes ECONOMY a card engine rather than a rounding error.
  if (archetype === 'ECONOMY') {
    return { type: 'OWNER_DRAWS', ownerId: property.ownerId, amount: 2 };
  }

  // §3.1: same inert-until-redaction caveat as REVEAL_NEXT_CARD above.
  if (archetype === 'DENIAL') {
    return { type: 'REVEAL_HAND', ownerId: property.ownerId, rounds: 2 };
  }

  // MOBILITY §2.2, top tier only: the forced teleport. The single most lethal
  // effect in the ruleset, and the only one a victim cannot dodge at all —
  // which is exactly why it is gated behind holding EVERY station and why the
  // destination is resolved here rather than prompted for.
  //
  // Destination is the owner's highest-rent tile, computed rather than chosen.
  // Same reasoning as NUDGE: a prompt means blocking movement resolution on
  // another player's decision, and "throw them at my most expensive hotel" is
  // what any owner picks anyway. Stations are excluded as destinations, which
  // also makes a teleport-into-teleport loop structurally impossible.
  if (archetype === 'MOBILITY' && tier >= 2) {
    const target = highestRentTileOf(gameState, boardTiles, property.ownerId);
    return target ? { type: 'TELEPORT', ownerId: property.ownerId, targetPosition: target.position } : null;
  }

  return null;
}

/**
 * The owner's most punishing PROPERTY tile to be thrown onto. Ranked by
 * current rent — upgradeLevel first, then base rent — so a developed cheap
 * street correctly outranks an empty expensive one.
 */
function highestRentTileOf(gameState, boardTiles, ownerId) {
  const owned = gameState.properties
    .filter((p) => p.ownerId === ownerId && !p.mortgaged)
    .map((p) => ({ property: p, tile: boardTiles.find((t) => t.id === p.boardTileId) }))
    .filter(({ tile }) => tile && tile.tileType === 'property');
  if (owned.length === 0) return null;

  const rentOf = ({ property, tile }) =>
    property.upgradeLevel > 0 ? (tile.rentTable?.[property.upgradeLevel - 1] ?? 0) : (tile.baseRent ?? 0);

  return owned.reduce((best, candidate) => (rentOf(candidate) > rentOf(best) ? candidate : best)).tile;
}

export const EXECUTION_TOLL_PER_LEVEL = 75;
