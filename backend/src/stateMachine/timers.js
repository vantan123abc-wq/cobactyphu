// Timer system — GAME_STATE_MACHINE.md §7 (mechanism) + §4 (per-state
// durations and defaults). This is the first file in the backend that is
// NOT a pure function end to end — a real scheduled callback firing later
// is inherently a side effect over wall-clock time. The split kept here is
// deliberate: deadline computation and default-action synthesis stay pure
// and directly unit-testable (no real setTimeout waits); only
// TimerManager itself, which owns actual scheduling state, is impure, and
// even that accepts injected schedule/cancel/clock functions so tests
// never touch a real timer either.
//
// Per §7's explicit requirement, a fired timeout must run through the
// *same* apply pipeline as a real action — no separate timeout code path.
// Concretely: TimerManager only ever calls its caller's onTimeout(phase,
// deadlineAt); building the actual default action (buildDefaultAction,
// below) and calling turnMachine.js's transitionTurn() with it is left to
// that caller, since only the caller holds the live GameState this timer
// belongs to. TimerManager itself has no GameState dependency at all.

import { rollDice } from '../engine/dice.js';
import { MOVEMENT_CARDS } from '../domain/movementDictionary.js';
// getCurrentPlayer only — not a cycle: turnMachine.js never imports this
// file, only mentions it in comments (confirmed 2026-09-03).
import { getCurrentPlayer } from './turnMachine.js';
import { calculateSellHouse, calculateMortgage } from '../economy/propertyEconomy.js';
// AWAITING_EVENT_CHOICE's default needs the real card to pick a safe option
// from — same import infrastructure/websocket/socketServer.js already takes
// for serverGeneratedFields()'s own per-option lookup.
import { EVENT_CARDS } from '../domain/eventDictionary.js';

// GAME_STATE_MACHINE.md §0 — the timed states currently reachable in this
// backend's built turn sub-machine (turnMachine.js, P07-T01/T06-T09). Every
// other timed row in §4's table (RENT_RISK_DECISION,
// HOSTILE_ACQUISITION_PENDING) belongs to a still-[PROPOSED] mechanic
// turnMachine.js doesn't implement yet; LIQUIDATION_REQUIRED's own timeout
// is itself "[OPEN] — no timeout proposed" in that same table. Extending
// this map is how each gets picked up later, not a rework.
//
// FLASH_AUCTION_ACTIVE: 5s initial window, extended by FLASH_AUCTION_BID_EXTENSION_SECONDS
// (5s) every time a new PLACE_BID lands. This replaces the old 15s flat
// placeholder — socketServer.js's persistAndBroadcast handles the per-bid
// reset by detecting PLACE_BID on a still-FLASH_AUCTION_ACTIVE result and
// calling TimerManager.start() with a custom 5s deadline instead of the
// phase's base duration.

// Per-bid timer extension: each accepted PLACE_BID resets the auction
// countdown to this many seconds, giving latecomers a fair chance to respond.
// Exported so socketServer.js can use the same constant without duplicating it.
export const FLASH_AUCTION_BID_EXTENSION_SECONDS = 5;

export const TIMER_DURATIONS_SECONDS = Object.freeze({
  // GAME_DESIGN_SPEC.md §24's RECONNECT_GRACE_SECONDS (90s), wired
  // 2026-08-21 — not as its own separate disconnect-only timer, but by
  // closing the one real gap that made it necessary in the first place:
  // TURN_START previously had no entry here at all, so a player who
  // disconnected (or was just idle) at the exact start of their own turn
  // could stall the match forever — nothing else ever forces a START_TURN.
  // Every other phase already had its own timer shorter than the proposed
  // 90s grace period, which GAME_STATE_MACHINE.md §5 already establishes
  // fires "regardless of connection status" — so once this one phase is
  // covered too, a standalone 90s disconnect timer would be strictly
  // redundant with (and slower than) what already exists, not a missing
  // piece. TURN_START itself has no real decision to make (starting isn't
  // optional), so a short timeout matching AWAITING_PURCHASE's is fine.
  // Draft Phase (ASYMMETRIC only, engine/draftPhase.js), ASYMMETRIC_MODE_SPEC.md
  // §1.3 — a short window per pick, matching AWAITING_PURCHASE's own 15s: a
  // draft pick is a comparably quick yes/no-shaped decision (pick 1 of 4, or
  // pass), not a multi-option read like AWAITING_EVENT_CHOICE's 20s.
  DRAFTING_ACTIVE: 15,
  TURN_START: 15,
  JAIL_DECISION: 20, // JAIL_DECISION_TIMEOUT_SECONDS
  ROLLING: 20, // ROLL_TIMEOUT_SECONDS
  PLAYING_CARD: 30, // 30s to choose a movement card
  AWAITING_PURCHASE: 15, // PURCHASE_DECISION_TIMEOUT_SECONDS
  FLASH_AUCTION_ACTIVE: 5, // 5s initial window; per-bid extension handled in socketServer.js (FLASH_AUCTION_BID_EXTENSION_SECONDS)
  // RENT_RISK_DECISION removed 2026-08-25 — Rent Risk Choice no longer
  // blocks on an owner decision at all (turnMachine.js's resolveLanding own
  // comment has the full story), so there is no phase left to time out.
  // GAMBLE_RENT (its replacement) is a non-blocking side action dispatched
  // before this map is even consulted, the same way FORFEIT_MATCH is.
  // Both added 2026-08-23, finding #35 — these were the only two phases in
  // VALID_ACTIONS_BY_PHASE (turnMachine.js) that block the whole match on
  // one player's action while having no entry here at all. Because
  // socketServer.js's scheduleTurnTimer() reads an unlisted phase as
  // "system-only, nothing to time out to" and *cancels* the room's timer
  // outright, a player who drew a CHOICE event card (or was offered an
  // upgrade) and then closed their tab stalled the match permanently:
  // nothing ever fired, and every other player was rejected by the phase
  // gate plus finding #30's NOT_YOUR_TURN guard. The only escape was every
  // remaining player using FORFEIT_MATCH.
  //
  // This also repairs the reasoning in TURN_START's own comment above,
  // which asserted "every other phase already had its own timer" as the
  // stated basis for judging a standalone RECONNECT_GRACE_SECONDS
  // disconnect timer redundant. That claim had two real holes in it until
  // now; with these two covered it is finally true, so the conclusion it
  // supported stands rather than needing to be revisited.
  AWAITING_UPGRADE: 15, // same shape/duration as AWAITING_PURCHASE — one player, a short yes/no on a property they just landed on
  AWAITING_EVENT_CHOICE: 20, // a real multi-option read, not a yes/no — matched to JAIL_DECISION's own "pick between several" window rather than AWAITING_PURCHASE's 15
  POST_ACTIONS: 30, // POST_ACTIONS_TIMEOUT_SECONDS
  // Win Condition design (approved 2026-08-19, wired 2026-08-21) §E2 —
  // longer than every other timer here on purpose: a more consequential
  // decision (what to sacrifice) than a routine turn action, but still
  // bounded so a stalling debtor can't hold the whole table hostage.
  LIQUIDATION_REQUIRED: 45, // LIQUIDATION_TIMEOUT_SECONDS
});

/**
 * @param {string} now - ISO timestamp
 * @param {keyof TIMER_DURATIONS_SECONDS} phase
 * @returns {string} ISO timestamp — the absolute deadlineAt to broadcast
 *   (GAME_STATE_MACHINE.md §7: "broadcasts an absolute deadlineAt
 *   timestamp, not a relative 'seconds remaining'")
 */
export function computeDeadline(now, phase) {
  const durationSeconds = TIMER_DURATIONS_SECONDS[phase];
  if (durationSeconds === undefined) {
    throw new Error(`computeDeadline: '${phase}' has no timed default`);
  }
  return new Date(new Date(now).getTime() + durationSeconds * 1000).toISOString();
}

// Intents whose outcome is decided by a server roll rather than being
// knowable up front — engine/eventResolver.js's own resolveChoice() and
// socketServer.js's serverGeneratedFields() are the two authorities on this
// exact pair, mirrored here rather than re-derived.
const RISK_INTENT_ACTIONS = Object.freeze(['PROBABILITY', 'DIE_FACE_REWARD']);

/**
 * AWAITING_EVENT_CHOICE's own default action (finding #35, 2026-08-23).
 *
 * Unlike every other default here, a CHOICE card has no single fixed "safe"
 * action — the options are card-specific data, so the safe one has to be
 * picked from the real card. Two rules, in order, both matching posture
 * this codebase already established elsewhere:
 *
 *  1. Never default a player into a gamble — nothing in this codebase ever
 *     defaults *into* a risk (Rent Risk Choice's own Gamble side-offer is a
 *     player-chosen opt-in for exactly this reason, never a system
 *     default), so any option carrying a PROBABILITY or DIE_FACE_REWARD
 *     intent is skipped when a riskless one exists.
 *  2. Never pick an option the player cannot afford. `validation.amount` is
 *     the card's own declared precondition (the same field
 *     EventCardModal.jsx disables its button on), so options above the
 *     player's real balance are filtered out first — a synthesized default
 *     that gets rejected would leave the room stalled with no timer
 *     covering it, the exact failure handleTurnTimeout warns about.
 *
 * If no option is both affordable and riskless, the affordable ones win
 * (an unaffordable option is a hard rejection; a risky one at least
 * resolves), and the required roll is generated here — the timeout path
 * does NOT run through socketServer.js's serverGeneratedFields(), so
 * whatever the chosen option needs must be supplied in this payload, the
 * same way ROLLING's own default supplies a real rollDice() result.
 * @param {import('../domain/gameState.js').GameState} gameState
 * @param {() => number} randomSource
 * @returns {{ type: 'MAKE_EVENT_CHOICE', payload: object }}
 */
function buildEventChoiceDefaultAction(gameState, boardTiles, randomSource) {
  const card = EVENT_CARDS[gameState.pendingEventCardId];
  const options = card?.options ?? [];
  if (options.length === 0) {
    throw new Error(
      `buildDefaultAction: AWAITING_EVENT_CHOICE has no options to default to for card '${gameState.pendingEventCardId}'`
    );
  }

  // The drawing player is always the current-turn player — see
  // turnMachine.js's resolveDrawingCard, which only ever enters this phase
  // from that player's own landing.
  const player = gameState.players.find((p) => !p.isBank && p.turnOrder === gameState.currentTurnIndex);
  const balance = player?.currentBalance ?? 0;

  const affordable = options.filter((o) => (o.validation?.amount ?? 0) <= balance);
  // When NOTHING is affordable there is no valid choice to synthesize, so
  // this falls back to the full list on purpose. That used to hand
  // transitionTurn an action it rejected with INSUFFICIENT_BALANCE, which
  // froze the room permanently (handleTurnTimeout logs and returns, and the
  // timer is already cleared) — see handleEventChoice's own DEADLOCK ESCAPE
  // comment for the full reproduction. turnMachine.js now fizzles a card
  // nobody can afford into a no-op, so this fallback resolves the phase
  // instead of stalling it. Keep both halves: this one keeps the default
  // well-formed, that one keeps it applicable.
  const pool = affordable.length > 0 ? affordable : options;
  const riskless = pool.find((o) => !(o.intents ?? []).some((i) => RISK_INTENT_ACTIONS.includes(i.action)));
  const option = riskless ?? pool[0];

  const intents = option.intents ?? [];
  return {
    type: 'MAKE_EVENT_CHOICE',
    payload: {
      optionId: option.id,
      ...(intents.some((i) => i.action === 'PROBABILITY') ? { probabilityRoll: randomSource() } : {}),
      ...(intents.some((i) => i.action === 'DIE_FACE_REWARD') ? { dieFaceRoll: Math.floor(randomSource() * 6) + 1 } : {}),
      // C08 "Bảo Vệ Tài Sản" (2026-08-25) — this option's real input is WHICH
      // property to protect, which lives in the payload rather than the static
      // intent. Without supplying one here the timeout would synthesize an
      // action turnMachine.js then rejects (NOT_PROTECTABLE), leaving the
      // phase unresolved and the turn hung — finding #35's exact failure mode,
      // and caught by that finding's own regression test the moment this card
      // was added.
      //
      // Picks the most expensive protectable property rather than the first:
      // the timeout is acting on the player's behalf, and the priciest
      // unimproved holding is both the costliest to lose and the most
      // expensive for a rival to seize. Same "make the default a defensible
      // play, not merely a legal one" standard buildLiquidationDefaultAction
      // already sets by selling the CHEAPEST asset first.
      ...(intents.some((i) => i.action === 'GRANT_PROPERTY_PROTECTION')
        ? { propertyId: pickProtectionTarget(gameState, boardTiles, player?.id) }
        : {}),
    },
  };
}

/**
 * The property C08's timeout default protects: the acting player's most
 * expensive unimproved holding. Mirrors turnMachine.js's own
 * protectablePropertiesFor() eligibility (owned + `upgradeLevel === 0`;
 * mortgaged still counts, since mortgage status has never affected
 * hostile-buyout eligibility). Falls back to the first eligible property if
 * tile data is unavailable, and to `undefined` only when the player owns
 * nothing protectable — which the card's own eligibility gate makes
 * unreachable, since it never enters this phase in that case.
 */
function pickProtectionTarget(gameState, boardTiles, playerId) {
  const eligible = gameState.properties.filter((p) => p.ownerId === playerId && p.upgradeLevel === 0);
  if (eligible.length === 0) return undefined;

  const priceOf = (property) => boardTiles.find((t) => t.id === property.boardTileId)?.price ?? 0;
  return eligible.reduce((best, p) => (priceOf(p) > priceOf(best) ? p : best), eligible[0]).id;
}

/**
 * LIQUIDATION_REQUIRED's own default action (Win Condition design §E2,
 * wired 2026-08-21): "auto-liquidate, cheapest [asset] first". Unlike every
 * other default action above, this one needs real property/tile data —
 * the first reason buildDefaultAction below gained a boardTiles parameter.
 *
 * Builds every currently-*valid* SELL_HOUSE/MORTGAGE target across the
 * debtor's whole portfolio (mirroring turnMachine.js's handleSellHouse/
 * handleMortgage preconditions — the even-sell rule per group, and the
 * per-property house-free check for mortgage (`PROPERTY_HAS_HOUSES`, made
 * per-property 2026-09-02) — rather than assuming "sell first, mortgage
 * only if nothing to sell", since the cheaper liquidation might be either),
 * then picks
 * the single cheapest one, regardless of action type. checkSolvency()'s own
 * precondition for ever entering LIQUIDATION_REQUIRED guarantees at least
 * one candidate exists — the throw below is a defensive invariant check,
 * not an expected path (see handleTurnTimeout's own comment on what
 * happens if a synthesized default is ever rejected: the room stalls with
 * no timer covering it, so getting this list right matters more than usual).
 * @param {import('../domain/gameState.js').GameState} gameState
 * @param {import('../domain/tile.js').Tile[]} boardTiles
 * @returns {{ type: 'SELL_HOUSE' | 'MORTGAGE', payload: { propertyId: string } }}
 */
function buildLiquidationDefaultAction(gameState, boardTiles) {
  const debtorId = gameState.pendingLiquidation?.debtorId;
  const owned = gameState.properties.filter((p) => p.ownerId === debtorId);
  const tileFor = (property) => boardTiles.find((t) => t.id === property.boardTileId);
  const groupMatesOf = (property, tile) =>
    tile.groupId ? owned.filter((p) => tileFor(p)?.groupId === tile.groupId) : [property];

  const candidates = [];
  for (const property of owned) {
    const tile = tileFor(property);
    if (!tile) continue;

    if (property.upgradeLevel > 0) {
      const maxLevelInGroup = Math.max(...groupMatesOf(property, tile).map((p) => p.upgradeLevel));
      if (property.upgradeLevel >= maxLevelInGroup) {
        // even-sell rule: only the group's current highest-level member qualifies
        candidates.push({ type: 'SELL_HOUSE', propertyId: property.id, value: calculateSellHouse(tile).amount });
      }
    }

    if (!property.mortgaged && property.upgradeLevel === 0) {
      candidates.push({ type: 'MORTGAGE', propertyId: property.id, value: calculateMortgage(tile).amount });
    }
  }

  if (candidates.length === 0) {
    throw new Error(
      `buildLiquidationDefaultAction: debtor '${debtorId}' has nothing left to liquidate — should be unreachable per checkSolvency's own precondition`
    );
  }

  candidates.sort((a, b) => a.value - b.value);
  const { type, propertyId } = candidates[0];
  return { type, payload: { propertyId } };
}

/**
 * The documented default action per timed state (GAME_STATE_MACHINE.md
 * §4's "Default after timeout" column), synthesized exactly as a real
 * player action would be shaped — turnMachine.js's transitionTurn() can't
 * tell the difference, by design.
 *
 * JAIL_DECISION/ROLLING need an actual dice roll: real randomness belongs
 * here, not in turnMachine.js (which must stay pure) — randomSource
 * defaults to Math.random for production, overridable for deterministic
 * tests, same pattern as dice.js's own rollDice().
 * @param {keyof TIMER_DURATIONS_SECONDS} phase
 * @param {import('../domain/gameState.js').GameState} gameState - needed for ROLLING's currentDoublesStreak (P07-T02) and LIQUIDATION_REQUIRED's debtor/properties
 * @param {import('../domain/tile.js').Tile[]} [boardTiles] - only LIQUIDATION_REQUIRED's default needs this; every other phase ignores it, same as randomSource being ignored by non-dice phases
 * @param {() => number} [randomSource]
 * @returns {{ type: string, payload?: object }}
 */
export function buildDefaultAction(phase, gameState, boardTiles = [], randomSource = Math.random) {
  switch (phase) {
    case 'DRAFTING_ACTIVE': {
      // Auto-pick a random AFFORDABLE tile from the current offer, or pass if
      // none are (structurally very unlikely at real board prices — round 2's
      // most expensive realistic offer is still well under STARTING_BALANCE
      // minus round 1's spend — but checked rather than assumed, the same
      // defensive posture handleDraftPick itself takes on the live-click
      // path). Passing on timeout is loss-averse, matching every other timed
      // choice in this codebase's own default (AWAITING_PURCHASE/
      // AWAITING_UPGRADE both default to declining rather than spending).
      const picker = getCurrentPlayer(gameState);
      const availableTileIds = gameState.draftState?.availableTileIds ?? [];
      const affordable = availableTileIds.filter((tileId) => {
        const tile = boardTiles.find((t) => t.id === tileId);
        return tile && picker && picker.currentBalance >= tile.price;
      });
      if (affordable.length === 0) {
        return { type: 'DRAFT_PASS' };
      }
      const tileId = affordable[Math.floor(randomSource() * affordable.length)];
      return { type: 'DRAFT_PICK', payload: { tileId } };
    }

    case 'TURN_START':
      return { type: 'START_TURN' };

    case 'JAIL_DECISION':
      // A jail-escape attempt always starts its own doublesStreak at 0 —
      // same reasoning turnMachine.js already documents for the player-
      // initiated ATTEMPT_JAIL_ROLL path.
      return { type: 'ATTEMPT_JAIL_ROLL', payload: rollDice(0, randomSource) };

    case 'ROLLING':
      return { type: 'ROLL_DICE', payload: rollDice(gameState.currentDoublesStreak, randomSource) };

    case 'PLAYING_CARD': {
      // FIX (2026-09-03): this read `gameState.currentTurnPlayerId`, a field
      // that does not exist anywhere on the real GameState shape —
      // domain/gameState.js only ever sets `currentTurnIndex`. In production
      // this always resolved `currentPlayer` to `undefined`, and the
      // `if (!defaultCard) throw new Error(...currentPlayer.id...)` guard
      // just below then threw an unrelated TypeError (reading `.id` off
      // `undefined`) instead of the intended invariant error — meaning every
      // real PLAYING_CARD timeout (an AFK player during card selection)
      // threw an unrelated TypeError instead of returning the intended
      // default action. buildDefaultAction() is called OUTSIDE
      // handleTurnTimeout's own try/catch (infrastructure/websocket/
      // socketServer.js — that one only wraps applyWithIdempotency), so the
      // throw propagated out of the whole async function; scheduleTurnTimer's
      // own outer `.catch(err => console.error(...))` does catch it, so this
      // was logged rather than crashing the process — but persistAndBroadcast
      // (the only thing that re-arms the room's timer) is never reached
      // either way. TimerManager already cleared the fired timer before
      // calling this, so the net effect is identical either way: the room is
      // left with NO active timer and silently stalls, the exact failure
      // PLAYING_CARD's own timer was added to prevent in the first place.
      // Never caught by this file's own test because that test built a fake
      // gameState with the same nonexistent field, which is why it passed
      // for weeks.
      //
      // getCurrentPlayer is the real, tested way to resolve this — turnOrder
      // === currentTurnIndex — imported from turnMachine.js rather than
      // duplicated here.
      const currentPlayer = getCurrentPlayer(gameState);
      const defaultCard = currentPlayer?.movementHand?.[0];
      if (!defaultCard) {
        // Optional-chained even though currentPlayer "should" always resolve
        // here — this exact spot is where the previous bug's own error
        // message crashed instead of throwing, so it stays defensive.
        throw new Error(`buildDefaultAction: player '${currentPlayer?.id ?? 'unknown'}' has no movement cards in PLAYING_CARD phase — violates invariant`);
      }
      // Same server-generated-randomness rule the live-click path follows
      // (socketServer.js's serverGeneratedFields): a `random` card needs a
      // rolled step count, and this path must supply it too — otherwise an
      // AFK player defaulting onto MOVE_RANDOM_2_12 throws instead of moving.
      const def = MOVEMENT_CARDS[defaultCard];
      return {
        type: 'PLAY_MOVEMENT_CARD',
        payload: {
          cardId: defaultCard,
          ...(def?.random ? { cardRoll: rollDice(0, randomSource).total } : {}),
        },
      };
    }

    case 'AWAITING_PURCHASE':
      return { type: 'DECLINE_PURCHASE' };

    case 'AWAITING_UPGRADE':
      // Mirrors AWAITING_PURCHASE exactly — declining spends nothing and
      // changes nothing, the loss-averse default every timed choice in this
      // codebase already uses. Building on someone's behalf would spend
      // their money without consent.
      return { type: 'DECLINE_UPGRADE' };

    case 'AWAITING_EVENT_CHOICE':
      return buildEventChoiceDefaultAction(gameState, boardTiles, randomSource);

    case 'FLASH_AUCTION_ACTIVE':
      // System-generated, no playerId — turnMachine.js's handleAuctionAction
      // (P07-T08) forces settleAuction() regardless of activeBidders count.
      return { type: 'AUCTION_TIMEOUT' };

    case 'POST_ACTIONS':
      return { type: 'END_TURN' };

    case 'LIQUIDATION_REQUIRED':
      return buildLiquidationDefaultAction(gameState, boardTiles);

    default:
      throw new Error(`buildDefaultAction: '${phase}' has no timed default`);
  }
}

/**
 * Tracks at most one active timer per room, per GAME_STATE_MACHINE.md §7
 * ("one scheduled timer per room per active timed state — not per-player
 * polling"). Starting a new timer for a room that already has one replaces
 * it, rather than requiring the caller to remember to cancel first — the
 * "at most one" invariant is enforced here, not left to caller discipline.
 */
export class TimerManager {
  /**
   * @param {Object} [deps]
   * @param {(callback: () => void, delayMs: number) => *} [deps.schedule] - defaults to setTimeout; tests inject a fake
   * @param {(handle: *) => void} [deps.cancel] - defaults to clearTimeout; tests inject a fake
   * @param {() => string} [deps.now] - defaults to the real wall clock; tests inject a fixed/fake one
   */
  constructor({ schedule = setTimeout, cancel = clearTimeout, now = () => new Date().toISOString() } = {}) {
    this._schedule = schedule;
    this._cancel = cancel;
    this._now = now;
    this._active = new Map(); // roomId -> { handle, phase, deadlineAt }
  }

  /**
   * @param {string} roomId
   * @param {keyof TIMER_DURATIONS_SECONDS} phase
   * @param {(phase: string, deadlineAt: string) => void} onTimeout - called when this timer fires; never called if cancelled first
   * @returns {string} deadlineAt (ISO timestamp) — broadcast this to clients per §7
   */
  start(roomId, phase, onTimeout) {
    this.cancel(roomId);

    const startedAt = this._now();
    const deadlineAt = computeDeadline(startedAt, phase);
    const delayMs = new Date(deadlineAt).getTime() - new Date(startedAt).getTime();

    const handle = this._schedule(() => {
      this._active.delete(roomId);
      onTimeout(phase, deadlineAt);
    }, delayMs);

    this._active.set(roomId, { handle, phase, deadlineAt });
    return deadlineAt;
  }

  /**
   * Cancels roomId's pending timer, if any — a no-op otherwise. Called
   * whenever the player acts before the deadline, so the stale timer never
   * fires against a phase the game has already left.
   * @param {string} roomId
   */
  cancel(roomId) {
    const entry = this._active.get(roomId);
    if (entry) {
      this._cancel(entry.handle);
      this._active.delete(roomId);
    }
  }

  /** @param {string} roomId @returns {boolean} */
  isActive(roomId) {
    return this._active.has(roomId);
  }

  /** @param {string} roomId @returns {string|null} the active deadlineAt, or null if none */
  deadlineFor(roomId) {
    return this._active.get(roomId)?.deadlineAt ?? null;
  }
}
