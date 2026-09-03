// Turn state machine — the orchestrator that sequences P05 (engine) and
// P06 (economy) pure functions per GAME_STATE_MACHINE.md §2/§8's turn
// sub-machine. Pure function: no I/O, no database driver, no Express, no
// Socket.IO, and — per explicit instruction — no internal randomness or
// wall-clock reads either. Every source of external unpredictability
// (dice results, the current timestamp where one is genuinely needed)
// arrives as an input, never generated in here, so the same
// (gameState, boardTiles, action, now) always produces the same output.
//
// ============================================================
// SCOPE OF THIS PASS (Part 2) — what's wired end-to-end vs. deliberately
// stopped-and-flagged, not silently half-done:
// ============================================================
// Wired: TURN_START (jail check) -> JAIL_DECISION (all 3 exit paths,
// correctly distinguishing "released via doubles" [-> movement, same
// roll] from "released via forced 3rd attempt" [-> advances the turn
// immediately, no movement] from "failed, not yet forced" [-> advances
// the turn immediately, stays jailed] — see the note above
// handleJailAction, this required reading GAME_DESIGN_SPEC.md §15's
// narrative, not just GAME_STATE_MACHINE.md §8's single collapsed table
// row, which reads as if all three paths land on ROLLING) -> ROLLING
// (roll_dice) -> movement.js -> PASS_GO payout -> LANDING via
// resolveTile.js -> AWAITING_PURCHASE (buy/decline, including the
// ownership transfer, which no P05/P06 function performs) / PAYING_RENT
// or PAYING_TAX, each gated by bankruptcy.js's checkSolvency before
// applying the transfer -> POST_ACTIONS -> advanceTurn (doubles loop, per
// GameState.lastRollWasDouble — P07-T02, GameState tracks this itself
// rather than requiring every caller to thread it through an action
// payload — or advance to the next non-bankrupt player, cascading
// through the new player's TURN_START rather than stopping there, since
// it has no decision point of its own). The 3rd-consecutive-double jail
// entry and both jail-roll-failure paths all call advanceTurn directly
// too, rather than resting at an inert 'END_TURN' phase with no action
// defined to leave it — an actual bug in the first version of this file,
// caught while wiring lastRollWasDouble in, not shipped.
//
// ============================================================
// SCOPE OF THIS PASS (P07-T06) — Auction V1 + Event Card 2.0 wiring:
// ============================================================
// Newly wired: AWAITING_PURCHASE's decline path now calls
// engine/auction.js's calculateAuctionFee against the tile's price; if the
// declining player can afford it, the fee is charged (via applyIntents,
// below) and engine/auction.js's startAuction() populates
// GameState.pendingAuction, transitioning to FLASH_AUCTION_ACTIVE — if they
// can't afford it, this behaves exactly like the old plain decline
// (straight to POST_ACTIONS, no fee, no auction). DRAWING_CARD now really
// draws from GameState.eventDeck (domain/eventDictionary.js /
// engine/eventResolver.js's "Decision & Moment System" — additive
// alongside the still-untouched, still-unwired domain/eventCard.js flat-
// effect model, see PROJECT_STATUS.md): an INSTANT card's intents are
// applied immediately and the turn continues to POST_ACTIONS; a CHOICE
// card transitions to the new AWAITING_EVENT_CHOICE phase, recording
// GameState.pendingEventCardId, until a MAKE_EVENT_CHOICE action supplies
// an optionId (and, for options with a PROBABILITY intent, a
// probabilityRoll — sourced externally, same convention as ROLL_DICE's
// dice values: never generated inside this file).
//
// ============================================================
// SCOPE OF THIS PASS (P07-T07) — Flash Auction loop + resolution:
// ============================================================
// FLASH_AUCTION_ACTIVE now handles PLACE_BID and FOLD_AUCTION (see
// handleAuctionAction). Both require action.payload.playerId — unlike every
// other action in this file, the acting player here is NOT necessarily
// getCurrentPlayer(gameState): Flash Auction is explicitly "all players
// simultaneously... not turn-ordered" (BOARD_SPECIFICATION.md), so turn
// order can't identify the bidder the way it does everywhere else. A real
// caller sources playerId from the sender's own authenticated session
// (Socket.IO), not from whose turn it is.
//
// FOLD_AUCTION carries a rule not previously documented anywhere: if
// activeBidders drops to <= 1 after the fold, the auction resolves
// immediately (settleAuction() -> resolveAuction -> applyIntents ->
// POST_ACTIONS) rather than waiting for FLASH_AUCTION_BID_RESET_SECONDS'
// timer to elapse — "no one left to compete" is a supplementary end
// condition, on top of (not instead of) the timer-based ending. PLACE_BID
// never triggers resolution on its own.
//
// P07-T08 added AUCTION_TIMEOUT: the same settleAuction() forced
// unconditionally, regardless of how many active bidders remain — the
// state-machine-side half of the timer-based ending. System-generated, no
// playerId. The timer that would actually dispatch this action is still
// not built (see below) — this action is reachable and fully tested via a
// direct transitionTurn() call, same standing every other timeout default
// in this file had before timers.js (P07-T02) existed to fire it for real.
//
// Still deliberately NOT implemented (each substantial, not an oversight):
// - The FLASH_AUCTION_WINDOW_SECONDS/FLASH_AUCTION_BID_RESET_SECONDS timer
//   scheduling itself (§7) — timers.js's TIMER_DURATIONS_SECONDS/
//   buildDefaultAction don't know about FLASH_AUCTION_ACTIVE yet, so
//   nothing currently synthesizes and fires a real AUCTION_TIMEOUT action;
//   extending timers.js to do so is a natural next slice, not attempted
//   here (out of this task's stated file scope).
// - eventDeck exhaustion/reshuffling — drawCard() on an empty deck throws;
//   no recycle mechanism exists.
// - domain/eventCard.js's flat single-effect card model remains completely
//   separate and unwired — this pass only wires domain/eventDictionary.js's
//   newer shape.
// - The LIQUIDATION_REQUIRED -> LIQUIDATING -> PLAYER_ELIMINATED ->
//   GAME_OVER_CHECK chain — property transfer on bankruptcy, and the
//   auto-vs-player-chooses liquidation mechanism (GAME_DESIGN_SPEC.md §16
//   still marks this an open design decision) aren't built. When
//   checkSolvency says the debtor can't pay in cash, this machine stops
//   at phase LIQUIDATION_REQUIRED rather than guessing at unbuilt rules.
// - POST_ACTIONS' remaining sub-action (propose_trade/respond_trade) — still
//   not wired, and unlike build/sell/mortgage/unmortgage has no
//   propertyEconomy.js calculator waiting either (GAME_DESIGN_SPEC.md §10's
//   own [OPEN DESIGN DECISION]: "the detailed ruleset... is not specified").
//   SECURITY_DESIGN.md's own "Gaps found" #1 covers all six of these
//   together; build/sell/mortgage/unmortgage are now closed, trade is the
//   one left.
// - RENT_RISK_DECISION / HOSTILE_ACQUISITION_* — still gated behind
//   still-[PROPOSED] mechanics (Flash Auction, formerly in this same list,
//   was confirmed and is now the FLASH_AUCTION_ACTIVE entry above).
//
// ============================================================
// SCOPE OF THIS PASS — POST_ACTIONS: BUILD_HOUSE wired:
// ============================================================
// VALID_ACTIONS_BY_PHASE.POST_ACTIONS now also accepts BUILD_HOUSE
// (action.payload.propertyId, current-turn player only — see
// handleBuildHouse). Unlike END_TURN, a successful build does NOT advance
// the turn — GAME_DESIGN_SPEC.md §7: "PostActions (build, mortgage, propose
// trade) may happen in any order... not a forced single slot" — so it
// returns to POST_ACTIONS, allowing further post-actions or an explicit
// END_TURN. Group-mortgage state, the build-supply pool, and the
// upgrade-level ceiling are validated here (propertyEconomy.js's own header
// explicitly declines to own business-rule validation); calculateBuildHouse()
// supplies only the cost. (This originally also validated full-group
// ownership — removed 2026-08-25 — and the even-build rule — removed
// 2026-09-02.) New InvalidPropertyActionError (this file, same standing as
// auction.js's InvalidBidError; renamed from an original InvalidBuildError
// once SELL_HOUSE/MORTGAGE/UNMORTGAGE joined it, see its own comment) —
// socketServer.js's errorCodeFor() and WEBSOCKET_API.md's errorCode taxonomy
// were both updated to forward its `.reason` codes (NOT_OWNER/
// GROUP_MORTGAGED/INSUFFICIENT_SUPPLY/MAX_UPGRADE_LEVEL/RECENTLY_ACQUIRED),
// same convention as InvalidBidError's codes already use. House/hotel supply
// scarcity is deliberately not enforced — see handleBuildHouse's own
// docstring for why that's the doc's own suggested default, not a silent
// guess.
//
// ============================================================
// SCOPE OF THIS PASS — POST_ACTIONS: SELL_HOUSE/MORTGAGE/UNMORTGAGE wired:
// ============================================================
// Same treatment as BUILD_HOUSE above, same file, same session. New shared
// groupHoldingsFor() helper (factored out of handleBuildHouse's own inline
// group-lookup once handleSellHouse/handleMortgage needed the identical
// "every {tile, property} pair sharing this tile's groupId" shape a third
// time). SELL_HOUSE mirrors BUILD_HOUSE exactly but inverted — even-sell
// requires selling from the group's *highest*-level property, not its
// lowest (UNEVEN_SELL). (There was a matching UNEVEN_BUILD on the build
// side until the even-build rule was removed entirely on 2026-09-02.)
// MORTGAGE's precondition is per-property: only the target tile itself must
// be house-free (`PROPERTY_HAS_HOUSES` otherwise). It was briefly widened to
// "no property anywhere in the group may have upgradeLevel > 0" on 2026-08-18
// to match classic Monopoly, then reverted 2026-09-02 on explicit
// instruction ("chỉ cần ô đó hết nhà thì việc cầm cố ... là tùy vào người
// chơi") — the ×2 group bonus already drops the moment any group member is
// mortgaged (calculateRent.js's hasGroupBonus), so mortgaging one bare lot
// while its group-mates stay built is a real self-imposed cost, not a free
// exploit. `GAME_DESIGN_SPEC.md` §12 tracks both the 08-18 revision and this
// reversion. UNMORTGAGE has no group-level check at all (only mortgage does,
// per both the brief and real Monopoly rules) — reuses INSUFFICIENT_BALANCE rather
// than a new INSUFFICIENT_FUNDS code for the funds check, same reuse
// decision BUILD_HOUSE already made for the identical underlying condition.

import { movePlayer } from '../engine/movement.js';
import { resolveMovement } from '../engine/movementMiddleware.js';
import { MOVEMENT_CARDS, drawMovementHand, HAND_SIZE, HAND_CAP } from '../domain/movementDictionary.js';
import { resolveTile, BUYABLE_TILE_TYPES } from '../engine/resolveTile.js';
import { calculateFinalRent } from '../engine/calculateRentMiddleware.js';
import { landingEffect } from '../engine/synergyEngine.js';
import { checkSolvency } from '../engine/bankruptcy.js';
import { sendToJail, JAIL_FINE, useCard, rollForExit } from '../engine/jail.js';
import { applyTransaction } from '../economy/applyTransaction.js';
import { getBankPlayer } from '../economy/bank.js';
import {
  calculatePurchase,
  calculateBuildHouse,
  calculateSellHouse,
  calculateMortgage,
  calculateUnmortgage,
} from '../economy/propertyEconomy.js';
import { calculateAuctionFee, calculateBrokerCommission, startAuction, placeBid, foldBidder, resolveAuction } from '../engine/auction.js';
import { drawCard, evaluateEvent, resolveChoice } from '../engine/eventResolver.js';
import { EVENT_CARDS } from '../domain/eventDictionary.js';
import { MIN_UPGRADE_LEVEL, MAX_UPGRADE_LEVEL } from '../domain/property.js';
import { computeBankruptcySettlement } from '../engine/bankruptcyApplication.js';
import { checkElimination, shouldEnterFinalPhase, shouldEndFinalPhase, rankPlayers } from './gameEndMachine.js';

const PASS_GO_SALARY = 200; // GAME_DESIGN_SPEC.md §0, PROPOSED classic value

// Free Parking jackpot ceiling (2026-09-01). Set from real measurement, not
// taste: 750 simulated matches on the live small board put the payout median
// at $200 and p90 at exactly $600, but the tail ran to $1,300 — 9.6% of all
// payouts landed above $600. An uncapped pot that occasionally pays out more
// than half a starting balance turns one random landing into the match's
// biggest single swing, which is the "ai ăn jackpot thắng" failure mode the
// design brief explicitly wanted to avoid.
//
// Capped at the measured p90 rather than tuned at the source: the inputs
// (tax tiles at $200/$100, the $50 jail fine) are load-bearing elsewhere in
// the economy, so trimming them to control this one payout would move things
// that are currently balanced. A ceiling changes only the tail it is meant
// to change — ~90% of payouts are untouched.
const FREE_PARKING_JACKPOT_CAP = 600;
const HOSTILE_BUYOUT_MULTIPLIER = 2; // Phase 14 (2026-08-19) brief's own explicit number — BOARD_SPECIFICATION.md's older sketch had proposed >=150%, superseded by this fresh, more precise instruction

export class InvalidTurnActionError extends Error {
  constructor(phase, actionType) {
    super(`transitionTurn: action '${actionType}' is not valid during phase '${phase}'`);
    this.name = 'InvalidTurnActionError';
    this.phase = phase;
    this.actionType = actionType;
  }
}

// POST_ACTIONS property-management business-rule rejections (BUILD_HOUSE/
// SELL_HOUSE/MORTGAGE/UNMORTGAGE) — propertyEconomy.js's own header
// explicitly declines to own these ("no business-rule validation... belongs
// to a later orchestration/validation layer, not here"); this file is that
// layer, same standing as auction.js's InvalidBidError. `.reason` mirrors
// that same convention (WEBSOCKET_API.md's errorCode taxonomy forwards it
// directly, see socketServer.js's errorCodeFor).
//
// Named InvalidPropertyActionError, not InvalidBuildError — renamed when
// SELL_HOUSE/MORTGAGE/UNMORTGAGE were added alongside BUILD_HOUSE, since a
// mortgage rejection thrown as an "InvalidBuildError" would misdescribe
// itself to anyone reading the code or the error name in a log.
export class InvalidPropertyActionError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'InvalidPropertyActionError';
    this.reason = reason;
  }
}

// USE_INVENTORY_CARD's own business-rule rejections (Card Inventory system).
// A distinct class for the same reason InvalidJailActionError below is one:
// these were originally thrown as `InvalidTurnActionError('ANY', …)`, which
// socketServer.js's errorCodeFor() maps unconditionally to PHASE_MISMATCH —
// so "you don't hold that card" reached the client as "wrong phase", which
// is both wrong and unactionable (this action is phase-independent, so a
// phase can never be why it was refused). Reasons: CARD_NOT_HELD,
// CARD_NOT_KEEPABLE, NOT_ELIGIBLE, PLAYER_BANKRUPT, NOT_A_PARTICIPANT.
export class InvalidInventoryActionError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'InvalidInventoryActionError';
    this.reason = reason;
  }
}

// JAIL_DECISION's own business-rule rejections — same standing as
// InvalidPropertyActionError, a distinct class (not reused) so a "no card"
// rejection doesn't misdescribe itself as a property-action error in code
// or logs. Currently just one reason (NO_JAIL_CARD, 2026-08-22 — see
// handleJailAction's USE_JAIL_CARD branch) but named generically in case a
// future JAIL_DECISION rule needs the same class.
export class InvalidJailActionError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'InvalidJailActionError';
    this.reason = reason;
  }
}

// FORFEIT_MATCH's own business-rule rejections (2026-08-23) — same standing
// as InvalidJailActionError, a distinct class so these never misdescribe
// themselves as a different kind of error in code or logs.
export class InvalidForfeitError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'InvalidForfeitError';
    this.reason = reason;
  }
}

// Which action types are legal from which phase — the guard for guideline
// #5 ("invalid phase/action combinations throw an error"). System-only
// phases this machine always cascades straight through (MOVING, LANDING,
// BANKRUPTCY_CHECK, ...) intentionally have no entry here: nothing ever
// stops on them long enough to receive an action.
const VALID_ACTIONS_BY_PHASE = Object.freeze({
  TURN_START: ['START_TURN'],
  JAIL_DECISION: ['PAY_JAIL_FINE', 'USE_JAIL_CARD', 'ATTEMPT_JAIL_ROLL'],
  ROLLING: ['ROLL_DICE'],
  PLAYING_CARD: ['PLAY_MOVEMENT_CARD'],
  AWAITING_PURCHASE: ['BUY_PROPERTY', 'SKIP_PURCHASE', 'FORCE_AUCTION', 'DECLINE_PURCHASE'], // DECLINE_PURCHASE kept as backward-compat alias for SKIP_PURCHASE
  AWAITING_UPGRADE: ['BUILD_HOUSE', 'DECLINE_UPGRADE'],
  FLASH_AUCTION_ACTIVE: ['PLACE_BID', 'FOLD_AUCTION', 'AUCTION_TIMEOUT'],
  // RENT_RISK_DECISION removed 2026-08-25 — GAMBLE_RENT (the Rent Risk
  // Choice mechanic's revised action) is legal in ANY phase now, dispatched
  // from transitionTurn() before this map is even consulted, same as
  // FORFEIT_MATCH — see that action's own comment and handleGambleRent's.
  AWAITING_EVENT_CHOICE: ['MAKE_EVENT_CHOICE'],
  POST_ACTIONS: ['END_TURN', 'BUILD_HOUSE', 'SELL_HOUSE', 'MORTGAGE', 'UNMORTGAGE', 'HOSTILE_BUYOUT', 'DECLINE_HOSTILE_BUYOUT'],
  // Win Condition design (2026-08-19): reuses SELL_HOUSE/MORTGAGE verbatim
  // rather than a new action type — see resolveLiquidationStep()'s own
  // comment for how the same two handlers behave differently from this
  // phase than from POST_ACTIONS.
  LIQUIDATION_REQUIRED: ['SELL_HOUSE', 'MORTGAGE'],
});

// Exported for infrastructure/websocket/socketServer.js's turn-ownership
// guard (SECURITY_DESIGN.md "Known gaps" #5) — the one authoritative
// definition of "whose turn it is" reused by both the pure state machine
// (every handler below) and the impure dispatch layer, rather than a second
// copy drifting out of sync.
export function getCurrentPlayer(gameState) {
  return gameState.players.find((p) => !p.isBank && p.turnOrder === gameState.currentTurnIndex);
}

function replacePlayer(gameState, updatedPlayer) {
  return {
    ...gameState,
    players: gameState.players.map((p) => (p.id === updatedPlayer.id ? updatedPlayer : p)),
  };
}

// Every real, active player — the same `!isBank && !bankrupt` filter
// handleDeclinePurchase's own `eligibleBidders` already used inline; named
// and shared here now that applyIntents' new *_EACH_PLAYER/*_RICHEST/
// *_POOREST/*_PER_DEVELOPMENT branches (2026-08-22 deck) need the identical
// "who's still really playing" set three more times.
function eligiblePlayers(gameState) {
  return gameState.players.filter((p) => !p.isBank && !p.bankrupt);
}

function findTileAt(boardTiles, position) {
  return boardTiles.find((t) => t.position === position);
}

/**
 * Applies a settlement-intent array — the shared vocabulary
 * engine/auction.js's resolveAuction() and engine/eventResolver.js's
 * evaluateEvent()/resolveChoice() both return (ADD_MONEY/REMOVE_MONEY,
 * always Bank-vs-player in both of those callers; TRANSFER_PROPERTY,
 * auction-only) — to real GameState mutations. This is the translation
 * layer neither engine module performs itself, matching their own stated
 * boundary (they return intents, they don't call applyTransaction.js).
 *
 * Every ADD_MONEY/REMOVE_MONEY intent moves money against the Bank, using
 * `transactionType` for every intent in the batch (both current callers —
 * one auction fee/settlement, one event-card resolution — are internally
 * homogeneous, never a money intent and a property intent needing two
 * different transaction types in the same call). An intent's own
 * `playerId` wins if present (auction.js always sets one); otherwise
 * `contextPlayerId` applies (eventResolver.js's intents don't carry one —
 * they're implicitly "the player who drew/chose this card").
 *
 * Bank-mediated only — ADD_MONEY always credits from the Bank, REMOVE_MONEY
 * always debits to the Bank, matching its two current callers (auction
 * settlement, event-card resolution), both always player-vs-Bank. NOT reused
 * by stateMachine/tradeMachine.js's ACCEPT_TRADE — a trade payment is a
 * direct player-to-player transfer, which this vocabulary can't express
 * (see engine/trade.js's acceptTrade docstring); that handler calls
 * economy/applyTransaction.js directly instead, the same way this file's
 * own settleDebt() (rent) already does.
 *
 * MOVE_TO_JAIL/GRANT_JAIL_CARD (2026-08-22) are the two non-money/property
 * intents so far — `boardTiles` exists on this signature only for
 * MOVE_TO_JAIL's own need to look up the real Jail tile's position (the
 * board is adaptive, 36 or 44 tiles — no fixed index). auction.js's own
 * settlement intents never produce either of these, so both current
 * money/property-only callers (handleDeclinePurchase's auction fee,
 * settleAuction) now just thread `boardTiles` through unused rather than
 * needing a second function shape.
 * @param {import('../domain/gameState.js').GameState} gameState
 * @param {import('../domain/tile.js').Tile[]} boardTiles
 * @param {Array<{action: string, playerId?: string, amount?: number, propertyId?: string, toPlayerId?: string}>} intents
 * @param {string} transactionType
 * @param {string} contextPlayerId
 * @returns {{ gameState: import('../domain/gameState.js').GameState, transactions: object[] }}
 */
function applyIntents(gameState, boardTiles, intents, transactionType, contextPlayerId) {
  const bank = getBankPlayer(gameState);
  let state = gameState;
  const transactions = [];
  // Charges the payer cannot cover in cash — see chargePlayer() below, and
  // settlePendingDebts() for what the callers then do with them.
  const pendingDebts = [];

  /**
   * Every player -> Bank charge in this function goes through here
   * (2026-08-23). Fixing a real, verified logic bug: applyTransaction does
   * no solvency check at all — it simply subtracts — so an event card
   * charging more than the player held drove the balance NEGATIVE and the
   * game carried on as if nothing happened. Measured before the fix: a
   * player holding $10 drawing QUY_TO_DAN_PHO (-$50) ended at -$40, not
   * bankrupt, no liquidation, phase POST_ACTIONS. Negative money is not a
   * state this game has rules for.
   *
   * Every OTHER debt in the game (rent, tax, jail fine) already routes
   * through settleDebt(), which runs checkSolvency and then either pays,
   * enters LIQUIDATION_REQUIRED, or applies real bankruptcy. Event cards
   * were the one path that bypassed it, purely because applyIntents was
   * written as a simple "batch of field mutations" helper before any of that
   * machinery existed.
   *
   * Affordable charges keep the exact fast path they always had (so no
   * existing behaviour or test changes); only a genuinely unaffordable one
   * is deferred to the caller, which settles it through the real
   * settleDebt() so liquidation/bankruptcy/elimination all work identically
   * to any other debt.
   */
  function chargePlayer(payerId, amount) {
    if (amount <= 0) return;
    const payer = state.players.find((p) => p.id === payerId);
    if (payer.currentBalance >= amount) {
      const { gameState: next, transaction } = applyTransaction(state, {
        fromPlayerId: payerId,
        toPlayerId: bank.id,
        amount,
        transactionType,
      });
      state = next;
      transactions.push(transaction);
      return;
    }
    pendingDebts.push({ debtorId: payerId, creditorId: bank.id, amount, transactionType });
  }

  for (const intent of intents) {
    if (intent.action === 'ADD_MONEY') {
      const { gameState: next, transaction } = applyTransaction(state, {
        fromPlayerId: bank.id,
        toPlayerId: intent.playerId ?? contextPlayerId,
        amount: intent.amount,
        transactionType,
      });
      state = next;
      transactions.push(transaction);
    } else if (intent.action === 'REMOVE_MONEY') {
      chargePlayer(intent.playerId ?? contextPlayerId, intent.amount);
    } else if (intent.action === 'TRANSFER_PROPERTY') {
      const properties = state.properties.map((p) =>
        p.id === intent.propertyId ? { ...p, ownerId: intent.toPlayerId } : p
      );
      state = { ...state, properties };
    } else if (intent.action === 'MOVE_TO_JAIL') {
      // Reuses engine/jail.js's own sendToJail() — the exact function whose
      // docstring already listed "drawing a matching card" as one of jail's
      // three real entry triggers, never wired to the event-card system
      // until now. No PASS_GO consideration needed here (unlike a normal
      // roll): this is a direct relocation, not movement across the board,
      // so there's no "crossed position 0 along the way" to reason about.
      const targetPlayer = state.players.find((p) => p.id === (intent.playerId ?? contextPlayerId));
      const jailTile = boardTiles.find((t) => t.tileType === 'jail');
      const jailed = sendToJail(targetPlayer, jailTile.position);
      state = replacePlayer(state, jailed);
    } else if (intent.action === 'GRANT_JAIL_CARD') {
      const targetPlayer = state.players.find((p) => p.id === (intent.playerId ?? contextPlayerId));
      state = replacePlayer(state, { ...targetPlayer, jailFreeCards: targetPlayer.jailFreeCards + 1 });
    } else if (intent.action === 'ADD_MONEY_EACH_PLAYER' || intent.action === 'REMOVE_MONEY_EACH_PLAYER') {
      // K03/K04 (2026-08-22 deck) — every real, non-bankrupt player, Bank-
      // mediated per-player (same "Bank-mediated only" standing as plain
      // ADD_MONEY/REMOVE_MONEY above) — a bankrupt player has nothing left
      // to meaningfully tax/reward and is excluded, same convention
      // eligibleBidders (Flash Auction) already uses for "real, active
      // players" elsewhere in this file.
      const targets = eligiblePlayers(state);
      for (const target of targets) {
        if (intent.action === 'REMOVE_MONEY_EACH_PLAYER') {
          chargePlayer(target.id, intent.amount);
          continue;
        }
        const { gameState: next, transaction } = applyTransaction(state, {
          fromPlayerId: bank.id,
          toPlayerId: target.id,
          amount: intent.amount,
          transactionType,
        });
        state = next;
        transactions.push(transaction);
      }
    } else if (intent.action === 'REMOVE_MONEY_RICHEST' || intent.action === 'ADD_MONEY_POOREST') {
      // K06/K10 (2026-08-22 deck) — the deck's own explicit "avoid snowball"
      // reasoning: on a tie, EVERY tied player pays/receives `tiedAmount`
      // each (a real, reduced-per-player amount, not `amount` split between
      // them) — K06's own text is explicit about this ("tất cả người đồng
      // hạng cao nhất trả $50", not "$100 chia đều"). Bank-mediated, same as
      // the plain single-target intents.
      const targets = eligiblePlayers(state);
      const balances = targets.map((p) => p.currentBalance);
      const extreme = intent.action === 'REMOVE_MONEY_RICHEST' ? Math.max(...balances) : Math.min(...balances);
      const tied = targets.filter((p) => p.currentBalance === extreme);
      const perPlayerAmount = tied.length > 1 ? intent.tiedAmount : intent.amount;
      for (const target of tied) {
        if (intent.action === 'REMOVE_MONEY_RICHEST') {
          chargePlayer(target.id, perPlayerAmount);
          continue;
        }
        const { gameState: next, transaction } = applyTransaction(state, {
          fromPlayerId: bank.id,
          toPlayerId: target.id,
          amount: perPlayerAmount,
          transactionType,
        });
        state = next;
        transactions.push(transaction);
      }
    } else if (intent.action === 'REMOVE_MONEY_IF_BALANCE_AT_LEAST') {
      // K12 (2026-08-22 deck) — cash, not net worth: the brief's own
      // reasoning is explicit ("net worth có thể nằm trong property và rất
      // khó thanh khoản; cash mới là thứ quyết định khả năng sống sót") —
      // property/net-worth-based thresholds are a real, separate, harder
      // question (this project's own net worth engine exists, but nothing
      // here reaches for it) not attempted for this card.
      const targets = eligiblePlayers(state).filter((p) => p.currentBalance >= intent.threshold);
      for (const target of targets) {
        chargePlayer(target.id, intent.amount);
      }
    } else if (intent.action === 'REMOVE_MONEY_PER_DEVELOPMENT') {
      // K09 (2026-08-22 deck) — a genuinely per-player *computed* amount
      // (unlike every other intent here, which uses a flat amount from the
      // card's own data): amountPerLevel x the sum of upgradeLevel across
      // every property this player owns, hotels included (upgradeLevel 5,
      // same "no separate hotel price, hotels cost 5 uniform builds"
      // convention handleHostileBuyout's own currentValue calculation
      // already established). A player who owns nothing pays $0 — skipped
      // entirely, not a real $0 transaction (applyTransaction itself
      // rejects a non-positive amount, same as Rent Risk Choice's own
      // losing-gamble branch already relies on).
      const targets = eligiblePlayers(state);
      for (const target of targets) {
        const developmentLevels = state.properties
          .filter((p) => p.ownerId === target.id)
          .reduce((sum, p) => sum + p.upgradeLevel, 0);
        const owed = developmentLevels * intent.amountPerLevel;
        if (owed <= 0) continue;
        chargePlayer(target.id, owed);
      }
    } else if (intent.action === 'SET_RENT_MODIFIER_PERCENT') {
      // K01/K02 (2026-08-22 deck) — GameState.rentModifierPercent's own doc
      // comment has the full reasoning (global, round-scoped, layered onto
      // calculateRent.js's output at its own call site, not inside that
      // pure function). No transaction — this only ever sets a GameState
      // field, no money moves at draw time.
      state = { ...state, rentModifierPercent: intent.percent };
    } else if (intent.action === 'SET_BUILD_COST_MODIFIER') {
      state = { ...state, buildCostModifierAmount: intent.amount };
    } else if (intent.action === 'GRANT_NEXT_BUILD_DISCOUNT') {
      // C07/C12-B (2026-08-22 deck) — PlayerGameState.nextBuildDiscount's
      // own doc comment. Additive with an already-pending discount (a
      // second draw before the first is spent stacks, rather than
      // overwriting) — there's no real reason to discard an unspent one.
      const targetPlayer = state.players.find((p) => p.id === (intent.playerId ?? contextPlayerId));
      state = replacePlayer(state, { ...targetPlayer, nextBuildDiscount: targetPlayer.nextBuildDiscount + intent.amount });
    } else if (intent.action === 'GRANT_NEXT_RENT_DISCOUNT') {
      // C12-C — unlike nextBuildDiscount, this one is NOT additive (a
      // {percent, max} pair doesn't have an obvious "stack" semantics the
      // way a flat dollar amount does) — a second grant before the first is
      // spent simply replaces it, same as SET_RENT_MODIFIER_PERCENT/
      // SET_BUILD_COST_MODIFIER already do for their own overlapping-grant
      // case.
      const targetPlayer = state.players.find((p) => p.id === (intent.playerId ?? contextPlayerId));
      state = replacePlayer(state, { ...targetPlayer, nextRentDiscount: { percent: intent.percent, max: intent.max } });
    } else {
      // Exhaustiveness guard, same convention as resolveTile.js/calculateRent.js.
      throw new Error(`applyIntents: unhandled intent action '${intent.action}'`);
    }
  }

  return { gameState: state, transactions, pendingDebts };
}

/**
 * Guard for the two applyIntents() callers that are structurally incapable
 * of producing an unaffordable charge (each validates funds itself first).
 * They therefore have no settlement step — and without this, a future change
 * that broke that assumption would make the charge silently vanish, money
 * simply never leaving the payer. Loud beats silent for anything touching
 * the ledger.
 */
function assertNoUnpaidDebts(pendingDebts, callerName) {
  if (pendingDebts.length > 0) {
    throw new Error(
      `${callerName}: applyIntents produced ${pendingDebts.length} unaffordable charge(s), but this caller has no settlement path — the payer's funds were meant to be validated before this point`
    );
  }
}

/**
 * Settles whatever charges applyIntents() could not pay in cash, through
 * the SAME settleDebt() every other debt in this game uses — so an event
 * card that overdraws a player produces real liquidation, real bankruptcy
 * and real elimination, exactly as an unaffordable rent or tax bill does
 * (2026-08-23; see chargePlayer()'s own comment for the bug this closes).
 *
 * Debts are settled in the order they were incurred. Settling stops early
 * the moment one of them doesn't resolve straight back to POST_ACTIONS —
 * that means the game is now waiting on something (LIQUIDATION_REQUIRED) or
 * has ended outright, and neither state may be trampled by continuing to
 * charge people. Deliberately conservative: a multi-payer card (K04's
 * "everyone pays $25") that bankrupts someone mid-way stops there rather
 * than pressing on, since the phase it produced is the real one to honour.
 * @returns {{ gameState: import('../domain/gameState.js').GameState, transactions: object[] }}
 */
function settlePendingDebts(gameState, boardTiles, transactions, pendingDebts, now) {
  let state = gameState;
  let allTransactions = transactions;

  for (const debt of pendingDebts) {
    const debtor = state.players.find((p) => p.id === debt.debtorId);
    if (!debtor || debtor.bankrupt) continue; // already eliminated by an earlier debt in this same batch

    // Re-check affordability against the CURRENT balance rather than the one
    // at the moment the charge was recorded — an earlier intent in the same
    // card (an ADD_MONEY, or a per-player payout) may have since covered it.
    if (debtor.currentBalance >= debt.amount) {
      const { gameState: paid, transaction } = applyTransaction(state, {
        fromPlayerId: debt.debtorId,
        toPlayerId: debt.creditorId,
        amount: debt.amount,
        transactionType: debt.transactionType,
      });
      state = paid;
      allTransactions = [...allTransactions, transaction];
      continue;
    }

    // A debt owed by someone who is NOT the current player cannot go down
    // the LIQUIDATION_REQUIRED road, and this is a real constraint rather
    // than a preference: that phase resolves SELL_HOUSE/MORTGAGE through
    // getCurrentPlayer(), and socketServer.js's turn guard only accepts
    // those actions from the current-turn player — so a non-current debtor
    // literally cannot act on their own liquidation, and the player whose
    // turn it is would end up mortgaging THEIR OWN property to clear
    // someone else's debt. Settled as immediate bankruptcy instead.
    //
    // FLAGGED SIMPLIFICATION, not a claim that this is ideal: real Monopoly
    // would let an out-of-turn player mortgage to raise the money. Supporting
    // that needs genuinely new machinery (a debtor-scoped liquidation phase,
    // plus relaxing the socket turn guard for it) well beyond this fix.
    // Reachable only from the three multi-player charge cards (K04/K06/K09);
    // K12 is threshold-gated so its targets can always pay.
    const isCurrentPlayer = getCurrentPlayer(state)?.id === debt.debtorId;
    if (!isCurrentPlayer) {
      const applied = applyBankruptcy(state, boardTiles, debt.debtorId, debt.creditorId, now);
      // debt.debtorId is explicitly NOT the current player on this branch
      // (the isCurrentPlayer check above), so this never force-advances —
      // passed anyway so the decision stays in one place, not duplicated here.
      const finished = finishAfterBankruptcy(applied.gameState, boardTiles, applied.transactions, now, debt.debtorId);
      state = finished.gameState;
      allTransactions = [...allTransactions, ...finished.transactions];
      if (state.status !== 'in_progress') break;
      continue;
    }

    const result = settleDebt(state, boardTiles, debt, now);
    state = result.gameState;
    allTransactions = [...allTransactions, ...result.transactions];

    if (state.status !== 'in_progress' || state.phase !== 'POST_ACTIONS') break;
  }

  return { gameState: state, transactions: allTransactions };
}

/**
 * Every {tile, property} pair currently owned by ownerId — the shape
 * calculateRent.js/bankruptcy.js's holdings parameter expects.
 */
function holdingsFor(gameState, boardTiles, ownerId) {
  return gameState.properties
    .filter((p) => p.ownerId === ownerId)
    .map((p) => ({ tile: boardTiles.find((t) => t.id === p.boardTileId), property: p }));
}

/**
 * Every {tile, property} pair sharing targetTile.groupId, self-inclusive —
 * regardless of owner, unlike holdingsFor() above. `[]` when targetTile has
 * no groupId (no real seed content assigns one yet — PROJECT_STATUS.md's
 * open items), same graceful-empty convention calculateRent.js's
 * hasGroupBonus already uses, so group-dependent checks correctly fail
 * closed rather than treating an ungrouped tile as a trivial group-of-one.
 * Shared by handleBuildHouse/handleSellHouse/handleMortgage.
 */
function groupHoldingsFor(gameState, boardTiles, targetTile) {
  if (!targetTile.groupId) {
    return [];
  }
  return boardTiles
    .filter((t) => t.groupId === targetTile.groupId)
    .map((t) => ({ tile: t, property: gameState.properties.find((p) => p.boardTileId === t.id) }));
}

/**
 * The subset of targetTile's colour group that `ownerId` actually owns —
 * the correct scope for the even-sell rule and handleBuildHouse's
 * GROUP_MORTGAGED check as of 2026-08-25, when owning the *complete* group
 * stopped being a precondition for building (user request: "không cần sở
 * hữu nhóm màu mới được xây nhà mà là xây được luôn nếu quay lại"). The
 * even-build rule was one of these consumers until it was removed entirely
 * on 2026-09-02; MORTGAGE was another until its check went per-property the
 * same day (only handleSellHouse and handleBuildHouse call this now).
 *
 * Before the 2026-08-25 change these rules could safely scan the whole
 * group, because a builder provably owned all of it. They cannot any more,
 * and leaving them group-wide would have been actively broken rather than
 * merely stricter: SELL's `maxLevelInGroup` would include a rival's taller
 * building, so their development would stop you selling your own house.
 * Scoping to the acting player's own holdings keeps each rule's real
 * intent (unwind your own set from the top down; don't build over your own
 * mortgaged lot) while making it independent of what anyone else does with
 * the rest of the group.
 *
 * Always contains at least the target property itself, since every caller
 * checks ownership first — so `Math.min`/`Math.max` over it are never
 * empty-array cases. A tile with no groupId at all yields no group rows,
 * so the target is substituted explicitly.
 * @returns {Array<{tile: import('../domain/tile.js').Tile, property: import('../domain/property.js').Property}>}
 */
function ownedGroupHoldingsFor(gameState, boardTiles, targetTile, targetProperty, ownerId) {
  const mine = groupHoldingsFor(gameState, boardTiles, targetTile).filter((h) => h.property?.ownerId === ownerId);
  return mine.length > 0 ? mine : [{ tile: targetTile, property: targetProperty }];
}

/**
 * Phase 14 (2026-08-19): GAME_DESIGN_SPEC.md §14's tax-jackpot variant, now
 * confirmed adopted (was `[OPEN DESIGN DECISION]`, default "disappears").
 * Only tax/jail-fine payments feed it — the only two Bank-directed debts
 * settleDebt()/payJailFineOrLiquidate()/resolveLiquidationStep() ever
 * settle; rent is player-to-player and never touches this, and neither
 * does any other Bank payment (BUY_PROPERTY, auction fees, UNMORTGAGE, ...)
 * the brief never named. A no-op for any other transactionType, so every
 * call site can call this unconditionally rather than needing its own
 * if-tax-or-jail-fine guard. ECONOMY_SPECIFICATION.md's own guidance for
 * this variant: the payment itself is unchanged (still pays the Bank for
 * real — this just separately tracks that same running total, paid out as
 * its own real transaction on landing, see resolveLanding's free_parking
 * branch), never a redirected destination.
 */
function feedFreeParkingJackpot(gameState, transactionType, amount) {
  if (transactionType !== 'tax' && transactionType !== 'jail_fine') {
    return gameState;
  }
  return {
    ...gameState,
    freeParkingJackpot: Math.min(FREE_PARKING_JACKPOT_CAP, gameState.freeParkingJackpot + amount),
  };
}

/**
 * Shared by PAYING_RENT and PAYING_TAX. Win Condition design (2026-08-19):
 * now branches on checkSolvency()'s full result, not just canPayInCash —
 * the previous version discarded isBankrupt/totalLiquidatableValue and
 * simply parked at LIQUIDATION_REQUIRED forever, a dead end (no
 * VALID_ACTIONS_BY_PHASE entry existed for it). Three real outcomes:
 *   1. canPayInCash — pay directly, unchanged from before.
 *   2. Cash-short but solvent via liquidation (!isBankrupt) — the debtor
 *      must sell/mortgage to raise the difference; see
 *      resolveLiquidationStep() for how LIQUIDATION_REQUIRED's own
 *      VALID_ACTIONS_BY_PHASE entry (SELL_HOUSE/MORTGAGE) resumes this.
 *   3. isBankrupt — real bankruptcy: hand over everything remaining, in
 *      kind (applyBankruptcy()), then check whether that was the
 *      second-to-last active player (finishAfterBankruptcy()).
 * @param {string} now - ISO timestamp, needed here (unlike before) for a genuine bankruptAt/endedAt — see moveAndResolve's own header for why this is newly threaded all the way down from transitionTurn's own `now` param
 */
function settleDebt(gameState, boardTiles, { debtorId, creditorId, amount, transactionType }, now) {
  const debtor = gameState.players.find((p) => p.id === debtorId);
  const solvency = checkSolvency({
    cashOnHand: debtor.currentBalance,
    debt: amount,
    holdings: holdingsFor(gameState, boardTiles, debtorId),
  });

  if (solvency.canPayInCash) {
    const { gameState: afterPayment, transaction } = applyTransaction(gameState, {
      fromPlayerId: debtorId,
      toPlayerId: creditorId,
      amount,
      transactionType,
    });
    return {
      gameState: feedFreeParkingJackpot({ ...afterPayment, phase: 'POST_ACTIONS' }, transactionType, amount),
      transactions: [transaction],
    };
  }

  if (!solvency.isBankrupt) {
    const pendingLiquidation = { debtorId, creditorId, amount, transactionType };
    return { gameState: { ...gameState, phase: 'LIQUIDATION_REQUIRED', pendingLiquidation }, transactions: [] };
  }

  const { gameState: afterBankruptcy, transactions } = applyBankruptcy(gameState, boardTiles, debtorId, creditorId, now);
  return finishAfterBankruptcy(afterBankruptcy, boardTiles, transactions, now, debtorId);
}

/**
 * Real bankruptcy — GAME_DESIGN_SPEC.md §16's "hand over remaining
 * properties/cash in kind" flow, distinct from the cash-liquidation path
 * above (see engine/bankruptcyApplication.js's own header for why these
 * are two different moments, not a contradiction). Applies
 * computeBankruptcySettlement()'s pure output: flags the debtor bankrupt,
 * transfers cash via the same applyTransaction precedent every other
 * ledger movement in this file uses, reassigns property ownership directly
 * (same pattern applyIntents' TRANSFER_PROPERTY already uses), drops any
 * pending trade naming the debtor, and folds them out of an active auction
 * exactly like a normal FOLD_AUCTION would (reusing foldBidder/
 * settleAuction, not reinventing either).
 */
function applyBankruptcy(gameState, boardTiles, debtorId, creditorId, now) {
  const settlement = computeBankruptcySettlement(gameState, debtorId, creditorId);

  const debtor = gameState.players.find((p) => p.id === debtorId);
  // An eliminated player is left holding nothing — cash and properties
  // transfer below, pending trades are dropped, an active auction folds them
  // out. Cards in hand were the one asset class still left behind (2026-09-01):
  // `inventory` (Card Inventory system) and `jailFreeCards` both survived
  // bankruptcy, so CardInventory.jsx kept rendering a dead hand for a player
  // who can never act again. Not exploitable on its own — handleUseInventoryCard
  // now refuses a bankrupt actor outright — but leaving phantom assets on an
  // eliminated player contradicts every other line of this settlement.
  let state = replacePlayer(gameState, { ...debtor, bankrupt: true, bankruptAt: now, inventory: [], jailFreeCards: 0 });

  const transactions = [];
  if (settlement.cashAmount > 0) {
    const { gameState: afterCash, transaction } = applyTransaction(state, {
      fromPlayerId: debtorId,
      toPlayerId: creditorId,
      amount: settlement.cashAmount,
      transactionType: 'bankruptcy_transfer',
    });
    state = afterCash;
    transactions.push(transaction);
  }

  // Phase 14 (2026-08-19): buildings only ever return to the shared supply
  // alongside a Bank-directed forfeiture (toPlayerId null) — a
  // player-to-player transfer keeps every property "exactly as it sits"
  // (this file's own header, quoting GAME_DESIGN_SPEC.md §16), buildings
  // included; the new owner simply inherits them, nothing to return.
  let houseSupply = state.houseSupply;
  let hotelSupply = state.hotelSupply;
  for (const transfer of settlement.propertyTransfers) {
    if (transfer.toPlayerId !== null) continue;
    const property = state.properties.find((p) => p.id === transfer.propertyId);
    if (property.upgradeLevel === MAX_UPGRADE_LEVEL) {
      hotelSupply += 1;
    } else {
      houseSupply += property.upgradeLevel;
    }
  }

  const properties = state.properties.map((p) => {
    const transfer = settlement.propertyTransfers.find((t) => t.propertyId === p.id);
    if (!transfer) return p;
    // A property reverting to the Bank ("unowned, purchasable again" —
    // GAME_DESIGN_SPEC.md §16's own words) can't still show phantom
    // buildings nobody paid for — those are exactly what just returned to
    // houseSupply/hotelSupply above, so the property's own upgradeLevel
    // resets to 0 in lockstep. mortgaged is deliberately left untouched —
    // out of this task's own scope, unlike upgradeLevel.
    return { ...p, ownerId: transfer.toPlayerId, upgradeLevel: transfer.toPlayerId === null ? 0 : p.upgradeLevel };
  });
  state = { ...state, properties, houseSupply, hotelSupply };

  const pendingTrades = state.pendingTrades.filter((t) => t.proposerId !== debtorId && t.targetId !== debtorId);
  state = { ...state, pendingTrades };

  // An unclaimed Gamble side-offer (pendingRentGamble, Rent Risk Choice
  // REVISED 2026-08-25) is owner-only and non-blocking, so unlike the old
  // RENT_RISK_DECISION phase it never needs a forced default when its owner
  // leaves — there is nobody left waiting on it, so it simply drops rather
  // than being resolved on the bankrupt/forfeiting owner's behalf.
  if (state.pendingRentGamble?.ownerId === debtorId) {
    state = { ...state, pendingRentGamble: null };
  }

  // A C08 protection dies with its owner — every property they held has just
  // changed hands (to the creditor, or back to the Bank), so a protection
  // still naming them would either shield an asset they no longer own or
  // dangle a reference to an eliminated player. Same cleanup, same reason, as
  // pendingRentGamble directly above.
  if (state.propertyProtection?.ownerId === debtorId) {
    state = { ...state, propertyProtection: null };
  }

  if (state.pendingAuction && state.pendingAuction.activeBidders.includes(debtorId)) {
    const folded = foldBidder(state.pendingAuction, debtorId);
    if (folded.activeBidders.length > 1) {
      state = { ...state, pendingAuction: folded };
    } else {
      // `boardTiles` was missing here (fixed 2026-09-01, found by fuzzing).
      // settleAuction's signature is (gameState, boardTiles, auction); this
      // call passed only two arguments, so the auction object landed in the
      // boardTiles slot and `auction` arrived undefined — a hard
      // `TypeError: resolveAuction: auction is required` for any player who
      // went bankrupt or forfeited while being the second-to-last live
      // bidder in an auction.
      const settled = settleAuction(state, boardTiles, folded, now);
      state = settled.gameState;
      transactions.push(...settled.transactions);
    }
  }

  return { gameState: state, transactions };
}

/**
 * FORFEIT_MATCH — a player voluntarily gives up and leaves an in-progress
 * match (2026-08-23, user request). Dispatched from transitionTurn() BEFORE
 * its VALID_ACTIONS_BY_PHASE gate, mirroring the exact precedent trade
 * actions already established for "this needs to work no matter what phase
 * the game happens to be in" — a player must be able to quit mid-roll,
 * mid-auction, mid-jail-decision, anything. action.payload.playerId is the
 * sender's real resolved identity — socketServer.js's handleGameAction
 * injects it into every action's payload, not just the turn-independent
 * ones (see that file's own action-building code) — never trusted from
 * anywhere else.
 *
 * Mechanically this IS voluntary bankruptcy, and reuses that exact real
 * machinery (applyBankruptcy/computeBankruptcySettlement) rather than a
 * second "remove a player" pathway — GAME_DESIGN_SPEC.md §16's own "hand
 * over remaining properties/cash in kind" already describes losing
 * everything you own, which is exactly what forfeiting means too. Two real
 * moments a forfeit can interrupt, each resolved through the SAME existing
 * mechanism that already handles it when a player can't pay a debt, not a
 * parallel one built just for this:
 *   1. The forfeiter owes a live LIQUIDATION_REQUIRED debt themselves —
 *      settled as a real bankruptcy to the REAL creditor already on record
 *      (pendingLiquidation.creditorId), not the Bank — indistinguishable
 *      from "gave up instead of trying to liquidate."
 *   2. Neither of the above — an ordinary voluntary bankruptcy to the Bank
 *      (their land becomes unowned/purchasable again, exactly
 *      GAME_DESIGN_SPEC.md §16's own Bank-creditor case). This is also the
 *      branch every other phase falls into (ROLLING, AWAITING_PURCHASE,
 *      JAIL_DECISION, FLASH_AUCTION_ACTIVE as a bidder, POST_ACTIONS, ...).
 * (A third case used to live here — the forfeiter holding a pending
 * RENT_RISK_DECISION as its owner — removed 2026-08-25 alongside that whole
 * phase; an unclaimed Gamble side-offer is non-blocking and simply drops on
 * bankruptcy now, applyBankruptcy()'s own job, not this function's.)
 * In every case applyBankruptcy() already folds the forfeiter out of any
 * pending trade and any active Flash Auction on its own (existing,
 * untouched logic) — no forfeit-specific handling needed for either.
 *
 * Turn advancement deliberately does NOT mirror an ordinary debt-driven
 * bankruptcy: today, a current-turn player who goes bankrupt via debt is
 * left at POST_ACTIONS and still has to click End Turn themselves once
 * (finishAfterBankruptcy's own unconditional behavior) — reasonable there,
 * since it's still genuinely their turn and they're still present to click
 * it. A forfeiting player is, by definition, no longer present to click
 * anything. If they held the turn when they forfeited, it is force-advanced
 * immediately here (`lastRollWasDouble` forced false first, the same "no
 * bonus turn survives an early exit" rule handleJailAction's own
 * jail-escape path already established, for the identical reason — the
 * bonus would otherwise hand the now-vacant seat a phantom replay). If it
 * wasn't their turn, the real current player's phase/position is left
 * completely untouched — advanceTurn()'s own bankrupt-player skip already
 * routes every future turn around the forfeiter from here on.
 */
function resolveForfeit(gameState, boardTiles, action, now) {
  const { playerId } = action.payload;
  const forfeiter = gameState.players.find((p) => p.id === playerId);
  if (!forfeiter || forfeiter.isBank) {
    throw new InvalidForfeitError('NOT_A_PLAYER', `resolveForfeit: '${playerId}' is not a real player in this game`);
  }
  if (forfeiter.bankrupt) {
    throw new InvalidForfeitError('ALREADY_ELIMINATED', `resolveForfeit: '${playerId}' has already left this match`);
  }
  const stillStanding = gameState.players.filter((p) => !p.isBank && !p.bankrupt && p.id !== playerId);
  if (stillStanding.length === 0) {
    throw new InvalidForfeitError('SOLE_SURVIVOR', 'resolveForfeit: cannot forfeit — no other player remains to continue the match');
  }

  // Captured against the ORIGINAL gameState, before any of the branches
  // below mutate `state` — this answers "was it their turn the moment the
  // forfeit arrived," not "is it still their turn after cleanup below."
  const wasCurrentPlayer = getCurrentPlayer(gameState)?.id === playerId;

  let state = gameState;
  let transactions = [];
  let creditorId = getBankPlayer(state).id; // default branch (2): an ordinary voluntary bankruptcy, land reverts to the Bank

  if (state.phase === 'LIQUIDATION_REQUIRED' && state.pendingLiquidation?.debtorId === playerId) {
    // Branch (1).
    creditorId = state.pendingLiquidation.creditorId;
    state = { ...state, phase: 'POST_ACTIONS', pendingLiquidation: null };
  }

  const { gameState: afterBankruptcy, transactions: bankruptcyTx } = applyBankruptcy(state, boardTiles, playerId, creditorId, now);
  state = afterBankruptcy;
  transactions = [...transactions, ...bankruptcyTx];

  const elimination = checkElimination(state);
  if (elimination.isOver) {
    const ended = settleGameEnd(state, boardTiles, now, 'elimination');
    return { gameState: ended.gameState, transactions: [...transactions, ...ended.transactions] };
  }

  if (wasCurrentPlayer) {
    // advanceTurn() returns its own fresh (always-empty) transactions array
    // — merged here, not returned directly, or the bankruptcy transfer(s)
    // just accumulated above would silently vanish from the response.
    const advanced = advanceTurn({ ...state, lastRollWasDouble: false, currentDoublesStreak: 0 }, boardTiles, now);
    return { gameState: advanced.gameState, transactions: [...transactions, ...advanced.transactions] };
  }

  return { gameState: state, transactions };
}

/**
 * After a real bankruptcy applies, check whether it was the second-to-last
 * active player — GAME_DESIGN_SPEC.md §17's own words: "checked immediately
 * after every bankruptcy event, not just at turn boundaries." If so, the
 * match ends right here (elimination_win); otherwise play continues at
 * POST_ACTIONS.
 *
 * `bankruptPlayerId` and the turn force-advance below are 2026-08-25, found
 * by fuzzing. This function used to return POST_ACTIONS unconditionally, on
 * the stated reasoning that "the newly-bankrupt player's own turn still
 * needs to formally end — POST_ACTIONS -> END_TURN handles that the same way
 * it always does". That left an ELIMINATED player as the current player,
 * which is wrong on two counts: it contradicts the spectator rule (a
 * bankrupt player is out — they should not need to take an action for the
 * match to continue), and it means every elimination stalls the whole table
 * until either the loser politely clicks End Turn or POST_ACTIONS' own 30s
 * timeout fires — and someone who just lost is exactly the player most
 * likely to have closed the tab. resolveForfeit(), written later for the
 * mechanically-identical situation, already force-advances instead; this now
 * matches it rather than the two paths disagreeing.
 *
 * Conditional on the bankrupt player actually holding the turn: a player can
 * also be bankrupted while it is someone ELSE's turn (the multi-player charge
 * cards' own batch path), where the real current player's turn must be left
 * completely untouched — the same distinction resolveForfeit draws.
 */
function finishAfterBankruptcy(gameState, boardTiles, transactions, now, bankruptPlayerId) {
  const elimination = checkElimination(gameState);
  if (elimination.isOver) {
    const ended = settleGameEnd(gameState, boardTiles, now, 'elimination');
    return { gameState: ended.gameState, transactions: [...transactions, ...ended.transactions] };
  }

  const state = { ...gameState, phase: 'POST_ACTIONS' };

  if (bankruptPlayerId != null && getCurrentPlayer(state)?.id === bankruptPlayerId) {
    // No bonus turn survives an elimination — lastRollWasDouble is cleared
    // first, the same rule resolveForfeit and an escaped-jail roll follow.
    const advanced = advanceTurn({ ...state, lastRollWasDouble: false, currentDoublesStreak: 0 }, boardTiles, now);
    return { gameState: advanced.gameState, transactions: [...transactions, ...advanced.transactions] };
  }

  return { gameState: state, transactions };
}

/**
 * The only place gameState.status ever leaves 'in_progress' — reached from
 * either finishAfterBankruptcy() (elimination_win) or advanceTurn()
 * (final_phase win, once shouldEndFinalPhase() is true). Win Condition
 * design §J.5's ordering: void every pending trade first (no player should
 * be able to act on a stale trade after the game ends), resolve any still-
 * active auction next (reuses the exact settleAuction() path
 * AUCTION_TIMEOUT already uses — SETTLED or FAILED, whichever the real bid
 * history supports, not force-failed regardless of state), only then
 * compute final standings — so rankPlayers() never sees an asset that's
 * still "in flight".
 */
function settleGameEnd(gameState, boardTiles, now, endReason) {
  let state = { ...gameState, pendingTrades: [] };

  let transactions = [];
  if (state.pendingAuction) {
    // Same missing-`boardTiles` bug as applyBankruptcy's own settleAuction
    // call (both fixed 2026-09-01) — this one crashed the *end of the match*
    // whenever it finished with an auction still live, which is precisely
    // the case the docstring above says this branch exists to handle.
    const settled = settleAuction(state, boardTiles, state.pendingAuction, now);
    state = settled.gameState;
    transactions = settled.transactions;
  }

  const ranked = rankPlayers(state, boardTiles);
  const players = state.players.map((p) => {
    const entry = ranked.find((r) => r.playerId === p.id);
    return entry
      ? { ...p, finalRank: entry.rank, finalNetWorth: entry.netWorth, finalCash: entry.cash, finalPropertyValue: entry.propertyValue }
      : p;
  });

  return {
    gameState: { ...state, players, status: 'finished', phase: null, endedAt: now, endReason },
    transactions,
  };
}

/**
 * LIQUIDATION_REQUIRED's own SELL_HOUSE/MORTGAGE handling — the *same*
 * handleSellHouse()/handleMortgage() functions POST_ACTIONS already uses
 * (called by transitionTurn's own LIQUIDATION_REQUIRED case below), reused
 * verbatim rather than duplicated. Those functions always return
 * phase: 'POST_ACTIONS' unconditionally — correct when called from
 * POST_ACTIONS, wrong here, so this wrapper re-checks the still-present
 * pendingLiquidation against the debtor's new post-sale balance: covered
 * -> actually settle the original debt now and clear pendingLiquidation;
 * not yet covered -> overrule the inner phase back to LIQUIDATION_REQUIRED
 * so the debtor can keep selling/mortgaging.
 *
 * pendingLiquidation.onSettled (finding #28, 2026-08-19) generalizes what
 * "settled" actually leads to — POST_ACTIONS (the original rent/tax case,
 * the default when the field is absent) isn't right for a jail-fine debt,
 * which instead needs the debtor released from jail (inJail/jailTurns,
 * untouched until this exact moment — see payJailFineOrLiquidate()'s own
 * header for why) and either sent to ROLLING (a voluntary PAY_JAIL_FINE)
 * or straight through advanceTurn (the forced 3rd-attempt case — no bonus
 * turn, same as that case's always-solvent behavior already gave it).
 * @param {{ small?: object[], large?: object[] }} boardTiles - only needed for the RELEASE_AND_ADVANCE branch's advanceTurn() call
 * @param {string} now - only needed for the RELEASE_AND_ADVANCE branch's advanceTurn() call
 */
function resolveLiquidationStep(gameState, transactions, boardTiles, now) {
  const { pendingLiquidation } = gameState;
  const debtor = gameState.players.find((p) => p.id === pendingLiquidation.debtorId);

  if (debtor.currentBalance < pendingLiquidation.amount) {
    return { gameState: { ...gameState, phase: 'LIQUIDATION_REQUIRED' }, transactions };
  }

  const { gameState: afterPaymentRaw, transaction } = applyTransaction(gameState, {
    fromPlayerId: pendingLiquidation.debtorId,
    toPlayerId: pendingLiquidation.creditorId,
    amount: pendingLiquidation.amount,
    transactionType: pendingLiquidation.transactionType,
  });
  const afterPayment = feedFreeParkingJackpot(afterPaymentRaw, pendingLiquidation.transactionType, pendingLiquidation.amount);
  const settledTransactions = [...transactions, transaction];

  const onSettled = pendingLiquidation.onSettled ?? 'POST_ACTIONS';
  if (onSettled === 'POST_ACTIONS') {
    return {
      gameState: { ...afterPayment, phase: 'POST_ACTIONS', pendingLiquidation: null },
      transactions: settledTransactions,
    };
  }

  const debtorAfterPayment = afterPayment.players.find((p) => p.id === pendingLiquidation.debtorId);
  const stateAfterRelease = replacePlayer(
    { ...afterPayment, pendingLiquidation: null },
    { ...debtorAfterPayment, inJail: false, jailTurns: 0 }
  );

  if (onSettled === 'RELEASE_TO_ROLLING') {
    return { gameState: { ...stateAfterRelease, phase: stateAfterRelease.ruleset === 'ASYMMETRIC' ? 'PLAYING_CARD' : 'ROLLING' }, transactions: settledTransactions };
  }

  // The forced 3rd-attempt exit, settled late (the debtor had to liquidate
  // before they could pay). Moves by the same failed roll a solvent player
  // moves by — see payJailFineOrLiquidate's own note on why moveRoll is
  // carried on pendingLiquidation. Falls through to the plain advance if the
  // roll is somehow absent (a pendingLiquidation persisted before 2026-09-01
  // has no such field), so an in-flight match across the deploy still
  // resolves instead of throwing.
  if (onSettled === 'RELEASE_AND_MOVE' && pendingLiquidation.moveRoll) {
    const moved = moveAndResolve(stateAfterRelease, boardTiles, pendingLiquidation.debtorId, pendingLiquidation.moveRoll, now);
    return {
      gameState: { ...moved.gameState, lastRollWasDouble: false, currentDoublesStreak: 0 },
      transactions: [...settledTransactions, ...moved.transactions],
    };
  }

  // RELEASE_AND_ADVANCE
  const advanced = advanceTurn({ ...stateAfterRelease, lastRollWasDouble: false, currentDoublesStreak: 0 }, boardTiles, now);
  return { gameState: advanced.gameState, transactions: [...settledTransactions, ...advanced.transactions] };
}

/**
 * LANDING's fan-out (GAME_STATE_MACHINE.md §8) — resolveTile.js decides
 * which branch, this function carries out what that branch means.
 * @param {number} diceTotal - needed for PAYING_RENT's utility formula
 * @param {string} now - threaded through to settleDebt() for a real bankruptAt/endedAt if this debt turns out to be unpayable (Win Condition design, 2026-08-19) — moveAndResolve's own header explains why this wasn't threaded before
 */
function resolveLanding(gameState, boardTiles, playerId, diceTotal, now) {
  const player = gameState.players.find((p) => p.id === playerId);
  const tile = findTileAt(boardTiles, player.currentPosition);
  const property = gameState.properties.find((p) => p.boardTileId === tile.id) ?? null;

  const nextPhase = resolveTile(tile, property, playerId);

  switch (nextPhase) {
    case 'AWAITING_PURCHASE':
    case 'AWAITING_UPGRADE':
      return { gameState: { ...gameState, phase: nextPhase }, transactions: [] };

    case 'POST_ACTIONS': {
      // Phase 14 (2026-08-19): Free Parking jackpot payout —
      // GAME_DESIGN_SPEC.md §14's tax-jackpot variant, now confirmed
      // adopted. tileType-matched, deliberately NOT a fixed board
      // position: this project's board is adaptive
      // (ADAPTIVE_BOARD_DESIGN.md, 36/44 tiles), so Free Parking sits at a
      // different position on Small (18) vs. Large (22) — a hardcoded
      // index would be wrong on both real boards.
      if (tile.tileType === 'free_parking' && gameState.freeParkingJackpot > 0) {
        const bank = getBankPlayer(gameState);
        const { gameState: afterPayout, transaction } = applyTransaction(gameState, {
          fromPlayerId: bank.id,
          toPlayerId: playerId,
          amount: gameState.freeParkingJackpot,
          transactionType: 'free_parking_jackpot',
        });
        return {
          gameState: { ...afterPayout, freeParkingJackpot: 0, phase: 'POST_ACTIONS' },
          transactions: [transaction],
        };
      }
      return { gameState: { ...gameState, phase: nextPhase }, transactions: [] };
    }

    case 'DRAWING_CARD':
      return resolveDrawingCard(gameState, boardTiles, playerId, now);

    case 'PAYING_RENT': {
      const owner = gameState.players.find((p) => p.id === property.ownerId);
      const payer = gameState.players.find((p) => p.id === playerId);
      const baseRent = calculateFinalRent(
        gameState,
        payer.id,
        owner.id,
        tile,
        property,
        holdingsFor(gameState, boardTiles, owner.id),
        tile.groupId ? boardTiles.filter((t) => t.groupId === tile.groupId) : undefined,
        diceTotal,
        boardTiles
      );
      // K01/K02 (2026-08-22 deck) — GameState.rentModifierPercent's own
      // global/round-scoped modifier, layered on here rather than inside
      // calculateRent.js itself (that function stays pure/untouched).
      const afterGlobalModifier = Math.round(baseRent * (1 + gameState.rentModifierPercent / 100));
      // C12-C (same deck) — the *payer's* own one-shot discount (a
      // completely different player/field than rentModifierPercent's
      // owner-agnostic global one) — consumed right here, the moment it's
      // baked into this specific rent event's own rentAmount, which now
      // settles immediately (Rent Risk Choice, REVISED 2026-08-25): the
      // discounted figure is what the payer actually pays AND what
      // pendingRentGamble.amount later gambles against the Bank, so there's
      // nothing left for a later step to apply the discount to.
      const discount = payer.nextRentDiscount;
      const discountAmount = discount ? Math.min(Math.round((afterGlobalModifier * discount.percent) / 100), discount.max) : 0;
      const rentAmount = Math.max(0, afterGlobalModifier - discountAmount);
      const stateWithDiscountConsumed = discount ? replacePlayer(gameState, { ...payer, nextRentDiscount: null }) : gameState;

      // ASYMMETRIC landing riders (synergyEngine.landingEffect): ECONOMY's
      // 2-card draw and DENIAL's hand reveal. Applied BEFORE the rent settles
      // so they survive even when the rent turns out to be $0 (the early
      // return just below) or bankrupts the payer — the owner earned the
      // rider by being landed on, independently of whether money changes
      // hands. Returns its input untouched for CLASSIC and for any tile whose
      // owner has not reached tier 1.
      const rider = gameState.ruleset === 'ASYMMETRIC'
        ? landingEffect(stateWithDiscountConsumed, boardTiles, tile, playerId)
        : null;
      const stateAfterDiscountConsumed = rider
        ? applyCardEffect(stateWithDiscountConsumed, rider, playerId)
        : stateWithDiscountConsumed;

      // Rent Risk Choice, REVISED 2026-08-25 — real user correction (see
      // BOARD_SPECIFICATION.md's own entry for the full before/after and the
      // economics of where the Gamble's winning half comes from). Rent
      // settles immediately again, exactly like every other debt in this
      // game (settleDebt, same as PAYING_TAX/jail fines) — nothing blocks on
      // an owner decision any more. `pendingHostileBuyoutPropertyId` goes
      // back to being set unconditionally right after landing (its own
      // pre-Rent-Risk-Choice behavior), rather than deferred until a choice
      // resolves, since there is no choice left to wait on.
      //
      // A genuine $0 rentAmount (C12's own rent discount can fully absorb a
      // small base rent — `Math.max(0, ...)` above) is a real, reachable
      // case, not a defensive guard against something impossible:
      // applyTransaction() itself rejects a non-positive amount, so
      // settleDebt() must never be called with one — the old Rent Risk
      // Choice code had the identical check for its own zero-amount case
      // (a lost Gamble), carried forward here for the STANDARD-only path
      // that replaces it.
      if (rentAmount === 0) {
        return {
          gameState: { ...stateAfterDiscountConsumed, phase: 'POST_ACTIONS', pendingHostileBuyoutPropertyId: property.id },
          transactions: [],
        };
      }

      const settled = settleDebt(
        stateAfterDiscountConsumed,
        boardTiles,
        { debtorId: playerId, creditorId: owner.id, amount: rentAmount, transactionType: 'rent' },
        now
      );
      // The optional Gamble side-offer (GAMBLE_RENT, handleGambleRent below)
      // is deliberately only ever set for a clean, immediate, in-full CASH
      // payment: settleDebt's `canPayInCash` branch pays the FULL rentAmount
      // in one real `rent` transaction and stays at PAYING_RENT's own phase
      // outcome (POST_ACTIONS) rather than diverting to LIQUIDATION_REQUIRED
      // or a real bankruptcy — checked here via the transaction's own
      // presence/type rather than re-deriving solvency a second time.
      const paidInCash = settled.transactions.some(
        (t) => t.transactionType === 'rent' && t.fromGamePlayerId === playerId && t.toGamePlayerId === owner.id
      );
      return {
        gameState: {
          ...settled.gameState,
          pendingHostileBuyoutPropertyId: property.id,
          pendingRentGamble: paidInCash
            ? { propertyId: property.id, ownerId: owner.id, payerId: playerId, amount: rentAmount }
            : settled.gameState.pendingRentGamble,
        },
        transactions: settled.transactions,
      };
    }

    case 'PAYING_TAX': {
      const bank = getBankPlayer(gameState);
      return settleDebt(
        gameState,
        boardTiles,
        { debtorId: playerId, creditorId: bank.id, amount: tile.taxAmount, transactionType: 'tax' },
        now
      );
    }

    default:
      // Exhaustiveness guard, same convention as resolveTile.js/calculateRent.js.
      throw new Error(`resolveLanding: unhandled phase '${nextPhase}' from resolveTile`);
  }
}

/**
 * DRAWING_CARD (GAME_DESIGN_SPEC.md §13's confirmed phase) — now wired to
 * the "Decision & Moment System" (domain/eventDictionary.js,
 * engine/eventResolver.js), additive alongside the still-untouched, still-
 * unwired domain/eventCard.js flat-effect model (see PROJECT_STATUS.md and
 * the file header above). A single shared eventDeck is drawn from
 * regardless of whether the landed tile was 'chance' or 'fortune' — this
 * dictionary has no deck-membership concept (unlike eventCard.js's
 * EVENT_CARD_DECKS split), a known simplification, not a considered design
 * decision. Deck exhaustion is not handled — drawCard() throws on an empty
 * deck, and no recycle/reshuffle mechanism exists yet.
 *
 * lastDrawnEventCardId (wired 2026-08-21, alongside the new
 * GET /api/v1/event-cards endpoint) is set on *both* branches below, unlike
 * pendingEventCardId which is CHOICE-only — closes a real frontend gap
 * (EventCardModal.jsx's own header): an INSTANT card resolves synchronously
 * within this same call, so without this field GameState never recorded
 * which card had actually been drawn, only the resulting money movement.
 */
// card.eligibility (2026-08-22 deck, e.g. C08's own "chỉ dùng nếu Cash <
// $300") — see domain/eventDictionary.js's own doc comment on the field for
// the full reasoning. Only `field: 'currentBalance'` exists today.
/**
 * The properties C08 "Bảo Vệ Tài Sản" may target: owned by this player and
 * still unimproved. Improved ones are excluded because they are ALREADY
 * permanently immune to a hostile buyout (handleHostileBuyout's own
 * HOUSE_PROTECTED rule), so protecting one would be a guaranteed no-op —
 * the card exists precisely to cover the window before a build happens.
 * Mortgaged properties ARE eligible: mortgage status has never affected
 * hostile-buyout eligibility (Phase 14's own documented decision), so a
 * mortgaged property is just as stealable and just as worth protecting.
 */
function protectablePropertiesFor(gameState, playerId) {
  return gameState.properties.filter((p) => p.ownerId === playerId && p.upgradeLevel === MIN_UPGRADE_LEVEL);
}

/**
 * Is a granted C08 protection still in force? Derived, never stored as a
 * deadline — `roundNumber > grantedAtRound` means the owner's own next turn
 * has begun, which is the card's stated expiry. Same round-arithmetic
 * equivalence the RECENTLY_ACQUIRED build gate relies on, and for the same
 * reason: roundNumber advances once per full cycle, and the card can only be
 * drawn on the owner's own turn.
 */
function protectionIsLive(gameState, propertyId) {
  const p = gameState.propertyProtection;
  if (p == null || p.propertyId !== propertyId) return false;
  if (gameState.roundNumber > p.grantedAtRound) return false;

  // Ownership must STILL match the player the protection was granted to
  // (2026-08-25, caught by fuzzing this card the day it was written).
  // Trades are deliberately phase-independent, so the protected property can
  // change hands while the protection is still live — without this check the
  // shield would travel with the property and hand the new owner a defence
  // they never earned. Verified from live state rather than cleaned up at
  // every transfer site, so it is correct by construction no matter which
  // path moves a property in future.
  const property = gameState.properties.find((x) => x.id === propertyId);
  return property?.ownerId === p.ownerId;
}

function cardEligible(card, player, gameState) {
  if (!card.eligibility) return true;

  // C08 "Bảo Vệ Tài Sản" (2026-08-25) — the first eligibility gate that asks
  // about the BOARD rather than a numeric field on the player. Without it, a
  // player owning nothing protectable would enter AWAITING_EVENT_CHOICE with
  // no legal choice available and hang their own turn until the phase timer
  // fired: exactly the deadlock C11's own affordability gate closed.
  if (card.eligibility.kind === 'OWNS_PROTECTABLE_PROPERTY') {
    return protectablePropertiesFor(gameState, player.id).length > 0;
  }

  const { field, op, value } = card.eligibility;
  const actual = player[field];
  if (op === 'lt') return actual < value;
  // 'gte' added 2026-08-23 alongside C11's own new affordability gate — see
  // that card's comment in domain/eventDictionary.js for the deadlock it
  // closes.
  if (op === 'gte') return actual >= value;
  throw new Error(`cardEligible: unhandled eligibility op '${op}'`);
}

// C01/C02 (2026-08-22, phase 4) — the shared movement path for event cards
// that relocate the player to a computed position and then resolve
// whatever's there, the same way a real dice-driven move does. Reuses
// engine/movement.js's own movePlayer() (PASS_GO credited normally — "không
// tung xúc xắc" in C01's own text is about skipping the *roll*, not its
// usual economic side effects) and resolveLanding() (so the destination's
// own real phase — AWAITING_PURCHASE, PAYING_RENT, another DRAWING_CARD,
// plain POST_ACTIONS — is whatever it would genuinely be for a normal
// landing there, not hardcoded).
//
// utilityDiceFallback: if the computed destination happens to be a utility
// tile, calculateRent.js's own formula needs a real dice value this card
// draw has no natural source for. Uses 7 (the statistical average/most
// common 2-dice total) rather than threading fresh server-side randomness
// through resolveDrawingCard/handleEventChoice and their own callers all
// the way up to socketServer.js for what would be a rare "a movement card's
// destination happens to be a utility" edge case — flagged directly as a
// deliberate simplification, not a real roll.
const UTILITY_DICE_FALLBACK = 7;
function moveByStepsAndResolve(gameState, boardTiles, playerId, steps, now) {
  const player = gameState.players.find((p) => p.id === playerId);
  const { newPosition, passedGo } = movePlayer(player.currentPosition, steps, boardTiles.length);

  let state = replacePlayer(gameState, { ...player, currentPosition: newPosition });
  const transactions = [];

  if (passedGo) {
    const bank = getBankPlayer(state);
    const { gameState: afterSalary, transaction } = applyTransaction(state, {
      fromPlayerId: bank.id,
      toPlayerId: playerId,
      amount: PASS_GO_SALARY,
      transactionType: 'pass_go_salary',
    });
    state = afterSalary;
    transactions.push(transaction);
  }

  const landing = resolveLanding(state, boardTiles, playerId, UTILITY_DICE_FALLBACK, now);
  return { gameState: landing.gameState, transactions: [...transactions, ...landing.transactions] };
}

// C02's own dynamic target: the nearest BUYABLE tile type (property/
// transport/utility — resolveTile.js's own BUYABLE_TILE_TYPES, reused
// rather than redeclared) ahead of the player's current position that's
// still unowned — scanned forward up to one full lap, matching the card's
// own "nếu không có... trong một vòng → không có hiệu ứng". Returns the
// forward step count (moveByStepsAndResolve's own `steps` param), or null.
function findNearestUnownedAhead(gameState, boardTiles, fromPosition) {
  const total = boardTiles.length;
  for (let steps = 1; steps <= total; steps++) {
    const position = (fromPosition + steps) % total;
    const tile = boardTiles.find((t) => t.position === position);
    if (!BUYABLE_TILE_TYPES.includes(tile.tileType)) continue;
    const property = gameState.properties.find((p) => p.boardTileId === tile.id);
    if (property && property.ownerId === null) return steps;
  }
  return null;
}

function resolveDrawingCard(gameState, boardTiles, playerId, now) {
  const { drawnCardId, newDeck } = drawCard(gameState.eventDeck);
  const card = EVENT_CARDS[drawnCardId];
  const deckState = {
    ...gameState,
    eventDeck: newDeck,
    lastDrawnEventCardId: drawnCardId,
    // Real "new draw happened" signal — see its own JSDoc in domain/gameState.js
    // for why lastDrawnEventCardId/stateVersion alone weren't safe for the
    // frontend to key a dismiss/replay decision off of.
    //
    // `?? 0` is load-bearing, not defensive noise: a match already in
    // progress when this field shipped is restored via
    // gameRepository.js's loadGameStateFromSupabase(), which returns
    // `snapshot.state`'s raw JSONB blob directly and deliberately does NOT
    // run it back through createGameState() — so its `?? 0` default never
    // applies to a pre-existing game, and a plain `+ 1` here would yield
    // `undefined + 1 === NaN`. NaN then stays NaN across every later draw,
    // making every drawKey identical on the frontend and breaking the card
    // in the opposite direction (shown once, then never again). Any future
    // counter field added to GameState needs the same treatment.
    lastDrawnEventCardSeq: (gameState.lastDrawnEventCardSeq ?? 0) + 1,
  };
  const player = deckState.players.find((p) => p.id === playerId);

  // An ineligible draw is a real, revealed no-op — see cardEligible's own
  // comment and domain/eventDictionary.js's `eligibility` doc for why this
  // isn't silently swallowed: lastDrawnEventCardId (set above) is what the
  // reveal-to-everyone UI keys off, so every player still sees which card
  // was drawn, just with no effect and (for a CHOICE card) no decision to
  // make — there was never a real choice to offer someone who didn't
  // qualify for the card at all.
  if (!cardEligible(card, player, deckState)) {
    return { gameState: { ...deckState, phase: 'POST_ACTIONS' }, transactions: [] };
  }

  // Card Inventory System (2026-08-27) — keepable cards go straight into
  // the player's hand, never resolving immediately. They are played out-of-turn
  // via USE_INVENTORY_CARD. The frontend toast still reveals the draw via
  // lastDrawnEventCardId, but no effects fire.
  if (card.keepable) {
    const updatedPlayer = { ...player, inventory: [...(player.inventory || []), drawnCardId] };
    const afterInventory = replacePlayer(deckState, updatedPlayer);
    return { gameState: { ...afterInventory, phase: 'POST_ACTIONS' }, transactions: [] };
  }

  if (card.type === 'INSTANT') {
    const intents = evaluateEvent(card);
    // MOVE_TO_NEAREST_UNOWNED_PROPERTY (C02) changes *where the turn goes
    // next*, not just player/GameState fields applyIntents' own simple
    // "batch, then always POST_ACTIONS" shape can express — intercepted
    // here, before reaching it. Deliberately checked ahead of the generic
    // applyIntents call below, same "special-case what needs re-resolving,
    // fall through to the simple path otherwise" structure this file's own
    // POST_ACTIONS/free_parking branch already established.
    const moveIntent = intents.find((i) => i.action === 'MOVE_TO_NEAREST_UNOWNED_PROPERTY');
    if (moveIntent) {
      const steps = findNearestUnownedAhead(deckState, boardTiles, player.currentPosition);
      if (steps === null) {
        return { gameState: { ...deckState, phase: 'POST_ACTIONS' }, transactions: [] };
      }
      return moveByStepsAndResolve(deckState, boardTiles, playerId, steps, now);
    }
    const { gameState: afterIntents, transactions, pendingDebts } = applyIntents(deckState, boardTiles, intents, 'event_card', playerId);
    // POST_ACTIONS first, then settle: settlePendingDebts reads `phase` to
    // decide whether an earlier debt already halted the turn, so it has to
    // start from the phase this draw would otherwise have produced.
    const settled = { ...afterIntents, phase: 'POST_ACTIONS' };
    return settlePendingDebts(settled, boardTiles, transactions, pendingDebts, now);
  }

  // CHOICE — evaluateEvent()'s REQUIRE_CHOICE transition intent is for a
  // future broadcast/UI layer to read (via pendingEventCardId + the
  // dictionary), not something this machine stores on GameState itself;
  // still called here per this pass's own scope, even though its return
  // value isn't retained.
  evaluateEvent(card);
  return {
    gameState: { ...deckState, phase: 'AWAITING_EVENT_CHOICE', pendingEventCardId: drawnCardId },
    transactions: [],
  };
}

/**
 * Shared movement path for both a normal ROLL_DICE and a successful
 * (doubles) jail-exit roll — GAME_DESIGN_SPEC.md §15: rolling doubles to
 * leave jail uses that same roll to move, it isn't followed by a second,
 * separate roll. PASS_GO payout happens here, before landing resolution.
 *
 * rollResult.sentToJail (dice.js's own 3rd-consecutive-double signal) is
 * checked first and short-circuits straight to jail, no movement/landing
 * at all — GAME_DESIGN_SPEC.md §15's entry trigger. In practice this can
 * only fire from the ROLLING-phase caller: a jail-escape attempt always
 * starts its own doublesStreak at 0, so a single roll can never reach the
 * 3rd-consecutive-double threshold there.
 *
 * @param {import('../domain/gameState.js').GameState} gameState
 * @param {import('../domain/tile.js').Tile[]} boardTiles
 * @param {object} action
 * @param {string} [now]
 */
/**
 * Applies one ECONOMY/DENIAL rider (synergyEngine's CARD_REROLL /
 * REVEAL_NEXT_CARD / OWNER_DRAWS / REVEAL_HAND) to a game state.
 *
 * RANDOMNESS NOTE — this calls drawMovementHand(), which reaches for
 * Math.random() directly, so this state machine is not pure across this path.
 * That is deliberate and pre-existing rather than new: startTurn() has drawn
 * the same way since the mode was sketched, and making only this call site
 * deterministic would leave the machine impure anyway while splitting one
 * mechanic across two conventions. Nothing here is exploitable — a client
 * cannot influence Math.random, and idempotency.js caches results rather than
 * re-executing, so a retry replays the same draw. Migrating BOTH call sites
 * to an injected randomSource (the serverGeneratedFields convention every
 * dice/probability path already uses) is real debt and belongs in its own
 * change, where the fuzz harness can be updated with it.
 */
function applyCardEffect(gameState, effect, victimId) {
  const victim = gameState.players.find((p) => p.id === victimId);
  const owner = gameState.players.find((p) => p.id === effect.ownerId);
  if (!victim || !owner) return gameState;

  if (effect.type === 'CARD_REROLL') {
    // Size-preserving by construction: discard exactly one, draw exactly one.
    // An empty hand is a no-op rather than an error — PLAYING_CARD's own
    // invariant guarantees a non-empty hand, and a rider firing mid-movement
    // is the wrong place to enforce someone else's invariant.
    const hand = victim.movementHand ?? [];
    if (hand.length === 0) return gameState;
    const discardIndex = Math.floor(Math.random() * hand.length);
    const rerolled = [...hand.slice(0, discardIndex), ...hand.slice(discardIndex + 1), ...drawMovementHand(1)];
    let next = replacePlayer(gameState, { ...victim, movementHand: rerolled });

    // The owner's half. HAND_CAP, not HAND_SIZE — the whole point of ECONOMY
    // is accumulating options past what a turn hands you.
    const ownerHand = owner.movementHand ?? [];
    if (ownerHand.length < HAND_CAP) {
      const refreshedOwner = next.players.find((p) => p.id === owner.id);
      next = replacePlayer(next, { ...refreshedOwner, movementHand: [...ownerHand, ...drawMovementHand(1)] });
    }
    return next;
  }

  if (effect.type === 'OWNER_DRAWS') {
    const ownerHand = owner.movementHand ?? [];
    const room = Math.max(0, HAND_CAP - ownerHand.length);
    const drawCount = Math.min(effect.amount, room);
    if (drawCount === 0) return gameState;
    return replacePlayer(gameState, { ...owner, movementHand: [...ownerHand, ...drawMovementHand(drawCount)] });
  }

  // REVEAL_NEXT_CARD / REVEAL_HAND — recorded, but see synergyEngine's own
  // warning: socketServer broadcasts every hand to every player already, so
  // these are inert until per-recipient redaction exists.
  if (effect.type === 'REVEAL_NEXT_CARD' || effect.type === 'REVEAL_HAND') {
    const existing = (victim.handRevealedTo ?? []).filter((r) => r.viewerId !== effect.ownerId);
    const untilRound = gameState.roundNumber + (effect.rounds ?? 1);
    return replacePlayer(gameState, {
      ...victim,
      handRevealedTo: [...existing, { viewerId: effect.ownerId, untilRound, scope: effect.type === 'REVEAL_HAND' ? 'FULL' : 'NEXT_CARD' }],
    });
  }

  return gameState;
}

function handlePlayMovementCard(gameState, boardTiles, action, now) {
  const { cardId } = action.payload;
  const player = getCurrentPlayer(gameState);

  if (!player.movementHand || !player.movementHand.includes(cardId)) {
    throw new Error('Bạn không có thẻ này trên tay!');
  }

  const cardDef = MOVEMENT_CARDS[cardId];
  if (!cardDef) {
    throw new Error(`Thẻ di chuyển không tồn tại: ${cardId}`);
  }

  // Lọc thẻ khỏi tay
  const newHand = [...player.movementHand];
  newHand.splice(newHand.indexOf(cardId), 1);
  
  // Trừ tiền nếu thẻ yêu cầu (VD: SPRINT_6 tốn 50)
  let transactions = [];
  let stateAfterCost = replacePlayer(gameState, { ...player, movementHand: newHand });

  if (cardDef.cost > 0) {
    const bank = getBankPlayer(stateAfterCost);
    const { gameState: statePaid, transaction } = applyTransaction(stateAfterCost, {
      fromPlayerId: player.id,
      toPlayerId: bank.id,
      amount: cardDef.cost,
      transactionType: 'movement_card_cost',
    });
    stateAfterCost = statePaid;
    transactions.push(transaction);
  }

  const boardTileCount = boardTiles.length;
  // A `random` card's step count is server-generated and arrives on the
  // payload as `cardRoll` — socketServer.js's serverGeneratedFields() for a
  // live click, timers.js's buildDefaultAction() for the timeout path. Same
  // rule ROLL_DICE/GAMBLE_RENT already follow: this state machine is pure and
  // is never allowed to source its own randomness (dice.js's file header).
  // A client-supplied cardRoll can't be trusted and is always overwritten at
  // the socket layer before it reaches here.
  const steps = cardDef.random ? action.payload?.cardRoll : cardDef.steps;
  if (!Number.isInteger(steps) || steps < 1) {
    throw new Error(
      `handlePlayMovementCard: card '${cardId}' resolved to an invalid step count (${steps})` +
        (cardDef.random ? ' — a random card needs a server-generated payload.cardRoll' : '')
    );
  }

  const { newPosition, passedGo, stoppedByTrap, tolls, cardEffects } = resolveMovement(
    stateAfterCost,
    player.id,
    steps,
    cardDef.direction,
    boardTileCount,
    { boardTiles, ignorePassThrough: cardDef.ignorePassThrough === true }
  );

  // Pass-through tolls settle BEFORE the move lands, in crossing order — the
  // player really did drive past those tiles on the way here. Settled through
  // applyTransaction rather than by adjusting balances directly so each one
  // writes a real ledger row and stays inside the "balance never goes
  // negative" invariant every other payment path already respects.
  //
  // Deliberately NOT using settleDebt: a toll that the player cannot afford
  // should not open a liquidation phase in the middle of movement resolution.
  // It is capped at what they can actually pay, and the shortfall is dropped.
  // That is the lenient reading, chosen because the alternative — a
  // bankruptcy triggered from inside a movement loop, before the player has
  // even landed — has no defined place in the phase machine yet.
  for (const toll of tolls) {
    const payer = stateAfterCost.players.find((p) => p.id === player.id);
    const payable = Math.min(toll.amount, payer.currentBalance);
    if (payable <= 0) break;
    const { gameState: statePaid, transaction } = applyTransaction(stateAfterCost, {
      fromPlayerId: player.id,
      toPlayerId: toll.ownerId,
      amount: payable,
      transactionType: 'pass_through_toll',
    });
    stateAfterCost = statePaid;
    transactions.push(transaction);
  }

  // ECONOMY / DENIAL riders, applied in crossing order. Kept out of
  // resolveMovement (which stays pure) for the same reason the tolls above
  // are: they mutate players, and every mutation belongs on this side.
  for (const effect of cardEffects) {
    stateAfterCost = applyCardEffect(stateAfterCost, effect, player.id);
  }

  // Giống như khúc dưới của moveAndResolve
  let finalPlayer = stateAfterCost.players.find((p) => p.id === player.id);
  finalPlayer = { ...finalPlayer, currentPosition: newPosition };

  let stateAfterMove = replacePlayer(stateAfterCost, finalPlayer);

  if (passedGo) {
    const bank = getBankPlayer(stateAfterMove);
    const { gameState: stateWithGo, transaction: goTx } = applyTransaction(stateAfterMove, {
      fromPlayerId: bank.id,
      toPlayerId: player.id,
      amount: PASS_GO_SALARY,
      transactionType: 'pass_go',
    });
    stateAfterMove = stateWithGo;
    transactions.push(goTx);
  }

  const landing = resolveLanding(stateAfterMove, boardTiles, finalPlayer.id, now);
  return {
    gameState: landing.gameState,
    transactions: [...transactions, ...landing.transactions],
  };
}

/**
 * `now` (Win Condition design, 2026-08-19) is newly threaded all the way
 * down from transitionTurn's own `now` param, through here, to
 * resolveLanding/settleDebt — landing on a rent/tax tile can now end the
 * match outright (bankruptcy -> elimination win), which needs a real
 * timestamp for bankruptAt/endedAt. Not needed anywhere else in this
 * function itself, purely a pass-through.
 */
function moveAndResolve(gameState, boardTiles, playerId, rollResult, now) {
  const player = gameState.players.find((p) => p.id === playerId);

  if (rollResult.sentToJail) {
    // Never grants a bonus roll, even though the triggering roll was
    // itself a double — going to jail is the penalty for that 3rd
    // double, not a reward. lastRollWasDouble/currentDoublesStreak are
    // explicitly reset here so advanceTurn correctly moves on to the next
    // player, and the jailed player starts clean next time.
    const jailTile = boardTiles.find((t) => t.tileType === 'jail');
    const jailed = sendToJail(player, jailTile.position);
    const jailedState = {
      ...replacePlayer(gameState, jailed),
      lastRollWasDouble: false,
      currentDoublesStreak: 0,
      // Now set (2026-08-25) — this is a real roll and the table should see
      // it. It survives the immediate advanceTurn() below because
      // startTurn() no longer clears lastRoll; see its comment.
      lastRoll: rollToDisplay(rollResult),
      lastRollSeq: (gameState.lastRollSeq ?? 0) + 1,
    };
    // (Historical note) lastRoll used to be deliberately left unset here,
    // because advanceTurn() below cascades straight into the next player's
    // startTurn() within this same transition, which reset it to null before
    // any broadcast could show it. startTurn() no longer clears it, so the
    // 3rd-consecutive-double roll is finally visible like every other.
    return advanceTurn(jailedState, boardTiles, now);
  }

  const { newPosition, passedGo } = movePlayer(player.currentPosition, rollResult.total, boardTiles.length);

  // Landing on Go To Jail via normal movement (2026-08-22 fix — a real,
  // previously-shipped bug, not new behavior): resolveTile.js's own dispatch
  // comment already flagged "relocating the player onto the jail tile is a
  // separate concern from this dispatcher", but nothing ever actually was
  // that separate concern — landing here has only ever left the player
  // standing at the Go To Jail tile's own position with inJail still false,
  // free to keep playing normally (confirmed: the pre-existing test suite's
  // own fixture asserted exactly that position as "correct"). Same
  // immediate-jail treatment as the sentToJail branch above (GAME_DESIGN_SPEC.md
  // §15's own "landing on go_to_jail" entry trigger — jail.js's sendToJail
  // docstring already listed it, never wired here until now): relocate,
  // reset streak flags, end the turn immediately, no lingering POST_ACTIONS
  // window. `passedGo` is deliberately not checked here — Go To Jail sits
  // far enough from GO on both approved board sizes (position 27 of 36, or
  // 33 of 44) that reaching it while also having wrapped past position 0 in
  // the same roll is arithmetically impossible with a 2-6-sided-dice total
  // (max 12) on either board, not just assumed safe to ignore.
  const landedTile = boardTiles.find((t) => t.position === newPosition);
  if (landedTile.tileType === 'go_to_jail') {
    const jailTile = boardTiles.find((t) => t.tileType === 'jail');
    const jailed = sendToJail(player, jailTile.position);
    const jailedState = {
      ...replacePlayer(gameState, jailed),
      lastRollWasDouble: false,
      currentDoublesStreak: 0,
      // Same 2026-08-25 change as the sentToJail branch above — the roll
      // that carried the player onto Go To Jail is still a real roll the
      // table should see, and it now survives the turn advance.
      lastRoll: rollToDisplay(rollResult),
      lastRollSeq: (gameState.lastRollSeq ?? 0) + 1,
    };
    return advanceTurn(jailedState, boardTiles, now);
  }

  let state = replacePlayer(gameState, { ...player, currentPosition: newPosition });
  const transactions = [];

  if (passedGo) {
    const bank = getBankPlayer(state);
    const { gameState: afterSalary, transaction } = applyTransaction(state, {
      fromPlayerId: bank.id,
      toPlayerId: playerId,
      amount: PASS_GO_SALARY,
      transactionType: 'pass_go_salary',
    });
    state = afterSalary;
    transactions.push(transaction);
  }

  const landing = resolveLanding(state, boardTiles, playerId, rollResult.total, now);
  return {
    gameState: {
      ...landing.gameState,
      lastRollWasDouble: rollResult.isDouble,
      lastRoll: rollToDisplay(rollResult),
      // Finding #37 — the real "a new roll happened" signal DiceRoll.jsx
      // keys its animation off. `?? 0` for the same reason
      // lastDrawnEventCardSeq needs it: a match already in progress when
      // this field shipped is restored straight from snapshot JSONB,
      // bypassing createGameState()'s own default, so a plain `+ 1` would
      // be `undefined + 1 === NaN` and stick there forever.
      lastRollSeq: (gameState.lastRollSeq ?? 0) + 1,
      currentDoublesStreak: rollResult.doublesStreak,
    },
    transactions: [...transactions, ...landing.transactions],
  };
}

/** Trims dice.js's rollDice() output down to the plain display fact GameState.lastRoll needs — die1/die2/total/isDouble, not doublesStreak/sentToJail (both already tracked elsewhere on GameState, would be redundant here). */
function rollToDisplay({ die1, die2, total, isDouble }) {
  return { die1, die2, total, isDouble };
}

/**
 * TURN_START (GAME_STATE_MACHINE.md §8): system, jail check only. Used
 * both for the START_TURN action (the match's very first turn) and,
 * cascaded internally, for every subsequent player's turn after END_TURN
 * — it has no decision point of its own either way.
 */
function startTurn(gameState) {
  let player = getCurrentPlayer(gameState);
  let state = gameState;

  // Tự động rút thêm thẻ nếu là Đột Phá và tay bài chưa đủ 2
  if (gameState.ruleset === 'ASYMMETRIC') {
    const currentHand = player.movementHand || [];
    if (currentHand.length < HAND_SIZE) {
      const drawnCards = drawMovementHand(HAND_SIZE - currentHand.length);
      player = { ...player, movementHand: [...currentHand, ...drawnCards] };
      state = replacePlayer(state, player);
    }
  }

  return {
    ...state,
    phase: player.inJail ? 'JAIL_DECISION' : (state.ruleset === 'ASYMMETRIC' ? 'PLAYING_CARD' : 'ROLLING'),
    lastRollWasDouble: null,
    currentDoublesStreak: 0,
    // lastRoll is deliberately NOT cleared here as of 2026-08-25 (user
    // request: "người chơi khác cũng thấy được xúc xắc của người chơi đang
    // đổ xúc xắc trên bàn cờ"). Clearing it on every turn advance made three
    // real rolls produce no visible dice at all for anybody, because each
    // one ends the turn instantly and cascades straight into the next
    // player's startTurn(): a failed jail-escape attempt, a 3rd consecutive
    // double, and landing on Go To Jail. Those were previously written off
    // as unfixable for exactly this reason (see this field's own JSDoc).
    //
    // Keeping the value instead makes every roll displayable, and hiding it
    // again becomes a presentation concern rather than a state one —
    // DiceRoll.jsx auto-hides a few seconds after lastRollSeq changes. No
    // game logic reads lastRoll (lastRollWasDouble/currentDoublesStreak,
    // both still reset here, carry everything the rules actually need), so
    // letting it outlive the turn is display-only and cannot affect play.
    currentDoublesStreak: 0,
  };
}

/**
 * END_TURN (GAME_STATE_MACHINE.md §8, "advance"): doubles keeps the same
 * player rolling again; otherwise advance to the next non-bankrupt player,
 * cascading through NEXT_PLAYER and the new player's TURN_START (both
 * system-only, no decision point) rather than stopping on either. Reads
 * gameState.lastRollWasDouble (P07-T02) instead of taking it as a
 * parameter — GameState must be self-contained so any caller (a real
 * END_TURN action, or a future timers.js default) can call this the same
 * way, without separately remembering the last roll itself.
 *
 * Win Condition design (2026-08-19): a "new round" is detected as
 * `nextPlayer.turnOrder <= gameState.currentTurnIndex` — turnOrder only
 * ever increases across a normal advance (0,1,2,...), so the one point it
 * doesn't is exactly a wraparound back toward the start, correctly
 * accounting for skipped bankrupt players in between (the loop above
 * already skips them when picking nextPlayer, so the comparison is against
 * whichever real index it actually landed on, not a naive +1). On a
 * wraparound: increment roundNumber, then check the Final Phase state
 * machine (gameEndMachine.js) — shouldEndFinalPhase() short-circuits
 * straight to settleGameEnd() (a net_worth win, never reaching
 * startTurn/ROLLING at all this round), otherwise shouldEnterFinalPhase()
 * may set finalPhaseStartedAtRound for the first time. Doubles (the early
 * return above) never advance currentTurnIndex at all, so they can never
 * complete a round on their own — correct, since the same player is about
 * to roll again, not starting a new lap.
 */
function advanceTurn(gameState, boardTiles, now) {
  // Phase 14 (2026-08-19): a hostile-buyout-eligible property never
  // survives past the turn that landed on it — cleared here, the single
  // point every path through this function passes through (a doubles
  // bonus roll included: about to roll again, so whatever was just landed
  // on before this call is no longer "the property just landed on" even
  // though the same player keeps going).
  const state = { ...gameState, pendingHostileBuyoutPropertyId: null };

  if (state.lastRollWasDouble) {
    return { gameState: { ...state, phase: state.ruleset === 'ASYMMETRIC' ? 'PLAYING_CARD' : 'ROLLING' }, transactions: [] };
  }

  const realPlayers = state.players.filter((p) => !p.isBank);
  const playerCount = realPlayers.length;
  let nextIndex = gameState.currentTurnIndex;
  let nextPlayer;
  for (let i = 0; i < playerCount; i++) {
    nextIndex = (nextIndex + 1) % playerCount;
    const candidate = realPlayers.find((p) => p.turnOrder === nextIndex);
    if (candidate && !candidate.bankrupt) {
      nextPlayer = candidate;
      break;
    }
  }

  const wrapped = nextPlayer.turnOrder <= state.currentTurnIndex;
  const roundNumber = wrapped ? state.roundNumber + 1 : state.roundNumber;
  let advanced = {
    ...state,
    currentTurnIndex: nextPlayer.turnOrder,
    roundNumber,
    // K01/K02/K07/K08 (2026-08-22 deck) — "trong một vòng" (for the rest of
    // the current round): reset on the exact real round-wraparound boundary
    // this function already computes, not a separate expiry timer/field.
    // Player-specific nextBuildDiscount/nextRentDiscount are NOT reset here
    // — those are one-shot-per-use, not round-scoped, by design (their own
    // doc comments).
    ...(wrapped ? { rentModifierPercent: 0, buildCostModifierAmount: 0 } : {}),
  };

  if (wrapped) {
    if (shouldEndFinalPhase(advanced)) {
      return settleGameEnd(advanced, boardTiles, now, 'final_phase');
    }
    if (shouldEnterFinalPhase(advanced)) {
      advanced = { ...advanced, finalPhaseStartedAtRound: advanced.roundNumber };
    }
  }

  return { gameState: startTurn(advanced), transactions: [] };
}

/**
 * JAIL_DECISION's three exit paths. GAME_STATE_MACHINE.md §8's table
 * collapses all three onto one "-> ROLLING" row, but GAME_DESIGN_SPEC.md
 * §15's narrative (and real Monopoly rules) draw a finer distinction that
 * table row glosses over:
 *   - pay_jail_fine / use_jail_card: released, but haven't rolled yet
 *     this turn -> ROLLING, awaiting a fresh ROLL_DICE.
 *   - attempt_jail_roll, doubles: released, and that roll *is* their
 *     movement for the turn -> straight into movement/landing, no second
 *     roll requested. Classic rule (not in either doc's collapsed table):
 *     this escape roll also never earns the normal roll-doubles-again bonus
 *     turn, even though it IS a double — that bonus is a reward for doubles
 *     during an ordinary turn, not for the act of escaping jail. lastRollWasDouble
 *     / currentDoublesStreak are forced flat after moveAndResolve so a later
 *     POST_ACTIONS -> advanceTurn always moves on to the next player.
 *   - attempt_jail_roll, fails (whether or not it's the forced 3rd
 *     attempt): no movement happens this turn either way -> advanceTurn
 *     immediately (lastRollWasDouble forced false first). This does match
 *     the table's one explicit exception for the forced case ("-> END_TURN");
 *     the non-forced failure case needed the narrative to resolve, and both
 *     call advanceTurn rather than resting at a dead END_TURN phase with no
 *     action defined to leave it — see the file header.
 */
function handleJailAction(gameState, boardTiles, action, now) {
  const player = getCurrentPlayer(gameState);

  if (action.type === 'PAY_JAIL_FINE') {
    return payJailFineOrLiquidate(gameState, boardTiles, player, JAIL_FINE, 'RELEASE_TO_ROLLING', now);
  }

  if (action.type === 'USE_JAIL_CARD') {
    // Closes a real pre-existing gap (2026-08-22): jail.js's useCard() has
    // always released the player unconditionally — its own docstring
    // explicitly said checking card possession "is the caller's job", since
    // PlayerGameState had no inventory field for it to check. Now that
    // jailFreeCards exists, this is that caller. useCard() itself stays
    // exactly as it was (still just the pure inJail->released transition) —
    // the possession check and the decrement both belong here, not inside it.
    if (player.jailFreeCards <= 0) {
      throw new InvalidJailActionError('NO_JAIL_CARD', `handleJailAction: player '${player.id}' has no Get Out of Jail Free card`);
    }
    const released = useCard(player);
    const state = replacePlayer(gameState, { ...released, jailFreeCards: released.jailFreeCards - 1 });
    return { gameState: { ...state, phase: state.ruleset === 'ASYMMETRIC' ? 'PLAYING_CARD' : 'ROLLING' }, transactions: [] };
  }

  // ATTEMPT_JAIL_ROLL
  const { player: afterRoll, released, fineOwed } = rollForExit(player, action.payload);

  if (released && fineOwed === null) {
    // Doubles — released and moving on this same roll, but (see the
    // docstring above) this specific double never grants the usual bonus
    // turn, so the streak is forced flat regardless of what moveAndResolve
    // set it to from the underlying roll.
    const state = replacePlayer(gameState, afterRoll);
    const result = moveAndResolve(state, boardTiles, player.id, action.payload, now);
    return {
      gameState: { ...result.gameState, lastRollWasDouble: false, currentDoublesStreak: 0 },
      transactions: result.transactions,
    };
  }

  if (fineOwed !== null) {
    // Forced release, 3rd failed attempt — same JAIL_FINE debt, same
    // solvency check as the voluntary path now (finding #28,
    // docs/PROJECT_STATUS.md: this used to charge the fine unconditionally,
    // with no affordability check at all — a real "balance never goes
    // negative" invariant violation). rollForExit()'s own computed release
    // (afterRoll) is deliberately discarded here, not applied —
    // payJailFineOrLiquidate() decides for itself whether/when the release
    // actually lands (immediately if solvent, deferred until a pending
    // liquidation clears, or moot if this turns out to be a real
    // bankruptcy).
    //
    // REVISED 2026-09-01: was 'RELEASE_AND_ADVANCE' — pay the fine, leave
    // jail, and immediately lose the turn without moving. The player now
    // MOVES on the way out, using the very roll that just failed. That is
    // the classic rule ("pay, then move the number you just rolled") and it
    // reuses the failed roll rather than granting a fresh one: a second roll
    // would be two rolls in one turn, and could come up doubles, raising a
    // bonus-turn question this exit has no business creating. The failed
    // roll is by definition not a double, so the move can never award one.
    return payJailFineOrLiquidate(gameState, boardTiles, player, fineOwed, 'RELEASE_AND_MOVE', now, action.payload);
  }

  // Failed, not yet the forced attempt — stays in jail. No money involved at
  // all here, so no solvency check needed — jailTurns++ is always
  // "affordable".
  //
  // REVISED 2026-09-01: this used to call advanceTurn() immediately, ending
  // the turn outright. A jailed player therefore lost their entire economy
  // for up to 4 consecutive turns (the turn they were jailed, plus up to 3
  // failed escapes) — unable to build, sell, mortgage or unmortgage, even
  // though nothing about being in jail should touch asset management.
  // Confirmed by grep at the time: `inJail` gated exactly ONE thing in the
  // whole backend — startTurn()'s phase routing below — so this denial was
  // never a rule, only a side effect of the turn ending here.
  //
  // Now the turn continues into POST_ACTIONS with the player still jailed:
  // they may run any normal economic action and then END_TURN themselves.
  // Movement stays impossible, because startTurn() still routes them back to
  // JAIL_DECISION next turn while inJail holds. POST_ACTIONS already has both
  // a phase timer and a buildDefaultAction (END_TURN), so this introduces no
  // new stall point.
  //
  // lastRoll IS recorded (2026-08-25): a failed jail-escape attempt is a real
  // roll, and it was one of three rolls in the game that produced no visible
  // dice for anyone.
  const state = replacePlayer(gameState, afterRoll);
  return {
    gameState: {
      ...state,
      phase: 'POST_ACTIONS',
      lastRollWasDouble: false,
      currentDoublesStreak: 0,
      lastRoll: rollToDisplay(action.payload),
      lastRollSeq: (gameState.lastRollSeq ?? 0) + 1,
    },
    transactions: [],
  };
}

/**
 * Finding #28 (docs/PROJECT_STATUS.md), resolved 2026-08-19: both jail-fine
 * payment paths used to call applyTransaction() directly and
 * unconditionally — unlike every other debt in the game (settleDebt(),
 * rewritten in the Win Condition pass to route rent/tax through
 * checkSolvency()/LIQUIDATION_REQUIRED/real bankruptcy), a cash-short
 * player forced to pay this fine could go negative. Same treatment here,
 * for both jail-fine callers.
 *
 * Deliberately does not call jail.js's own payFine()/rely on
 * rollForExit()'s already-computed release: the release (inJail: false,
 * jailTurns: 0 — the same shape both of those functions already produce)
 * must NOT happen until payment is actually confirmed possible, so this
 * function decides for itself when to apply it rather than being handed an
 * already-decided one.
 * @param {import('../domain/gameState.js').PlayerGameState} player - the still-in-jail player, pre-release
 * @param {number} fineOwed - JAIL_FINE, always — kept as a parameter rather than hardcoded so the caller's own source of truth stays authoritative
 * @param {'RELEASE_TO_ROLLING'|'RELEASE_AND_ADVANCE'|'RELEASE_AND_MOVE'} onSettled - what happens once the fine is actually paid, immediately (if solvent) or later (see resolveLiquidationStep) — 'RELEASE_TO_ROLLING' for a voluntary PAY_JAIL_FINE, 'RELEASE_AND_MOVE' for the forced 3rd attempt (2026-09-01: pay, then move by the roll that just failed). 'RELEASE_AND_ADVANCE' is retained for backward compatibility with any pendingLiquidation already persisted in a live snapshot under the old behaviour — the whole GameState is one JSONB blob, so a match mid-liquidation across this deploy would otherwise resolve into an unhandled branch.
 * @param {{die1: number, die2: number, total: number, isDouble: boolean}} [moveRoll] - only for RELEASE_AND_MOVE: the failed jail roll to move by once the fine settles. Carried into pendingLiquidation so a deferred settlement can still move the player.
 */
function payJailFineOrLiquidate(gameState, boardTiles, player, fineOwed, onSettled, now, moveRoll) {
  const bank = getBankPlayer(gameState);
  const solvency = checkSolvency({
    cashOnHand: player.currentBalance,
    debt: fineOwed,
    holdings: holdingsFor(gameState, boardTiles, player.id),
  });

  if (solvency.canPayInCash) {
    const state = replacePlayer(gameState, { ...player, inJail: false, jailTurns: 0 });
    const { gameState: afterFine, transaction } = applyTransaction(state, {
      fromPlayerId: player.id,
      toPlayerId: bank.id,
      amount: fineOwed,
      transactionType: 'jail_fine',
    });
    const withJackpot = feedFreeParkingJackpot(afterFine, 'jail_fine', fineOwed);

    if (onSettled === 'RELEASE_TO_ROLLING') {
      return { gameState: { ...withJackpot, phase: withJackpot.ruleset === 'ASYMMETRIC' ? 'PLAYING_CARD' : 'ROLLING' }, transactions: [transaction] };
    }
    if (onSettled === 'RELEASE_AND_MOVE') {
      // Released and moving on the roll that just failed. Streak forced flat
      // for the same reason the doubles-exit branch does it: leaving jail
      // never grants a bonus turn, whatever the dice happened to be.
      const moved = moveAndResolve(withJackpot, boardTiles, player.id, moveRoll, now);
      return {
        gameState: { ...moved.gameState, lastRollWasDouble: false, currentDoublesStreak: 0 },
        transactions: [transaction, ...moved.transactions],
      };
    }
    const advanced = advanceTurn({ ...withJackpot, lastRollWasDouble: false, currentDoublesStreak: 0 }, boardTiles, now);
    return { gameState: advanced.gameState, transactions: [transaction, ...advanced.transactions] };
  }

  if (!solvency.isBankrupt) {
    // `moveRoll` rides along so a DEFERRED settlement (the debtor has to
    // liquidate first) can still move them once the fine clears — without it
    // a cash-short player would silently lose the move a solvent one gets.
    const pendingLiquidation = {
      debtorId: player.id, creditorId: bank.id, amount: fineOwed, transactionType: 'jail_fine', onSettled,
      ...(moveRoll ? { moveRoll } : {}),
    };
    return { gameState: { ...gameState, phase: 'LIQUIDATION_REQUIRED', pendingLiquidation }, transactions: [] };
  }

  const { gameState: afterBankruptcy, transactions } = applyBankruptcy(gameState, boardTiles, player.id, bank.id, now);
  return finishAfterBankruptcy(afterBankruptcy, boardTiles, transactions, now, player.id);
}

/**
 * AWAITING_PURCHASE path 1 — SKIP_PURCHASE (V2 "Bỏ qua").
 * Free: no fee, no auction. The property stays bank-owned (unowned),
 * potentially purchasable by the next player who lands on it.
 * Transitions straight to POST_ACTIONS — same as the old "can't afford the
 * fee" fallback that no longer exists now that SKIP and FORCE are separate.
 *
 * DECLINE_PURCHASE (legacy alias) routes here too — backward-compatible so
 * existing clients / tests that still send DECLINE_PURCHASE keep working
 * without a flag day.
 */
function handleSkipPurchase(gameState) {
  return { gameState: { ...gameState, phase: 'POST_ACTIONS' }, transactions: [] };
}

/**
 * AWAITING_PURCHASE path 2 — FORCE_AUCTION (V2 "Mở Đấu Giá / Nhà Môi Giới").
 * The player pays calculateAuctionFee(tile.price) to open a live auction.
 * On SETTLED, resolveAuction emits commission intents (Bank → initiator,
 * 20% of winning bid) — settleAuction applies them via applyIntents().
 *
 * If the player cannot afford the fee, this throws an
 * InvalidTurnActionError with reason INSUFFICIENT_BALANCE rather than
 * silently falling back — the client is responsible for checking
 * affordability before offering the button (calculateAuctionFee is exported
 * for exactly this). Graceful fallback would mask a client bug.
 *
 * Anti-abuse: after any auction outcome (SETTLED or FAILED) the turn always
 * continues to POST_ACTIONS — never back to AWAITING_PURCHASE. A FAILED
 * auction's property stays unowned and the initiator cannot re-buy it this
 * turn (settleAuction always targets POST_ACTIONS).
 */
function handleForceAuction(gameState, boardTiles, action) {
  const player = getCurrentPlayer(gameState);
  const tile = findTileAt(boardTiles, player.currentPosition);
  const property = gameState.properties.find((p) => p.boardTileId === tile.id);
  const bank = getBankPlayer(gameState);

  // Custom opening price (2026-09-03). The host may open the lot at any price
  // they choose; omitting it opens at the printed price exactly as before.
  //
  // This was originally bounded to [50% of printed, printed]. Those bounds
  // were REMOVED the same day, deliberately ("allow any positive opening
  // price, no upper/lower bound") — but the long comment block arguing FOR
  // them outlived them and sat here directly contradicting the code three
  // lines below. Deleted 2026-09-04 rather than left lying.
  //
  // The concern it raised is real and is now knowingly unmitigated, so it is
  // recorded here rather than lost with it: with no floor, a host at a 3+
  // player table can open a $400 lot at $1 and let an ally take it for pocket
  // change. At a 2-player table that is only self-harm (the Broker rule bars
  // the host from bidding), and rival bidders can always compete the price
  // back up — but nothing forces them to be solvent at that moment. Accepted
  // as a known trade for host freedom; revisit if collusion shows up in real
  // play.
  const printedPrice = tile.price;
  const requestedOpen = action?.payload?.basePrice;
  let basePrice = printedPrice;
  if (requestedOpen != null) {
    // Only constraint: must be a positive integer. No floor, no ceiling —
    // the host may open at any price they choose. The 5% fee is their skin
    // in the game regardless of what they pick.
    if (!Number.isInteger(requestedOpen) || requestedOpen <= 0) {
      throw new InvalidPropertyActionError(
        'INVALID_BASE_PRICE',
        `handleForceAuction: opening price ${requestedOpen} must be a positive integer`
      );
    }
    basePrice = requestedOpen;
  }

  // Fee is charged on the HOST-CHOSEN opening price (basePrice), not the
  // printed tile price. This way the host pays proportionally to the price
  // they choose to open at — a lower opening means a lower fee.
  const fee = calculateAuctionFee(basePrice);
  if (player.currentBalance < fee) {
    // 2026-09-02: was an InvalidTurnActionError, which socketServer.js's
    // errorCodeFor() maps to PHASE_MISMATCH — so a player who simply lacked
    // the fee was told "Chưa tới bước này / không phải ở giai đoạn hiện tại",
    // which is not the reason at all. The message string already said
    // INSUFFICIENT_BALANCE; only the error class was wrong. Reachable in
    // practice only via a race (PropertyActionDrawer mirrors this exact fee
    // formula and disables the button), but the wrong-reason class made that
    // race unreadable when it did happen.
    throw new InvalidPropertyActionError(
      'INSUFFICIENT_BALANCE',
      `handleForceAuction: balance ${player.currentBalance} is less than the auction fee ${fee}`
    );
  }

  const { gameState: afterFee, transactions, pendingDebts } = applyIntents(
    gameState,
    boardTiles,
    [{ action: 'REMOVE_MONEY', playerId: player.id, amount: fee }],
    'flash_auction',
    player.id
  );
  assertNoUnpaidDebts(pendingDebts, 'handleForceAuction'); // unreachable: affordability checked above

  // Every real, non-bankrupt player EXCEPT the initiator is eligible to bid
  // (V2 Broker rule: The auction host cannot bid on their own auction).
  const eligibleBidders = afterFee.players
    .filter((p) => !p.isBank && !p.bankrupt && p.id !== player.id)
    .map((p) => p.id);
  
  const pendingAuction = startAuction(property.id, basePrice, player.id, eligibleBidders, bank.id);

  return {
    gameState: { ...afterFee, phase: 'FLASH_AUCTION_ACTIVE', pendingAuction },
    transactions,
  };
}


/**
 * Shared by FOLD_AUCTION (once activeBidders drops to <= 1) and
 * AUCTION_TIMEOUT (always, regardless of activeBidders): resolve the
 * auction exactly as-is, apply its settlement intents (winner payment,
 * property transfer, any Near-Miss rewards) via applyIntents(), clear
 * pendingAuction, and continue to POST_ACTIONS.
 */
function settleAuction(gameState, boardTiles, auction, now) {
  const settlement = resolveAuction(auction);
  const { gameState: afterIntents, transactions, pendingDebts } = applyIntents(
    { ...gameState, pendingAuction: null },
    boardTiles,
    settlement.intents,
    'flash_auction',
    settlement.winnerId
  );

  // This used to `assertNoUnpaidDebts(...)` on the reasoning that a winner
  // can always pay: placeBid() validates the bid against the bidder's balance,
  // and "no money moves during FLASH_AUCTION_ACTIVE".
  //
  // That second half is FALSE, and has been since trades became turn- AND
  // phase-independent (Trade System, 2026-08-18). A bidder can win at $1,400,
  // then hand $1,400 to someone else through a trade while the auction is
  // still live, and arrive at settlement unable to pay. Found by fuzzing
  // 2026-09-02 and reproduced minimally.
  //
  // The consequence was not a wrong number — it was a PERMANENT DEADLOCK.
  // The throw aborted the transition, so `pendingAuction` stayed set and the
  // phase stayed FLASH_AUCTION_ACTIVE; FOLD_AUCTION threw again, and so did
  // AUCTION_TIMEOUT, which is the phase's own timer default. The match had no
  // escape at all, and a bidder could trigger it deliberately.
  //
  // Fixed the way the identical bug in event cards was fixed (2026-08-23):
  // route the shortfall through the same settlement path every other debt in
  // the game uses, rather than asserting it away. POST_ACTIONS is set FIRST so
  // it is the normal outcome, and settlePendingDebts overrides it only if a
  // debt genuinely forces LIQUIDATION_REQUIRED or ends the match — which also
  // keeps settleGameEnd's standings honest, since the charge is now really
  // settled rather than merely asserted impossible.
  //
  // Note the auction winner is frequently NOT the current-turn player, and
  // settlePendingDebts already handles exactly that: a non-current debtor
  // cannot act on their own liquidation, so it settles them as immediate
  // bankruptcy instead. That is the documented, deliberate behaviour there.
  return settlePendingDebts({ ...afterIntents, phase: 'POST_ACTIONS' }, boardTiles, transactions, pendingDebts, now);
}

function handleDeclineUpgrade(gameState) {
  return { gameState: { ...gameState, phase: 'POST_ACTIONS' }, transactions: [] };
}

/**
 * FLASH_AUCTION_ACTIVE's actions. PLACE_BID/FOLD_AUCTION need
 * action.payload.playerId to identify the actor — this phase is the one
 * place in this file where the acting player is NOT
 * getCurrentPlayer(gameState) (see the file header): any eligible bidder
 * can act, regardless of whose turn it nominally is.
 *
 * PLACE_BID: delegates entirely to engine/auction.js's placeBid(), which
 * already validates amount > currentBid, bidder is active, and bidder can
 * afford it (InvalidBidError otherwise) — no duplicate validation here.
 *
 * FOLD_AUCTION: delegates to foldBidder(); if that leaves more than one
 * active bidder, the auction simply continues. If it leaves one or zero,
 * settleAuction() resolves it immediately (a new, previously-undocumented
 * rule — see file header).
 *
 * AUCTION_TIMEOUT: system-generated, no playerId — the window/bid-reset
 * timer's own default action (GAME_STATE_MACHINE.md §7's
 * FLASH_AUCTION_WINDOW_SECONDS / FLASH_AUCTION_BID_RESET_SECONDS),
 * synthesized and passed in by a future timers.js extension the same way
 * ROLLING/AWAITING_PURCHASE's own timeout defaults already are — this file
 * never schedules the timer itself (no setTimeout anywhere here, same
 * no-I/O contract as everything else in it). Forces settleAuction()
 * unconditionally, regardless of how many active bidders remain — the one
 * case that can resolve an auction still sitting above one active bidder.
 */
function handleAuctionAction(gameState, boardTiles, action, now) {
  if (action.type === 'AUCTION_TIMEOUT') {
    return settleAuction(gameState, boardTiles, gameState.pendingAuction, now);
  }

  const { playerId } = action.payload;

  if (action.type === 'PLACE_BID') {
    const bidder = gameState.players.find((p) => p.id === playerId);
    const pendingAuction = placeBid(gameState.pendingAuction, playerId, action.payload.amount, bidder.currentBalance);
    return { gameState: { ...gameState, pendingAuction }, transactions: [] };
  }

  // FOLD_AUCTION
  const foldedAuction = foldBidder(gameState.pendingAuction, playerId);

  if (foldedAuction.activeBidders.length > 1) {
    return { gameState: { ...gameState, pendingAuction: foldedAuction }, transactions: [] };
  }

  return settleAuction(gameState, boardTiles, foldedAuction, now);
}

/**
 * AWAITING_EVENT_CHOICE's only action — resolves the card recorded in
 * pendingEventCardId when DRAWING_CARD entered this phase.
 * action.payload.probabilityRoll always arrives externally (never
 * generated here) — same convention as ROLL_DICE/ATTEMPT_JAIL_ROLL's dice
 * values: a real caller sources it from Math.random() outside this pure
 * function, tests inject a fixed value directly.
 */
function handleEventChoice(gameState, boardTiles, action, now) {
  const player = getCurrentPlayer(gameState);
  const card = EVENT_CARDS[gameState.pendingEventCardId];
  const { optionId, probabilityRoll, dieFaceRoll } = action.payload;

  // DEADLOCK ESCAPE (2026-09-02) — when the drawer can afford NO option on
  // this card, the card fizzles: revealed, then resolved as a no-op straight
  // to POST_ACTIONS. This is the same "an ineligible draw is an honest
  // 'you drew this but weren't eligible' no-op" semantics the `eligibility`
  // field already documents (domain/eventDictionary.js), applied to the case
  // where affordability is lost AFTER the draw.
  //
  // It was a real, reproducible hard stall. C11_CU_DANH_LIEU is gated at
  // `currentBalance >= 50` on draw and its SINGLE option costs $50 — but
  // trades (and GAMBLE_RENT, and USE_INVENTORY_CARD) are deliberately
  // phase-independent, so the drawer's cash can fall below $50 while the
  // card is still pending. From there:
  //   - AWAITING_EVENT_CHOICE allows exactly one action, MAKE_EVENT_CHOICE,
  //     and every call threw INSUFFICIENT_BALANCE — the player had no legal
  //     move at all;
  //   - the AWAITING_EVENT_CHOICE timeout synthesized that same doomed
  //     choice (timers.js deliberately fell back to an unaffordable option
  //     when none was affordable), so handleTurnTimeout logged the rejection
  //     and returned with the timer already cleared — the room froze for
  //     EVERY player, permanently, if the drawer went AFK.
  // Same root shape as the settleAuction deadlock fixed 2026-09-01: a guard
  // that assumed money cannot move during a phase where, since trades became
  // phase-independent, it demonstrably can.
  //
  // Deliberately narrow: only when NOTHING is affordable. Picking an
  // unaffordable option while an affordable one exists is still genuinely
  // invalid input and still rejected with INSUFFICIENT_BALANCE.
  const options = card?.options ?? [];
  if (options.length > 0 && options.every((o) => player.currentBalance < (o.validation?.amount ?? 0))) {
    return { gameState: { ...gameState, pendingEventCardId: null, phase: 'POST_ACTIONS' }, transactions: [] };
  }

  const intents = resolveChoice(gameState, player.id, card, optionId, probabilityRoll, dieFaceRoll);
  const cleared = { 
    ...gameState, 
    pendingEventCardId: null,
    ...(dieFaceRoll ? { 
      lastRoll: { die1: dieFaceRoll, die2: 0, total: dieFaceRoll, isDouble: false },
      lastRollSeq: (gameState.lastRollSeq ?? 0) + 1
    } : {})
  };

  // MOVE_RELATIVE (C01 "Lối Tắt") changes *where the turn goes next*, not
  // just player/GameState fields — same interception resolveDrawingCard's
  // own MOVE_TO_NEAREST_UNOWNED_PROPERTY branch already uses, and for the
  // identical reason (moveByStepsAndResolve's own header comment).
  const moveIntent = intents.find((i) => i.action === 'MOVE_RELATIVE');
    if (moveIntent) {
      const walkState = { ...cleared, lastRoll: { die1: moveIntent.steps, die2: 0, total: moveIntent.steps, isDouble: false } };
      return moveByStepsAndResolve(walkState, boardTiles, player.id, moveIntent.steps, now);
    }

  // GRANT_PROPERTY_PROTECTION (C08 "Bảo Vệ Tài Sản", 2026-08-25) — intercepted
  // here for the same reason MOVE_RELATIVE is: its real input isn't in the
  // static dictionary intent at all. WHICH property to protect is the entire
  // decision the card exists to pose, and a fixed `options` array can't
  // enumerate a player's live holdings — so it rides in on the action payload
  // and is validated against real state right here, never trusted as sent.
  const protectIntent = intents.find((i) => i.action === 'GRANT_PROPERTY_PROTECTION');
  if (protectIntent) {
    const eligible = protectablePropertiesFor(cleared, player.id);

    // Nothing left to protect — resolve as a revealed no-op rather than
    // rejecting, so the blocking phase always clears. The card's own
    // eligibility gate normally prevents ever reaching this phase without a
    // target, but it CAN be reached legitimately: trades are deliberately
    // phase-independent, so a player who drew C08 while holding exactly one
    // unimproved property can trade it away before choosing. Throwing there
    // would leave AWAITING_EVENT_CHOICE unresolvable and hang the turn —
    // finding #35's failure mode, and exactly what its regression test
    // caught the moment this card was wired in.
    if (eligible.length === 0) {
      return { gameState: { ...cleared, phase: 'POST_ACTIONS' }, transactions: [] };
    }

    // A player who DOES hold protectable property but named something else
    // is a real invalid input, and still rejected.
    const targetId = action.payload?.propertyId;
    if (!eligible.some((p) => p.id === targetId)) {
      throw new InvalidPropertyActionError(
        'NOT_PROTECTABLE',
        `handleEventChoice: property '${targetId}' is not an unimproved property owned by '${player.id}'`
      );
    }
    return {
      gameState: {
        ...cleared,
        propertyProtection: { propertyId: targetId, ownerId: player.id, grantedAtRound: cleared.roundNumber },
        phase: 'POST_ACTIONS',
      },
      transactions: [],
    };
  }

  const { gameState: afterIntents, transactions, pendingDebts } = applyIntents(cleared, boardTiles, intents, 'event_card', player.id);

  // Same "settle what couldn't be paid in cash through the real settleDebt"
  // step the INSTANT branch does — see settlePendingDebts. C11's die-face-1
  // outcome (-$100 on top of an already-paid $50 stake) is the concrete
  // case this covers on the CHOICE side.
  const settled = { ...afterIntents, phase: 'POST_ACTIONS' };
  return settlePendingDebts(settled, boardTiles, transactions, pendingDebts, now);
}

function handleBuyProperty(gameState, boardTiles, now) {
  const player = getCurrentPlayer(gameState);
  const tile = findTileAt(boardTiles, player.currentPosition);
  const property = gameState.properties.find((p) => p.boardTileId === tile.id);
  const bank = getBankPlayer(gameState);

  const { amount, transactionType } = calculatePurchase(tile);

  // Added 2026-08-25 — this was the real source of the negative balances
  // seen in a live match (a player sitting at $-293). BUY_PROPERTY is the
  // oldest and most-used money-spending action in the game and it was the
  // ONLY voluntary purchase with no affordability check at all: BUILD_HOUSE,
  // UNMORTGAGE and HOSTILE_BUYOUT each had one, this did not, so a player
  // holding $80 could buy a $300 street and simply go to -$220. Found by
  // fuzzing rather than by review — every reproduction across 400 seeded
  // games traced to exactly this call.
  //
  // Rejecting is the correct response here, NOT forcing liquidation: buying
  // is voluntary, so "you cannot afford this" is a legitimate refusal. Forced
  // mortgaging is for debts the player had no choice about (rent/tax/fines),
  // which already route through settleDebt() -> LIQUIDATION_REQUIRED.
  if (player.currentBalance < amount) {
    throw new InvalidPropertyActionError(
      'INSUFFICIENT_BALANCE',
      `handleBuyProperty: balance ${player.currentBalance} is less than the price ${amount} of '${tile.name}'`
    );
  }

  const { gameState: afterPayment, transaction } = applyTransaction(gameState, {
    fromPlayerId: player.id,
    toPlayerId: bank.id,
    amount,
    transactionType,
  });

  const properties = afterPayment.properties.map((p) =>
    p.id === property.id ? { ...p, ownerId: player.id, acquiredAt: now, acquiredAtRound: gameState.roundNumber } : p
  );

  return { gameState: { ...afterPayment, properties, phase: 'POST_ACTIONS' }, transactions: [transaction] };
}

/**
 * BUILD_HOUSE (GAME_DESIGN_SPEC.md §12) — POST_ACTIONS only, current-turn
 * player only, one house/hotel unit per action (mirrors calculateBuildHouse's
 * own "one unit at a time" convention). Unlike BUY_PROPERTY, the target
 * property is not implied by the player's currentPosition — POST_ACTIONS is
 * reached after movement/landing already resolved, and a player may build on
 * any qualifying property they own anywhere on the board — so
 * action.payload.propertyId (Property.id, not boardTileId) is required.
 *
 * Validates, in order: property exists and is a 'property'-type tile
 * (railroads/utilities never take houses — GAME_DESIGN_SPEC.md §12 only ever
 * mentions street properties), caller owns it, it's below the hotel ceiling
 * (MAX_UPGRADE_LEVEL), no member of a group they own is mortgaged, and the
 * building-supply pool has a piece left — before checking funds. (The
 * even-build rule was removed 2026-09-02 — see the inline comment above the
 * GROUP_MORTGAGED check.)
 * groupTiles resolves to `[]` when tile.groupId is null (ADAPTIVE_BOARD_DESIGN's
 * real seed data has no group content yet — PROJECT_STATUS.md's open items),
 * which correctly fails the full-group-ownership check rather than treating
 * an ungrouped tile as a trivial group-of-one — same graceful-false-on-
 * missing-group-data convention as calculateRent.js's hasGroupBonus.
 *
 * Deliberately NOT enforced: HOUSE_SUPPLY_TOTAL/HOTEL_SUPPLY_TOTAL scarcity —
 * GAME_DESIGN_SPEC.md §12 flags this as a still-[OPEN DESIGN DECISION]
 * ("many digital adaptations skip it for simplicity... pick one"), not a
 * settled rule. Unlimited supply is the doc's own suggested default for
 * exactly this situation, applied here rather than guessed; enforcing it
 * later would need a new shared per-match counter on GameState, an additive
 * change, not a rework of this function.
 */
function handleBuildHouse(gameState, boardTiles, action) {
  const player = getCurrentPlayer(gameState);
  const property = gameState.properties.find((p) => p.id === action.payload?.propertyId);
  if (!property) {
    throw new TypeError(`handleBuildHouse: no property found for propertyId '${action.payload?.propertyId}'`);
  }

  const tile = boardTiles.find((t) => t.id === property.boardTileId);
  if (!tile || tile.tileType !== 'property') {
    throw new TypeError(`handleBuildHouse: propertyId '${property.id}' is not a house-eligible tile`);
  }

  if (property.ownerId !== player.id) {
    throw new InvalidPropertyActionError('NOT_OWNER', `handleBuildHouse: '${player.id}' does not own property '${property.id}'`);
  }

  if (property.upgradeLevel >= MAX_UPGRADE_LEVEL) {
    throw new InvalidPropertyActionError(
      'MAX_UPGRADE_LEVEL',
      `handleBuildHouse: property '${property.id}' is already at the maximum upgrade level (${MAX_UPGRADE_LEVEL})`
    );
  }

  // 2026-08-25, user request: building must wait until at least the owner's
  // own next turn after taking possession (BUY_PROPERTY or HOSTILE_BUYOUT —
  // property.js's own doc comment on acquiredAtRound has the full reasoning).
  // gameState.roundNumber increments exactly once per full cycle through
  // every active player (advanceTurn()'s own doc comment) — since a player
  // can only ever acquire a property during their OWN turn, "roundNumber has
  // advanced at least once since acquisition" is equivalent to "this player's
  // own next turn has begun", regardless of their position in turn order.
  // acquiredAtRound === null skips this entirely — never acquired this way
  // (a trade, or a fixture/legacy property with no round history at all).
  if (property.acquiredAtRound != null && gameState.roundNumber <= property.acquiredAtRound) {
    throw new InvalidPropertyActionError(
      'RECENTLY_ACQUIRED',
      `handleBuildHouse: property '${property.id}' was acquired this same round (${property.acquiredAtRound}) — must wait until your next turn`
    );
  }

  // 2026-08-25, user request ("không cần sở hữu nhóm màu mới được xây nhà mà
  // là xây được luôn nếu quay lại"): owning the COMPLETE colour group is no
  // longer a precondition for building. The old `INCOMPLETE_GROUP` check
  // that stood here is deliberately gone, not merely relaxed — landing on
  // your own property (engine/resolveTile.js already routes that to
  // AWAITING_UPGRADE) is now enough on its own to offer a build.
  //
  // This REVISES GAME_DESIGN_SPEC.md §12's monopoly-gated build rule, which
  // was classic-Monopoly behaviour. Worth stating the real consequence
  // plainly rather than burying it: building is now much easier, so rentTable
  // values that were priced on the assumption that a developed property
  // implies a monopoly will be reached far more often and earlier. The group
  // bonus (engine/calculateRent.js's hasGroupBonus) still needs a full,
  // unmortgaged set — but as of 2026-09-02 it no longer also needs the
  // property unimproved, so it now stacks on top of a built-up property's
  // rentTable value at every level rather than vanishing the moment a house
  // goes down.
  //
  // The remaining group rule (no member mortgaged) is scoped to what this
  // player actually owns — see ownedGroupHoldingsFor's own comment for why
  // leaving it group-wide would have been broken, not just strict.
  //
  // The even-build rule ("build every lot you own in the group up to the
  // same level before pushing one higher") was REMOVED here 2026-09-02.
  // Measured over 250 matches × 3 seeds, on vs off: it prevented no exploit —
  // the single largest rent charged was unchanged (~$700 either way), because
  // building is not monopoly-gated in this game and the group ×2 bonus
  // already applies at every level regardless of evenness, so "rush one lot
  // to a hotel" is not actually a strong play (spreading across the lots
  // opponents can each land on out-earns it). Its one real effect was ~3
  // percentage points more house consumption; its cost was ~19 wasted turns
  // per match for anyone who fought it without understanding it. It was a
  // holdover from the monopoly-gated-building rule this game dropped on
  // 2026-08-25 and no longer had a matching build precondition to pair with.
  const myGroupHoldings = ownedGroupHoldingsFor(gameState, boardTiles, tile, property, player.id);

  if (myGroupHoldings.some((h) => h.property.mortgaged)) {
    throw new InvalidPropertyActionError(
      'GROUP_MORTGAGED',
      `handleBuildHouse: one of your properties in group '${tile.groupId}' is mortgaged`
    );
  }

  // Phase 14 (2026-08-19): GAME_DESIGN_SPEC.md §12's HOUSE_SUPPLY_TOTAL/
  // HOTEL_SUPPLY_TOTAL, now confirmed enforced. This specific build is the
  // 4-houses-to-1-hotel conversion iff the property is currently at level
  // 4 (about to become 5/MAX_UPGRADE_LEVEL) — checked against the *other*
  // shared pool (hotelSupply, not houseSupply), since a hotel is a
  // physically different piece, not four house-pieces stacked.
  const isHotelConversion = property.upgradeLevel === MAX_UPGRADE_LEVEL - 1;
  if (isHotelConversion ? gameState.hotelSupply <= 0 : gameState.houseSupply <= 0) {
    throw new InvalidPropertyActionError(
      'INSUFFICIENT_SUPPLY',
      `handleBuildHouse: no ${isHotelConversion ? 'hotels' : 'houses'} remaining in the shared supply`
    );
  }

  const { amount: baseAmount, transactionType } = calculateBuildHouse(tile);

  let asymmetricDiscount = 0;
  if (gameState.ruleset === 'ASYMMETRIC') {
    // Red passive buff (Architect): -20% house build cost globally if owning full Red group
    const redGroupTiles = boardTiles.filter((t) => t.groupId === 'red');
    if (redGroupTiles.length > 0) {
      const redHoldings = groupHoldingsFor(gameState, boardTiles, 'red');
      const ownsFullRedGroup =
        redHoldings.length === redGroupTiles.length &&
        redHoldings.every((h) => h.property.ownerId === player.id);
      
      if (ownsFullRedGroup) {
        asymmetricDiscount = Math.floor(baseAmount * 0.20);
      }
    }
  }

  // K07/K08 (global/round-scoped) + C07/C12-B (this player's own one-shot
  // discount) — see GameState.buildCostModifierAmount/PlayerGameState.
  // nextBuildDiscount's own doc comments. Both stack additively; clamped to
  // a floor of $0 (a build past a large discount is free, not negative —
  // there's no real transaction shape for the Bank paying a player to
  // build, and the design doc's own numbers never intended that).
  const amount = Math.max(0, baseAmount - asymmetricDiscount + gameState.buildCostModifierAmount - player.nextBuildDiscount);
  if (player.currentBalance < amount) {
    throw new InvalidPropertyActionError(
      'INSUFFICIENT_BALANCE',
      `handleBuildHouse: balance ${player.currentBalance} is less than houseCost ${amount}`
    );
  }

  const bank = getBankPlayer(gameState);
  // A discount CAN legitimately cover the whole cost — the `Math.max(0, ...)`
  // clamp above says so in as many words ("a build past a large discount is
  // free"). But applyTransaction rejects a non-positive amount outright, so
  // handing it that $0 threw a TypeError and the build failed. Very reachable,
  // not theoretical: C07 grants a $50 discount and 5 real streets cost exactly
  // $50 to build on; C12's option B grants $100, which zeroes out those 5 PLUS
  // the 9 streets at $100 — 14 of the board's 22 buildable streets. Worse, the
  // throw happened before any state change, so the discount was never consumed
  // either: the player stayed stuck in that condition indefinitely, holding a
  // "reward" card that silently broke building across most of the board.
  // Found by fuzzing (2026-08-25), the same technique that caught finding #39.
  //
  // A free build writes no ledger row at all rather than a $0 one — the same
  // resolution PAYING_RENT's own `rentAmount === 0` case already uses, and the
  // same reasoning ECONOMY_SPECIFICATION.md gives for a lost rent gamble
  // ("structurally required: applyTransaction itself rejects a non-positive
  // amount, so this really is 'no transaction row at all', not a $0 one").
  const paid =
    amount > 0
      ? applyTransaction(gameState, {
          fromPlayerId: player.id,
          toPlayerId: bank.id,
          amount,
          transactionType,
        })
      : { gameState, transaction: null };
  const { gameState: afterPayment, transaction } = paid;

  const properties = afterPayment.properties.map((p) =>
    p.id === property.id ? { ...p, upgradeLevel: p.upgradeLevel + 1 } : p
  );

  // The 4 houses physically on the property return to the shared pool the
  // instant they're consolidated into 1 hotel piece — GAME_DESIGN_SPEC.md
  // §12's own words: "4 houses → hotel converts, returns 4 houses to supply".
  const { houseSupply, hotelSupply } = isHotelConversion
    ? { houseSupply: afterPayment.houseSupply + 4, hotelSupply: afterPayment.hotelSupply - 1 }
    : { houseSupply: afterPayment.houseSupply - 1, hotelSupply: afterPayment.hotelSupply };

  // The discount, if any, is spent on this exact build regardless of
  // whether it fully covered the cost — same "consumed the instant it's
  // baked into a real settled amount" rule PAYING_RENT's own
  // nextRentDiscount consumption already follows.
  // C08's protection ends early the moment the property is actually built —
  // the card's own stated expiry ("hoặc Property được Build"). Keeping it
  // would be dead weight anyway: from upgradeLevel 1 the permanent
  // HOUSE_PROTECTED rule covers the same property forever.
  const protectionAfterBuild =
    afterPayment.propertyProtection?.propertyId === property.id ? null : afterPayment.propertyProtection;

  const stateAfterBuild = {
    ...afterPayment,
    properties,
    houseSupply,
    hotelSupply,
    propertyProtection: protectionAfterBuild,
    phase: 'POST_ACTIONS',
  };
  const finalState =
    player.nextBuildDiscount > 0
      ? replacePlayer(stateAfterBuild, {
          ...stateAfterBuild.players.find((p) => p.id === player.id),
          nextBuildDiscount: 0,
        })
      : stateAfterBuild;

  return {
    gameState: finalState,
    transactions: transaction ? [transaction] : [],
  };
}

/**
 * SELL_HOUSE — BUILD_HOUSE's exact inverse. Same ownership/eligibility
 * shape, but the even-*sell* rule runs the opposite direction from the
 * even-*build* rule: you may only sell from whichever property in the group
 * currently sits at the group's highest upgradeLevel (selling from a
 * behind-the-pack property would leave it even further behind, the
 * mismatch the rule exists to prevent) — mirrors handleBuildHouse's
 * lowest-level requirement exactly, inverted. No group-mortgaged check (that
 * BUILD_HOUSE precondition doesn't apply to selling — nothing about selling
 * a house requires the rest of the group to be unmortgaged).
 */
function handleSellHouse(gameState, boardTiles, action) {
  const player = getCurrentPlayer(gameState);
  const property = gameState.properties.find((p) => p.id === action.payload?.propertyId);
  if (!property) {
    throw new TypeError(`handleSellHouse: no property found for propertyId '${action.payload?.propertyId}'`);
  }

  const tile = boardTiles.find((t) => t.id === property.boardTileId);
  if (!tile) {
    throw new TypeError(`handleSellHouse: propertyId '${property.id}' has no matching tile`);
  }

  if (property.ownerId !== player.id) {
    throw new InvalidPropertyActionError('NOT_OWNER', `handleSellHouse: '${player.id}' does not own property '${property.id}'`);
  }

  if (property.upgradeLevel <= MIN_UPGRADE_LEVEL) {
    throw new InvalidPropertyActionError(
      'NO_HOUSES_TO_SELL',
      `handleSellHouse: property '${property.id}' has no houses to sell`
    );
  }

  // Scoped to this player's own holdings as of 2026-08-25 — see
  // ownedGroupHoldingsFor. Group-wide, a rival's taller building in the same
  // colour group would have blocked you from selling your own house, which
  // became reachable the moment building stopped requiring the full group.
  const myGroupHoldings = ownedGroupHoldingsFor(gameState, boardTiles, tile, property, player.id);
  const maxLevelInGroup = Math.max(...myGroupHoldings.map((h) => h.property.upgradeLevel));
  if (property.upgradeLevel < maxLevelInGroup) {
    throw new InvalidPropertyActionError(
      'UNEVEN_SELL',
      `handleSellHouse: even-sell rule — sell from your highest-level property in group '${tile.groupId}' first`
    );
  }

  // How far this one sale actually takes the property down. Normally exactly
  // one level — but a hotel converts back into 4 physical houses, and the
  // shared pool may not hold 4 (2026-08-25 fix, see the supply block below
  // for the full reasoning): in that case the property drops straight past
  // the levels there are no pieces for, and the player is paid for every
  // level actually removed rather than just one.
  const isHotelDowngrade = property.upgradeLevel === MAX_UPGRADE_LEVEL;
  const housesPlaceable = isHotelDowngrade
    ? Math.min(MAX_UPGRADE_LEVEL - 1, Math.max(0, gameState.houseSupply))
    : property.upgradeLevel - 1;
  const newLevel = isHotelDowngrade ? housesPlaceable : property.upgradeLevel - 1;
  const levelsSold = property.upgradeLevel - newLevel;

  const { amount: perLevel, transactionType } = calculateSellHouse(tile);
  const amount = perLevel * levelsSold;
  const bank = getBankPlayer(gameState);
  const { gameState: afterPayment, transaction } = applyTransaction(gameState, {
    fromPlayerId: bank.id,
    toPlayerId: player.id,
    amount,
    transactionType,
  });

  const properties = afterPayment.properties.map((p) =>
    p.id === property.id ? { ...p, upgradeLevel: newLevel } : p
  );

  // Phase 14 (2026-08-19): the inverse of handleBuildHouse's own supply
  // accounting — selling off a hotel returns the hotel piece and takes real
  // houses back out of the shared pool for it; every other sell just returns
  // 1 house.
  //
  // FIXED 2026-08-25 (found by fuzzing, reproduced at houseSupply -2 with 34
  // houses standing against a 32-house set). This used to take a flat 4
  // houses out for every hotel downgrade with no check that 4 existed,
  // driving houseSupply negative and breaking the physical-set invariant.
  //
  // The fix deliberately does NOT reject the sale when the pool is short.
  // Rejecting was the obvious option and is the dangerous one: SELL_HOUSE is
  // a legal LIQUIDATION_REQUIRED action, so blocking it could leave a player
  // unable to raise cash they demonstrably have and force a *wrong*
  // bankruptcy — strictly worse than the accounting drift it would prevent.
  // Instead the property drops straight past the levels there are no pieces
  // for (`housesPlaceable` above), taking whatever the pool holds, and the
  // player is paid for every level actually removed. Never blocks, never
  // over-draws the set, and the seller is not short-changed.
  //
  // The aggregate liquidation estimate stays honest either way:
  // bankruptcy.js's houseSellBackValue prices all `upgradeLevel` levels at
  // the same per-level rate, so a property stripped 5->2 pays 3 levels now
  // and the remaining 2 later — the same total checkSolvency assumed.
  const housesReturned = isHotelDowngrade ? -housesPlaceable : 1;
  const houseSupply = afterPayment.houseSupply + housesReturned;
  const hotelSupply = afterPayment.hotelSupply + (isHotelDowngrade ? 1 : 0);

  return {
    gameState: { ...afterPayment, properties, houseSupply, hotelSupply, phase: 'POST_ACTIONS' },
    transactions: [transaction],
  };
}

/**
 * MORTGAGE — precondition is group-wide, not just the target property (see
 * this file's SCOPE comment above and GAME_DESIGN_SPEC.md §12's
 * `[REVISED 2026-08-18]` note): no property sharing this tile's groupId
 * (including itself) may have upgradeLevel > 0. Checks the target directly
 * first (covers ungrouped tiles — transport/utility, or a property/tile
 * with no groupId assigned — correctly, since groupHoldingsFor returns `[]`
 * for those and the self-check alone is then the whole rule), then every
 * other group member via groupHoldingsFor.
 */
function handleMortgage(gameState, boardTiles, action) {
  const player = getCurrentPlayer(gameState);
  const property = gameState.properties.find((p) => p.id === action.payload?.propertyId);
  if (!property) {
    throw new TypeError(`handleMortgage: no property found for propertyId '${action.payload?.propertyId}'`);
  }

  const tile = boardTiles.find((t) => t.id === property.boardTileId);
  if (!tile) {
    throw new TypeError(`handleMortgage: propertyId '${property.id}' has no matching tile`);
  }

  if (property.ownerId !== player.id) {
    throw new InvalidPropertyActionError('NOT_OWNER', `handleMortgage: '${player.id}' does not own property '${property.id}'`);
  }

  if (property.mortgaged) {
    throw new InvalidPropertyActionError('ALREADY_MORTGAGED', `handleMortgage: property '${property.id}' is already mortgaged`);
  }

  // Per-property as of 2026-09-02 (reverted from the 2026-08-18 group-wide
  // form — see this file's SCOPE comment and GAME_DESIGN_SPEC.md §12): only
  // the target tile itself must be house-free. Mortgaging one bare lot while
  // its group-mates stay built already costs the ×2 group bonus on the whole
  // group (calculateRent.js's hasGroupBonus needs every member unmortgaged),
  // so this is a real trade-off the player owns, not a loophole.
  if (property.upgradeLevel > MIN_UPGRADE_LEVEL) {
    throw new InvalidPropertyActionError(
      'PROPERTY_HAS_HOUSES',
      `handleMortgage: property '${property.id}' still has houses — sell them first`
    );
  }

  const { amount, transactionType } = calculateMortgage(tile);
  const bank = getBankPlayer(gameState);
  const { gameState: afterPayment, transaction } = applyTransaction(gameState, {
    fromPlayerId: bank.id,
    toPlayerId: player.id,
    amount,
    transactionType,
  });

  const properties = afterPayment.properties.map((p) => (p.id === property.id ? { ...p, mortgaged: true } : p));

  return { gameState: { ...afterPayment, properties, phase: 'POST_ACTIONS' }, transactions: [transaction] };
}

/**
 * UNMORTGAGE — the only group-agnostic action of the four; classic Monopoly
 * (and GAME_DESIGN_SPEC.md §12, unrevised for this direction) never gates
 * unmortgaging on the rest of the group's state, only on this property's
 * own mortgaged flag and the payer's own funds.
 */
function handleUnmortgage(gameState, boardTiles, action) {
  const player = getCurrentPlayer(gameState);
  const property = gameState.properties.find((p) => p.id === action.payload?.propertyId);
  if (!property) {
    throw new TypeError(`handleUnmortgage: no property found for propertyId '${action.payload?.propertyId}'`);
  }

  const tile = boardTiles.find((t) => t.id === property.boardTileId);
  if (!tile) {
    throw new TypeError(`handleUnmortgage: propertyId '${property.id}' has no matching tile`);
  }

  if (property.ownerId !== player.id) {
    throw new InvalidPropertyActionError('NOT_OWNER', `handleUnmortgage: '${player.id}' does not own property '${property.id}'`);
  }

  if (!property.mortgaged) {
    throw new InvalidPropertyActionError('NOT_MORTGAGED', `handleUnmortgage: property '${property.id}' is not mortgaged`);
  }

  const { amount, transactionType } = calculateUnmortgage(tile);
  if (player.currentBalance < amount) {
    throw new InvalidPropertyActionError(
      'INSUFFICIENT_BALANCE',
      `handleUnmortgage: balance ${player.currentBalance} is less than the unmortgage cost ${amount}`
    );
  }

  const bank = getBankPlayer(gameState);
  const { gameState: afterPayment, transaction } = applyTransaction(gameState, {
    fromPlayerId: player.id,
    toPlayerId: bank.id,
    amount,
    transactionType,
  });

  const properties = afterPayment.properties.map((p) => (p.id === property.id ? { ...p, mortgaged: false } : p));

  return { gameState: { ...afterPayment, properties, phase: 'POST_ACTIONS' }, transactions: [transaction] };
}

/**
 * HOSTILE_BUYOUT — Phase 14 design (2026-08-19), BOARD_SPECIFICATION.md's
 * "Hostile Property Acquisition" now confirmed adopted, implemented per
 * this task's own explicit brief: fully unilateral (no owner
 * response/defense-fee window, no turn-number gate — both were part of an
 * earlier, still-`[PROPOSED]` sketch in that doc, deliberately not carried
 * over here since the fresh brief didn't ask for either; flagged, not
 * silently added or silently dropped).
 *
 * No propertyId in the payload — unlike BUILD_HOUSE/SELL_HOUSE/MORTGAGE/
 * UNMORTGAGE, the target is never a free client choice, only ever
 * gameState.pendingHostileBuyoutPropertyId (the property the current
 * player themselves just paid rent on this same turn — resolveLanding's
 * own PAYING_RENT case is the only place that ever sets it). A client
 * payload naming some *other* property would just be ignored; there's
 * nothing to validate because there's nothing to read.
 */
function handleHostileBuyout(gameState, boardTiles) {
  const player = getCurrentPlayer(gameState);
  const propertyId = gameState.pendingHostileBuyoutPropertyId;
  if (!propertyId) {
    throw new InvalidPropertyActionError(
      'NO_PENDING_BUYOUT',
      'handleHostileBuyout: no property is currently eligible for a hostile buyout'
    );
  }

  const property = gameState.properties.find((p) => p.id === propertyId);
  const tile = boardTiles.find((t) => t.id === property.boardTileId);

  // Re-validate WHO owns it right now, not just that a buyout is pending
  // (2026-08-25, found by fuzzing the trade subsystem). pendingHostileBuyoutPropertyId
  // is set the moment rent is paid, but trades and FORFEIT_MATCH are both
  // deliberately phase-independent — so ownership can legitimately change
  // between the rent payment and the buyout click, within the same turn:
  //   - the buyer TRADES the property from its owner first, then clicks
  //     buyout -> applyTransaction(self -> self) threw
  //     "fromPlayerId and toPlayerId must differ", a hard crash;
  //   - the owner FORFEITS (or is bankrupted by an out-of-turn card charge)
  //     first, reverting the property to unowned -> a buyout paying `null`.
  // Both are now clean domain rejections instead. The window is short but
  // entirely real, and neither case was checked anywhere before this.
  if (property.ownerId === player.id) {
    throw new InvalidPropertyActionError(
      'ALREADY_OWNED',
      `handleHostileBuyout: '${player.id}' already owns property '${property.id}' — nothing to acquire`
    );
  }
  if (property.ownerId === null) {
    throw new InvalidPropertyActionError(
      'NOT_OWNED',
      `handleHostileBuyout: property '${property.id}' is no longer owned by anyone — buy it normally instead`
    );
  }

  // "CANNOT be performed if the target property belongs to a completed
  // Full Set" — the brief's own restriction, protecting late-game
  // monopolies. Reuses groupHoldingsFor()'s exact full-group-ownership
  // shape BUILD_HOUSE/MORTGAGE already established, rather than
  // reinventing a second version of the same check.
  const groupHoldings = groupHoldingsFor(gameState, boardTiles, tile);
  const isFullSet = groupHoldings.length > 0 && groupHoldings.every((h) => h.property?.ownerId === property.ownerId);
  if (isFullSet) {
    throw new InvalidPropertyActionError(
      'MONOPOLY_PROTECTED',
      `handleHostileBuyout: property '${property.id}' belongs to a completed color-group monopoly, protected from hostile buyout`
    );
  }

  // User requirement: properties with ANY houses cannot be taken over
  if (property.upgradeLevel > 0) {
    throw new InvalidPropertyActionError(
      'HOUSE_PROTECTED',
      `handleHostileBuyout: property '${property.id}' has houses built, protected from hostile buyout`
    );
  }

  // C08 "Bảo Vệ Tài Sản" (card deck v2, 2026-08-25) — the temporary,
  // card-granted equivalent of the permanent HOUSE_PROTECTED rule above.
  // This is the ONLY thing the card does, and the only card in the deck that
  // touches this mechanic at all.
  if (protectionIsLive(gameState, property.id)) {
    throw new InvalidPropertyActionError(
      'CARD_PROTECTED',
      `handleHostileBuyout: property '${property.id}' is protected by C08 until its owner's next turn`
    );
  }

  // "2.0x the total current value (Purchase Price + Total Cost of all
  // Buildings currently on it)" — calculateBuildHouse()'s own cost is a
  // flat tile.houseCost per build regardless of the resulting
  // upgradeLevel (confirmed by reading it, not assumed), so "total cost of
  // buildings" is uniformly upgradeLevel × houseCost — including a hotel
  // (upgradeLevel 5), which cost exactly 5 such builds to reach, no
  // separate hotel price exists anywhere in this economy. currentValue is
  // always an integer × 2 here — unlike the mortgage-interest (×1.1)
  // formula finding #26 had to guard against, doubling an integer is
  // exact in JS, no IEEE-754 rounding risk, no Math.ceil needed.
  const currentValue = tile.price + property.upgradeLevel * tile.houseCost;
  const buyoutCost = currentValue * HOSTILE_BUYOUT_MULTIPLIER;

  if (player.currentBalance < buyoutCost) {
    throw new InvalidPropertyActionError(
      'INSUFFICIENT_BALANCE',
      `handleHostileBuyout: balance ${player.currentBalance} is less than the buyout cost ${buyoutCost}`
    );
  }

  // Player-to-player, not the Bank — ECONOMY_SPECIFICATION.md's own row
  // for this mechanic: "player-to-player, not the Bank, since it's a
  // forced purchase from another player". Direct applyTransaction(), not
  // applyIntents() — finding #24's own lesson (applyIntents is
  // Bank-mediated only; a genuine direct transfer needs applyTransaction),
  // same precedent the Trade System and jail-fine paths already follow.
  const { gameState: afterPayment, transaction } = applyTransaction(gameState, {
    fromPlayerId: player.id,
    toPlayerId: property.ownerId,
    amount: buyoutCost,
    transactionType: 'hostile_acquisition',
  });

  // acquiredAtRound reset here too, same reasoning as handleBuyProperty's own
  // (RECENTLY_ACQUIRED, property.js) — the buyer just took possession exactly
  // as freshly as a real purchase would, and every hostile-buyout target is by
  // definition at upgradeLevel 0 (HOUSE_PROTECTED already excludes anything
  // higher), so without this reset the new owner could immediately build to
  // re-protect it against a further hostile buyout in the very same turn.
  const properties = afterPayment.properties.map((p) =>
    p.id === property.id ? { ...p, ownerId: player.id, acquiredAtRound: gameState.roundNumber } : p
  );

  // Drop any live trade that offers the property just seized (2026-08-25,
  // found by fuzzing). The trade system's own asset-locking only guards
  // against the same property being offered in two TRADES — it has no
  // visibility into a hostile buyout, which is a completely separate path.
  // Without this, a pending trade kept advertising a property its offering
  // side no longer owned: contained (acceptTrade re-validates ownership and
  // would reject it) but visibly wrong, and it kept the counterparty's own
  // assets needlessly locked until the trade expired. applyBankruptcy
  // already prunes pendingTrades on exactly this kind of forced ownership
  // change; this now matches, rather than the two transfer paths disagreeing.
  const pendingTrades = afterPayment.pendingTrades.filter(
    (t) => !t.proposerOffer?.properties?.includes(property.id) && !t.targetOffer?.properties?.includes(property.id)
  );

  // Same hygiene as the pendingTrades pruning above: a protection naming the
  // seized property now names an owner who no longer holds it. protectionIsLive
  // already refuses to honour that (it re-checks ownership), so this is not
  // load-bearing for correctness — it just stops a dead reference lingering in
  // state that anything reading the raw field could misread.
  const protectionAfterSeizure =
    afterPayment.propertyProtection?.propertyId === property.id ? null : afterPayment.propertyProtection;

  return {
    gameState: {
      ...afterPayment,
      properties,
      pendingTrades,
      propertyProtection: protectionAfterSeizure,
      pendingHostileBuyoutPropertyId: null,
      phase: 'POST_ACTIONS',
    },
    transactions: [transaction],
  };
}

function handleDeclineHostileBuyout(gameState) {
  return { gameState: { ...gameState, pendingHostileBuyoutPropertyId: null, phase: 'POST_ACTIONS' }, transactions: [] };
}

/**
 * GAMBLE_RENT — Rent Risk Choice, REVISED 2026-08-25 (real user correction:
 * "người vào đất chỉ mất x1 số tiền thôi chứ sao lại mất x2 và không cần
 * chờ người khác quyết định chọn gì" — the payer should only ever owe the
 * fixed standard rent, and shouldn't have to wait on anyone else's
 * decision). The property OWNER's OPTIONAL, non-blocking follow-up on
 * `gameState.pendingRentGamble` — set by resolveLanding's PAYING_RENT case
 * right after rent has ALREADY settled in full, unlike the old
 * RENT_RISK_DECISION phase this replaces. Legal at any time, in any phase
 * (dispatched from transitionTurn() BEFORE its VALID_ACTIONS_BY_PHASE gate,
 * the exact same "needs to work no matter what phase the game is in"
 * precedent FORFEIT_MATCH/trade actions already established) — nothing
 * blocks waiting for this, which is the entire point of the revision.
 *
 * Bets the `amount` the owner already collected against the Bank, not
 * against the payer, who is never touched again once their own payment
 * settled: `action.payload.gambleRoll < 0.5` wins ANOTHER `amount` from the
 * Bank (their total take from this rent event doubles); otherwise the owner
 * pays the `amount` back to the Bank (they end with nothing from this
 * event). Either way this is unconditionally a real `applyTransaction` —
 * unlike the old zero-amount case (a lost Gamble settling literally no
 * transaction, since the payer's amount could genuinely be zero), the
 * amount gambled here is always positive (resolveLanding never sets this
 * field for a $0 rent event in the first place).
 *
 * `action.payload.gambleRoll` is always server-generated by
 * socketServer.js's serverGeneratedFields — the same "randomness lives at
 * the impure Socket.IO layer, injected after the client's own payload,
 * never trusted from a client" treatment ROLL_DICE/MAKE_EVENT_CHOICE's own
 * randomness already got (finding #27). `action.payload.playerId` (the
 * sender's real resolved identity) must match the pending offer's ownerId —
 * no system-synthesized-default exception exists any more (that was only
 * ever needed for a forfeiting owner mid-BLOCKING-decision; this offer is
 * non-blocking, so applyBankruptcy() just drops it unclaimed instead, see
 * that function's own comment).
 */
function handleGambleRent(gameState, boardTiles, action, now) {
  const pending = gameState.pendingRentGamble;
  if (!pending) {
    throw new InvalidPropertyActionError('NO_PENDING_RENT_GAMBLE', 'handleGambleRent: no rent gamble is currently available to act on');
  }
  const { ownerId, amount } = pending;

  if (action.payload?.playerId !== ownerId) {
    throw new InvalidPropertyActionError(
      'NOT_OWNER',
      `handleGambleRent: sender is not the owner ('${ownerId}') this rent gamble belongs to`
    );
  }

  const owner = gameState.players.find((p) => p.id === ownerId);
  // "You can only gamble money you still have" — the owner collected
  // `amount` when rent settled, but this is a real, non-blocking, whenever-
  // you-like action: by the time they choose to use it, an unrelated action
  // (building, mortgaging, ...) could already have spent that exact cash.
  // Rejecting here, rather than letting a losing roll drive them negative,
  // is what economy/applyTransaction.js's own hard non-negative invariant
  // (finding #39) now requires of every caller — the same affordability
  // check BUILD_HOUSE/UNMORTGAGE/HOSTILE_BUYOUT each already do before
  // spending a player's money.
  if (owner.currentBalance < amount) {
    throw new InvalidPropertyActionError(
      'INSUFFICIENT_BALANCE',
      `handleGambleRent: owner's balance ${owner.currentBalance} is less than the ${amount} being gambled`
    );
  }

  const cleared = { ...gameState, pendingRentGamble: null };
  const bank = getBankPlayer(cleared);
  const won = action.payload.gambleRoll < 0.5;

  const { gameState: afterGamble, transaction } = applyTransaction(cleared, {
    fromPlayerId: won ? bank.id : ownerId,
    toPlayerId: won ? ownerId : bank.id,
    amount,
    transactionType: 'rent_gamble',
  });

  return { gameState: afterGamble, transactions: [transaction] };
}

/**
 * Card Inventory system (2026-08-27) — USE_INVENTORY_CARD action.
 * Allows playing kept cards out-of-turn or in-turn.
 */
function handleUseInventoryCard(gameState, boardTiles, action, now) {
  const { cardId, playerId, optionId, probabilityRoll, dieFaceRoll, propertyId } = action.payload;
  const player = gameState.players.find((p) => p.id === playerId);

  // Defensive, and NOT dead code: this action is turn-independent (see
  // socketServer.js's TURN_INDEPENDENT_ACTION_TYPES), so unlike every
  // phase-gated handler it can't lean on getCurrentPlayer() having already
  // resolved a real player.
  if (!player) {
    throw new InvalidInventoryActionError('NOT_A_PARTICIPANT', `handleUseInventoryCard: no player '${playerId}' in this game`);
  }

  // An eliminated player must not act. Turn-independent actions bypass the
  // turn/phase gates that enforce this implicitly everywhere else — exactly
  // the hole found in the trade path on 2026-08-25 (a solvent player gifting
  // property to a bankrupt one, resurrecting them mid-match). Same class of
  // gap, closed here before making this action genuinely out-of-turn.
  if (player.bankrupt) {
    throw new InvalidInventoryActionError('PLAYER_BANKRUPT', `handleUseInventoryCard: player ${playerId} is bankrupt and cannot act`);
  }

  // `?? []` is load-bearing, not defensive noise — same reason
  // resolveDrawingCard's own `(player.inventory || [])` is: a match already
  // in progress when the Card Inventory system shipped (2026-08-27) is
  // restored by gameRepository.js's loadGameStateFromSupabase(), which
  // returns the raw JSONB blob and deliberately does NOT re-run it through
  // createPlayerGameState() — so the factory's `inventory: [] ` default
  // never applies and this field is genuinely `undefined` there. Without
  // this, every such match crashed with a bare TypeError on the first use.
  const inventory = player.inventory ?? [];
  if (!inventory.includes(cardId)) {
    throw new InvalidInventoryActionError('CARD_NOT_HELD', `handleUseInventoryCard: player ${playerId} does not have card ${cardId}`);
  }

  const card = EVENT_CARDS[cardId];
  if (!card) {
    throw new TypeError(`handleUseInventoryCard: Unknown card ${cardId}`);
  }

  // Gate on the card's own `keepable` flag, not merely on it being present
  // in a hand. Inventory membership is a *consequence* of keepable (see
  // resolveDrawingCard); treating it as the rule instead means any card that
  // ever reached a hand — through a future mechanic, a hand-edited snapshot,
  // or a `keepable` flag later removed from a card — stays playable from it
  // forever, out of turn and out of phase. Verified reachable: a non-keepable
  // card seeded into `inventory` resolved its full effect before this check.
  if (!card.keepable) {
    throw new InvalidInventoryActionError('CARD_NOT_KEEPABLE', `handleUseInventoryCard: card ${cardId} is not a keepable card`);
  }

  if (!cardEligible(card, player, gameState)) {
    throw new InvalidInventoryActionError('NOT_ELIGIBLE', `handleUseInventoryCard: player ${playerId} is no longer eligible to use ${cardId}`);
  }

  const newInventory = [...inventory];
  newInventory.splice(newInventory.indexOf(cardId), 1);
  const stateWithoutCard = replacePlayer(gameState, { ...player, inventory: newInventory });

  let intents = [];
  if (card.type === 'INSTANT') {
    intents = evaluateEvent(card);
  } else {
    intents = resolveChoice(stateWithoutCard, playerId, card, optionId, probabilityRoll, dieFaceRoll);
  }

  const protectIntent = intents.find((i) => i.action === 'GRANT_PROPERTY_PROTECTION');
  if (protectIntent) {
    const eligible = protectablePropertiesFor(stateWithoutCard, playerId);
    if (eligible.length === 0) {
      return { gameState: stateWithoutCard, transactions: [] };
    }
    if (!eligible.some((p) => p.id === propertyId)) {
      throw new InvalidPropertyActionError('NOT_PROTECTABLE', `handleUseInventoryCard: property '${propertyId}' is not protectable`);
    }
    return {
      gameState: {
        ...stateWithoutCard,
        propertyProtection: { propertyId, ownerId: playerId, grantedAtRound: stateWithoutCard.roundNumber },
        ...(dieFaceRoll ? { 
          lastRoll: { die1: dieFaceRoll, die2: 0, total: dieFaceRoll, isDouble: false },
          lastRollSeq: (stateWithoutCard.lastRollSeq ?? 0) + 1
        } : {})
      },
      transactions: []
    };
  }

  const { gameState: afterIntents, transactions, pendingDebts } = applyIntents(stateWithoutCard, boardTiles, intents, 'event_card', playerId);
  
  let finalState = afterIntents;
  if (dieFaceRoll) {
    finalState = {
      ...finalState,
      lastRoll: { die1: dieFaceRoll, die2: 0, total: dieFaceRoll, isDouble: false },
      lastRollSeq: (finalState.lastRollSeq ?? 0) + 1
    };
  }
  
  // None of the current keepable cards create debts, but we route through settlePendingDebts just in case.
  // We don't alter the current phase, so it safely returns to whatever the match was doing.
  return settlePendingDebts(finalState, boardTiles, transactions, pendingDebts, now);
}

/**
 * @param {import('../domain/gameState.js').GameState} gameState
 * @param {import('../domain/tile.js').Tile[]} boardTiles - the full tile set for gameState.boardId, static config (loadBoard.js is blocked; caller supplies this)
 * @param {{ type: string, payload?: any }} action
 * @param {string} [now] - ISO timestamp, only consulted where a real one is genuinely needed (property.acquiredAt on purchase) — never read internally, so this function stays a pure (gameState, boardTiles, action, now) -> output mapping
 * @returns {{ gameState: import('../domain/gameState.js').GameState, transactions: object[] }}
 * @throws {InvalidTurnActionError}
 */
export function transitionTurn(gameState, boardTiles, action, now) {
  // FORFEIT_MATCH (2026-08-23) — deliberately checked before the phase gate
  // below, same "this needs to work in any phase" precedent trade actions
  // already established (see resolveForfeit's own header) — a player must
  // be able to quit regardless of what VALID_ACTIONS_BY_PHASE says about
  // the current phase.
  if (action.type === 'FORFEIT_MATCH') {
    return resolveForfeit(gameState, boardTiles, action, now);
  }

  // GAMBLE_RENT (Rent Risk Choice, REVISED 2026-08-25) — same "this needs to
  // work in any phase" precedent as FORFEIT_MATCH directly above: the
  // owner's optional gamble on rent they already collected is a non-
  // blocking side action, not a phase of its own, so it can arrive whenever
  // the owner chooses regardless of what the rest of the table is doing.
  if (action.type === 'GAMBLE_RENT') {
    return handleGambleRent(gameState, boardTiles, action, now);
  }

  // USE_INVENTORY_CARD (Card Inventory System, 2026-08-27)
  if (action.type === 'USE_INVENTORY_CARD') {
    return handleUseInventoryCard(gameState, boardTiles, action, now);
  }

  const allowed = VALID_ACTIONS_BY_PHASE[gameState.phase];
  if (!allowed || !allowed.includes(action.type)) {
    throw new InvalidTurnActionError(gameState.phase, action.type);
  }

  switch (gameState.phase) {
    case 'TURN_START':
      return { gameState: startTurn(gameState), transactions: [] };

    case 'JAIL_DECISION':
      return handleJailAction(gameState, boardTiles, action, now);

    case 'ROLLING':
      return moveAndResolve(gameState, boardTiles, getCurrentPlayer(gameState).id, action.payload, now);

    case 'PLAYING_CARD':
      return handlePlayMovementCard(gameState, boardTiles, action, now);

    case 'AWAITING_PURCHASE':
      if (action.type === 'BUY_PROPERTY') {
        return handleBuyProperty(gameState, boardTiles, now);
      }
      if (action.type === 'FORCE_AUCTION') {
        return handleForceAuction(gameState, boardTiles, action);
      }
      // SKIP_PURCHASE + DECLINE_PURCHASE (legacy alias) — both free, straight to POST_ACTIONS
      return handleSkipPurchase(gameState);

    case 'AWAITING_UPGRADE':
      if (action.type === 'BUILD_HOUSE') {
        return handleBuildHouse(gameState, boardTiles, action);
      }
      return handleDeclineUpgrade(gameState); // DECLINE_UPGRADE

    case 'FLASH_AUCTION_ACTIVE':
      return handleAuctionAction(gameState, boardTiles, action, now);

    case 'AWAITING_EVENT_CHOICE':
      return handleEventChoice(gameState, boardTiles, action, now);

    case 'POST_ACTIONS':
      if (action.type === 'BUILD_HOUSE') {
        return handleBuildHouse(gameState, boardTiles, action);
      }
      if (action.type === 'SELL_HOUSE') {
        return handleSellHouse(gameState, boardTiles, action);
      }
      if (action.type === 'MORTGAGE') {
        return handleMortgage(gameState, boardTiles, action);
      }
      if (action.type === 'UNMORTGAGE') {
        return handleUnmortgage(gameState, boardTiles, action);
      }
      if (action.type === 'HOSTILE_BUYOUT') {
        return handleHostileBuyout(gameState, boardTiles);
      }
      if (action.type === 'DECLINE_HOSTILE_BUYOUT') {
        return handleDeclineHostileBuyout(gameState);
      }
      // END_TURN — GAME_DESIGN_SPEC.md §25's missedTurnStreak, wired
      // 2026-08-21: action.isSystemDefault (set only by socketServer.js's
      // handleTurnTimeout, never by a real client) distinguishes a genuine
      // click from a POST_ACTIONS timeout synthesizing this exact same
      // action shape. Updated on the outgoing current player before
      // advanceTurn() moves currentTurnIndex off them — the one place this
      // needs checking, not threaded into advanceTurn() itself, which has
      // 4 other call sites this deliberately narrower pass doesn't cover
      // (see missedTurnStreak's own JSDoc, domain/gameState.js, for the
      // exact scope this covers vs. doesn't).
      {
        const endingPlayer = getCurrentPlayer(gameState);
        const missedTurnStreak = action.isSystemDefault ? endingPlayer.missedTurnStreak + 1 : 0;
        const stateWithStreak = replacePlayer(gameState, { ...endingPlayer, missedTurnStreak });
        return advanceTurn(stateWithStreak, boardTiles, now);
      }

    // Win Condition design (2026-08-19) — see VALID_ACTIONS_BY_PHASE's own
    // comment and resolveLiquidationStep()'s header for why SELL_HOUSE/
    // MORTGAGE are reused verbatim here rather than duplicated.
    case 'LIQUIDATION_REQUIRED': {
      const inner =
        action.type === 'SELL_HOUSE' ? handleSellHouse(gameState, boardTiles, action) : handleMortgage(gameState, boardTiles, action);
      return resolveLiquidationStep(inner.gameState, inner.transactions, boardTiles, now);
    }

    default:
      throw new InvalidTurnActionError(gameState.phase, action.type);
  }
}




