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
  // CONTROL was [2, 4, 5] until 2026-09-07 — i.e. its top tier demanded ALL
  // FIVE of its tiles. Measured, that tier was reached in 2% of 2-player
  // matches and 0% of 4-player ones, so two thirds of the ladder existed only
  // in the UI. [2, 3, 4] leaves the entry threshold alone and makes the rest
  // actually reachable (tier 2: 10% -> 38%, tier 3: 3% -> 13% at n=500).
  CONTROL: [2, 3, 4],
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
    return { type: 'STEP_LOSS', amount: tier >= CONTROL_EXTRA_STEP_TIER ? 2 : 1 };
  }

  // EXECUTION (§3.2): scales with development, so it pays nothing until the
  // owner actually builds.
  //
  // RETUNED 2026-09-06. $75/level (the figure this comment used to cite as
  // "the simulated figure") was never actually re-verified against the
  // full shipped ruleset — traps, INFRA, the real 18-card deck and the
  // real jail routing all landed after that number was picked. A
  // Monte-Carlo harness driving the real engine (backend/scripts, not
  // committed — see docs/ASYMMETRIC_MODE_SPEC.md's own balance section)
  // measured a CONTROL-style specialist at 60%+ win rate against a
  // generalist at $75/level, and dropping the toll to $0 entirely still
  // left EXECUTION under 40% — proof the toll, not EXECUTION's already-high
  // base rent, was the actual swing factor. A sweep from $0 to $75 in $5-15
  // steps (400-600 trials per point) crossed 50% win rate right around
  // $25-30. $30 held that balance until ECONOMY and DENIAL gained crossing
  // fees of their own a day later, which changed the cash economy EXECUTION
  // has to build houses out of; it is $45 now, and EXECUTION_TOLL_PER_LEVEL's
  // own comment carries that measurement. EXECUTION is deliberately left a
  // small edge rather than a razor's-edge 50%, since it is also the single
  // most expensive, riskiest archetype to commit to on the board ($1,670 to
  // draft into, vs $400-1,480 for everything else).
  if (archetype === 'EXECUTION') {
    const amount = property.upgradeLevel * (EXECUTION_TOLL_PER_LEVEL + (tier - 1) * EXECUTION_TOLL_PER_TIER);
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
  //
  // From tier 2 a commission rides along with the reroll — see specialistFee.
  if (archetype === 'ECONOMY') {
    return withFee({ type: 'CARD_REROLL', ownerId: property.ownerId }, specialistFee(tier, ECONOMY_CROSSING_FEE));
  }

  // DENIAL (§3.1): information, not denial of action. "Lock a card type" was
  // the V2 design and it could deadlock outright — a locked type against a
  // hand holding only that type leaves no legal move, in the one phase whose
  // action list has no always-legal fallback.
  //
  // LIVE since per-viewer redaction landed — engine/stateRedaction.js's
  // maskPlayer reads the handRevealedTo entry this writes, socketServer.js
  // masks per recipient on the way out, and PlayersPanel.jsx renders the
  // revealed card with a 🔍 badge. (This comment used to warn the effect was
  // inert because the whole GameState was broadcast unredacted; that is no
  // longer true and the warning was stale.) The reveal is worth having:
  // measured informed-vs-blind DENIAL, both otherwise identical, the side
  // that acts on what it sees wins 57-60%. It is also worth nothing at all to
  // a player who ignores it, which is why tier 2 adds a fee that collects
  // whether or not anyone is paying attention — see specialistFee.
  if (archetype === 'DENIAL') {
    return withFee({ type: 'REVEAL_NEXT_CARD', ownerId: property.ownerId }, specialistFee(tier, DENIAL_CROSSING_FEE));
  }

  // INFRA (§2.3, wired 2026-09-04). Until now this archetype had NO arm in
  // either effect function: owning both utilities granted literally nothing,
  // while still occupying a tier ladder and a slot in every UI that lists the
  // archetypes. The Thế Lực panel surfaced that by saying so out loud, which
  // is what prompted finishing it.
  //
  // DEVIATES from the spec on purpose, and the deviation is the whole reason
  // it stayed unimplemented: §2.3 spends both of its effects on a "Quỹ dự
  // trữ" (reserve fund) that exists nowhere in this codebase — no state, no
  // deposit rule, no spending rule. Building that is a mechanic of its own,
  // not a synergy arm. What ships instead keeps INFRA's stated identity
  // ("POWER & SUSTAIN") using only vocabulary the engine already settles:
  //
  //   tier 1 (1 công ty)  — rent support only, +10% on EVERYTHING the owner
  //                         collects (calculateRentMiddleware.js)
  //   tier 2 (2 công ty)  — that becomes +25%, and crossing either of the
  //                         owner's utilities costs a flat usage fee here
  //
  // That makes INFRA the only SUPPORT archetype on the board: cheap ($400
  // for both), almost no threat of its own, and it multiplies whatever else
  // you already own. Deliberately small percentages — it applies to the
  // owner's whole portfolio, which no other archetype does, so the same
  // number that reads as modest here would be the strongest effect in the
  // ruleset if it were sized like CONTROL's +50%.
  if (archetype === 'INFRA') {
    return tier >= 2 ? { type: 'TOLL', amount: INFRA_CROSSING_FEE, ownerId: property.ownerId } : null;
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

// See passThroughEffect's own EXECUTION comment above for the 2026-09-06
// retuning that first landed on $30.
//
// RE-RAISED to $45 on 2026-09-07, and only because the board around it
// changed. Giving ECONOMY and DENIAL a crossing fee (see specialistFee below)
// put a new drain on everyone's cash, and EXECUTION is the archetype least
// able to absorb one: its own toll scales with upgradeLevel, so it is the
// only set that must BUILD before it threatens anything, and money spent
// paying other people's crossing fees is money not spent on houses. Measured
// directly — with the new fees in and the toll left at $30, EXECUTION fell
// from 53.2% to 40.3% and finished with 2.9 houses against the opponent's
// 5.7. At $45 it recovers to 49.5% and builds 4.3 against 4.4. $60 and $75
// were also swept and both overshot, dragging CONTROL down to 35-36%.
// REDISTRIBUTED 2026-09-07: was a flat $45 at every tier, now $30 at tier 1
// rising $15 per tier ($30 / $45 / $60). The average is deliberately about
// what it was — this is not a buff, it is the same money moved onto the tier
// ladder so the ladder means something. Measured balance-neutral: EXECUTION
// 45.2% flat vs 46.3% redistributed at n=300, inside the noise band.
export const EXECUTION_TOLL_PER_LEVEL = 30;

// Extra dollars per house level for each tier ABOVE the first. PROTOTYPE
// 2026-09-07, under measurement. Like CONTROL, EXECUTION's tier ladder was
// decorative before this — its toll scales with upgradeLevel and nothing
// else, so 2 owned tiles and 5 owned tiles produced an identical $90 toll.
export const EXECUTION_TOLL_PER_TIER = 15;

// The tier at which CONTROL's crossing effect becomes TWO steps instead of
// one. PROTOTYPE 2026-09-07. 99 = never (today's behaviour).
//
// The rent side was tried first and measured useless: CONTROL's tiles carry
// the LOWEST base rents on the board ($2-$8), so scaling its rent rider from
// +50% to +100% by tier moved its win rate by 0.5 points (26.1% -> 26.6%).
// Its whole value is the crossing effect, so that is where a tier reward has
// to go if it is to be felt at all.
export const CONTROL_EXTRA_STEP_TIER = 3;

/**
 * Flat fee for crossing a utility owned by someone holding BOTH of them
 * (INFRA tier 2). Flat rather than scaled because a utility has no
 * upgradeLevel to scale by, and small because INFRA's real payload is the
 * portfolio-wide rent support in calculateRentMiddleware.js — this half only
 * exists so the archetype is felt while walking past it, not just when
 * paying rent somewhere else entirely.
 */
export const INFRA_CROSSING_FEE = 25;

/**
 * ECONOMY's and DENIAL's crossing fee (2026-09-07), $30 per tier ABOVE the
 * first: $0 at tier 1, $30 at tier 2, $60 at tier 3.
 *
 * WHY THESE TWO ARCHETYPES GOT A CASH RIDER AT ALL. Both measured ~28-30%
 * win rate against a generalist while the other four sat at 43-53%, and the
 * portfolio diagnostics said why: the opponent finished with 5.9-6.8 houses
 * against ECONOMY/DENIAL versus 3.3-4.7 against everyone else. These were the
 * only two archetypes whose CROSSING effect (a card reroll, a card reveal)
 * cost the crosser no money and no tempo, so an opponent walked past them for
 * free and out-built them. Raising what they charge on LANDING was tried
 * first and rejected on the data: a rent rider swept from +0% to +100% moved
 * their win rate by less than noise (30.6% -> 31.2% for ECONOMY at DOUBLE
 * rent), because landing on a 6-tile set is simply too rare an event to
 * matter. Crossing is the frequent event, so crossing is where the fix went.
 *
 * WHY THE TIER-2 GATE IS THE DESIGN, NOT A KNOB. ECONOMY and DENIAL together
 * are purple+orange+yellow+green — 12 of the board's 22 properties. A fee
 * starting at tier 1 (2 tiles) therefore taxes more than half the board and
 * is collected mostly by whoever buys BROADLY, which is the generalist, not
 * the specialist. Measured: a tier-1-scaled $20 fee fixed ECONOMY and DENIAL
 * (both to ~50%) while dropping EXECUTION from 53.2% to 16.5% and CONTROL to
 * 28.7% — the opponent's scattered holdings were charging it constantly.
 * Tier 2 is 4 tiles of one archetype: a broad buyer almost never assembles
 * that, a specialist always does. The gate is what makes this a reward for
 * committing rather than a board-wide tax.
 *
 * Sweep behind $30: the full six-archetype field was re-measured at $30/step
 * paired with each candidate EXECUTION toll. $30 + EXECUTION $45 gave the
 * tightest spread — 40.9%-49.5% at n=500, against 28.2%-53.2% before this
 * change — with every net-worth ratio inside 0.89-1.05.
 */
const specialistFee = (tier, feePerTier) => (tier >= 2 ? (tier - 1) * feePerTier : 0);

/** Attaches a cash rider to a card effect, omitting the field entirely when
 * there is no fee — a `toll: 0` would otherwise change the shape of every
 * below-tier-2 effect object for no reason. */
const withFee = (effect, toll) => (toll > 0 ? { ...effect, toll } : effect);
export const ECONOMY_CROSSING_FEE = 30;
export const DENIAL_CROSSING_FEE = 30;
