// PlayerGameState + GameState — GAME_DESIGN_SPEC.md §2 (match lifecycle),
// GAME_STATE_MACHINE.md (turn-phase state machine), backend/supabase/
// migrations/0001_core_tables.sql (`games`, `game_players`,
// `game_state_snapshots`). Pure data shapes: no I/O, no database driver, no
// framework import, no runtime import at all — GameState.players/properties
// reference Property (property.js) only in JSDoc type annotations, which
// have no runtime effect.

// games.status — the game's own lifecycle, once it exists. Deliberately NOT
// GAME_DESIGN_SPEC.md §2's mermaid labels (Waiting/ReadyCheck/Starting/...):
// that diagram covers the combined room+game lifecycle, including pre-game
// room states (rooms.status) that exist before a GameState is ever
// instantiated. This is the narrower, already-shipped games.status enum.
export const GAME_STATUSES = Object.freeze(['in_progress', 'ending', 'finished', 'aborted']);

// Turn-phase sub-state machine, GAME_STATE_MACHINE.md's core diagram.
// Stale note from when this list predated Flash Auction/Rent Risk
// Choice/Hostile Acquisition all being confirmed and shipped, corrected
// 2026-08-25 rather than left silently wrong: FLASH_AUCTION_ACTIVE is a
// real member below; Hostile Acquisition never needed a phase of its own
// (POST_ACTIONS' own pendingHostileBuyoutPropertyId); RENT_RISK_DECISION
// was a real member too, then REMOVED the same day this note was
// corrected — Rent Risk Choice's GAMBLE_RENT is a non-blocking side action
// now, not a phase (see turnMachine.js's resolveLanding for the real user
// correction that drove it).
//
// Listed in the turn's actual chronological order. TURN_START/JAIL_DECISION/
// ROLLING were missing from this list until P05-T04 — found while
// implementing jail.js, whose JAIL_DECISION precondition (GAME_STATE_MACHINE.md)
// this enum should have already covered; patched here rather than left
// silently incomplete.
export const GAME_PHASES = Object.freeze([
  // (ASYMMETRIC only) Draft Phase, ASYMMETRIC_MODE_SPEC.md §1.3 —
  // engine/draftPhase.js. Entered once, before Turn 1's own TURN_START, by
  // initializeGameState() (room.controller.js) setting the match's initial
  // phase directly to this instead of 'TURN_START' when ruleset ===
  // 'ASYMMETRIC'. Never re-entered once it exits (to 'TURN_START'). CLASSIC
  // matches never see this phase at all.
  'DRAFTING_ACTIVE',
  'TURN_START',
  'JAIL_DECISION', // only entered when the current player is in jail; otherwise TURN_START goes straight to ROLLING
  'PLAYING_CARD', // (ASYMMETRIC only) Chọn bài di chuyển hoặc đặt bẫy thay vì đổ xúc xắc
  'ROLLING',
  'MOVING',
  'LANDING',
  'AWAITING_PURCHASE',
  // Added to this list 2026-08-23 (finding #35). The phase itself is NOT
  // new — engine/resolveTile.js has returned it, turnMachine.js has handled
  // it, and VALID_ACTIONS_BY_PHASE has gated it (BUILD_HOUSE/DECLINE_UPGRADE)
  // for a long time; it was simply never added to this enum. Latent rather
  // than crashing so far, because every turn transition builds state with a
  // plain object spread and gameRepository.js's snapshot restore returns the
  // raw JSONB blob — neither route reaches createGameState()'s own
  // `Unknown phase` guard below. It would have thrown the moment anything
  // did.
  'AWAITING_UPGRADE',
  'FLASH_AUCTION_ACTIVE', // entered from AWAITING_PURCHASE's decline path — GAME_STATE_MACHINE.md §3, Auction V1. Added when turnMachine.js first started transitioning here; no bid/fold/settle action is wired into VALID_ACTIONS_BY_PHASE yet, a deliberate stop like DRAWING_CARD once was
  'PAYING_RENT',
  // RENT_RISK_DECISION removed 2026-08-25 — see gameState's own
  // pendingRentGamble JSDoc below for the real user correction that
  // replaced this phase. Rent settles the instant PAYING_RENT resolves
  // again, same as before that mechanic existed; nothing blocks on the
  // owner's decision any more, so there is no phase for it to sit in.
  'DRAWING_CARD',
  'AWAITING_EVENT_CHOICE', // entered from DRAWING_CARD when the drawn card is type 'CHOICE' (domain/eventDictionary.js) — not in any approved doc, same standing as FLASH_AUCTION_ACTIVE's V1 rules
  'PAYING_TAX',
  'BANKRUPTCY_CHECK',
  'LIQUIDATION_REQUIRED', // GAME_DESIGN_SPEC.md §16 (bankruptcy liquidation flow) is itself an open design decision — this phase name may change once that's resolved
  'POST_ACTIONS',
  'END_TURN',
]);

// Phase 14 design (2026-08-19): GAME_DESIGN_SPEC.md §12's own named
// constants, now confirmed enforced (was `[OPEN DESIGN DECISION]` — "many
// digital adaptations skip it... classic physical Monopoly enforces it").
// Classic physical set — 32 houses, 12 hotels, shared across all players,
// not per-player.
export const HOUSE_SUPPLY_TOTAL = 32;
export const HOTEL_SUPPLY_TOTAL = 12;

/**
 * @typedef {Object} PlayerGameState
 * @property {string} id - uuid, game_players.id
 * @property {string} gameId - game_players.game_id
 * @property {string|null} playerId - FK to profiles.id; null only for the Bank sentinel row (isBank true)
 * @property {boolean} isBank - true for exactly one game_players row per game, the Bank (DATABASE_DESIGN.md / 0001's CHECK: isBank XOR playerId present)
 * @property {number|null} turnOrder
 * @property {number|null} startingBalance
 * @property {number} currentBalance - denormalized/cached; true source of truth is SUM(game_transactions) for this row (DATABASE_DESIGN.md §5)
 * @property {number} currentPosition - denormalized/cached, same caveat as currentBalance
 * @property {boolean} inJail
 * @property {number} jailTurns
 * @property {boolean} bankrupt
 * @property {string|null} bankruptAt - ISO timestamp
 * @property {number|null} finalRank
 * @property {number|null} finalNetWorth - set once, at game end, alongside finalRank (gameEndMachine.js's rankPlayers()'s own netWorth figure) — 0 for a bankrupt player, never recomputed after
 * @property {number|null} finalCash - finalNetWorth's cash component; frontend Game Over breakdown line only, no game logic reads this
 * @property {number|null} finalPropertyValue - finalNetWorth's property component; same as finalCash, display-only
 * @property {number} missedTurnStreak - GAME_DESIGN_SPEC.md §25's AFK_THRESHOLD_MISSED_TURNS tracking, wired 2026-08-21. Incremented when this player's own END_TURN was system-synthesized (a POST_ACTIONS timeout — action.isSystemDefault, see turnMachine.js's END_TURN case), reset to 0 on a genuine END_TURN. At `>= AFK_THRESHOLD_MISSED_TURNS` (3) the player is considered AFK — a raw counter, not a separate boolean, so nothing can drift out of sync with it. **Scope note**: only the POST_ACTIONS→END_TURN path is tracked (the dominant "did nothing all turn" case) — a turn that ends via a rarer synthesized path (a forced 3rd jail-roll failure, a 3rd-consecutive-double) doesn't increment this; and reaching the threshold does not yet skip/auto-resolve future turns any faster than the existing per-phase timers already do (GAME_STATE_MACHINE.md §5's per-phase timeout already bounds every phase regardless of connection status — see timers.js's TURN_START entry, also new this pass) — both flagged as deliberate, narrower-than-the-full-spec scope, not silent gaps
 * @property {string|null} zodiac - domain/zodiac.js's own ZODIAC_KEYS (2026-08-22); assigned once at game start (room.controller.js's initializeGameState) from the player's lobby pick (room_players.zodiac) or a random key when they never chose. Duplicates across players are allowed by design — playerColor() (frontend) is what distinguishes them, not the animal. Always null for the Bank sentinel row.
 * @property {number} jailFreeCards - 2026-08-22, closes a real pre-existing gap: engine/jail.js's useCard() has always let a player "use" a Get Out of Jail Free card unconditionally, since PlayerGameState had no inventory field for it to check (that file's own docstring said so explicitly). A raw count, not a boolean — GRANT_JAIL_CARD event-card intents can in principle stack more than one. Always 0 for the Bank sentinel row.
 * @property {number} nextBuildDiscount - 2026-08-22 (the 24-card deck, C07 "Giảm Giá Xây Dựng" -$50 / C12 option B -$100): a one-shot per-player discount consumed by the *next* BUILD_HOUSE this player successfully completes (handleBuildHouse resets it to 0 immediately after), stacking additively with GameState.buildCostModifierAmount's own separate global/round-scoped modifier at the same call site. 0 = none pending.
 * @property {{percent: number, max: number}|null} nextRentDiscount - companion to nextBuildDiscount: C12 option C ("giảm 50%, tối đa $150") — consumed by the *next* rent payment this player owes as the payer (settleDebt's own PAYING_RENT-derived call, not GameState.rentModifierPercent's unrelated owner-side global modifier), clearing back to null immediately after. `max` caps the absolute discount amount, not the resulting rent.
 * @property {string[]} inventory - 2026-08-27 (Card Inventory system): IDs of keepable event cards this player holds in their hand to play later.
 * @property {string[]} movementHand - [ASYMMETRIC] Danh sách thẻ di chuyển trên tay (tối đa 3 thẻ)
 * @property {string[]} activePerks - [ASYMMETRIC] Legacy field, no longer read by any engine code. Synergies are DERIVED from holdings (engine/synergyEngine.js) rather than stored, so a trade/auction/buyout/bankruptcy can never leave a stale perk behind. Kept only so existing snapshots deserialize.
 * @property {{viewerId: string, untilRound: number, scope: 'FULL'|'NEXT_CARD'}[]} handRevealedTo - [ASYMMETRIC] DENIAL (§3.1): who may see this player's movementHand, and until which roundNumber. INERT until socketServer.js redacts per recipient — today every hand is broadcast to everyone regardless.
 */

/**
 * @param {Partial<PlayerGameState>} fields
 * @returns {PlayerGameState}
 */
export function createPlayerGameState(fields) {
  const isBank = fields.isBank ?? false;
  const playerId = fields.playerId ?? null;
  // Mirrors game_players' own CHECK constraint exactly:
  // (is_bank AND player_id IS NULL) OR (NOT is_bank AND player_id IS NOT NULL)
  if (isBank !== (playerId === null)) {
    throw new TypeError('isBank must be true iff playerId is null');
  }

  return {
    id: fields.id,
    gameId: fields.gameId,
    playerId,
    isBank,
    turnOrder: fields.turnOrder ?? null,
    startingBalance: fields.startingBalance ?? null,
    currentBalance: fields.currentBalance,
    currentPosition: fields.currentPosition ?? 0,
    inJail: fields.inJail ?? false,
    jailTurns: fields.jailTurns ?? 0,
    bankrupt: fields.bankrupt ?? false,
    bankruptAt: fields.bankruptAt ?? null,
    finalRank: fields.finalRank ?? null,
    finalNetWorth: fields.finalNetWorth ?? null,
    finalCash: fields.finalCash ?? null,
    finalPropertyValue: fields.finalPropertyValue ?? null,
    missedTurnStreak: fields.missedTurnStreak ?? 0,
    zodiac: fields.zodiac ?? null,
    jailFreeCards: fields.jailFreeCards ?? 0,
    nextBuildDiscount: fields.nextBuildDiscount ?? 0,
    nextRentDiscount: fields.nextRentDiscount ?? null,
    inventory: fields.inventory ?? [],
    movementHand: fields.movementHand ?? [],
    activePerks: fields.activePerks ?? [],
    handRevealedTo: fields.handRevealedTo ?? [],
  };
}

/**
 * @typedef {Object} GameState
 * @property {string} id - uuid, games.id
 * @property {string} roomId - games.room_id
 * @property {string} boardId - 'small' | 'large', games.board_id
 * @property {string} ruleset - 'CLASSIC' | 'ASYMMETRIC', specifies the rules for this match
 * @property {('in_progress'|'ending'|'finished'|'aborted')} status
 * @property {(typeof GAME_PHASES[number])|null} phase - turn sub-state; null when status isn't 'in_progress'
 * @property {number} currentTurnIndex - games.current_turn_index
 * @property {number} stateVersion - games.state_version
 * @property {import('./gameState.js').PlayerGameState[]} players
 * @property {import('./property.js').Property[]} properties
 * @property {boolean|null} lastRollWasDouble - whether the current player's
 *   most recent roll this turn was a double; null at the start of a fresh
 *   turn (TURN_START resets it), before any roll has happened yet. Added in
 *   P07-T02: END_TURN's "loop the same player, or advance" decision needs
 *   this, and GameState must be self-contained rather than requiring a
 *   caller (turnMachine.js's action payload, or later timers.js) to
 *   separately remember it out-of-band.
 * @property {{die1: number, die2: number, total: number, isDouble: boolean}|null} lastRoll - wired 2026-08-21, alongside the board's own dice-animation frontend slice: the current player's most recent real dice roll this turn (ROLL_DICE or a jail-escape ATTEMPT_JAIL_ROLL). Reset to null at TURN_START (startTurn()), same lifecycle as lastRollWasDouble/currentDoublesStreak — a fresh turn shouldn't display the *previous* player's stale roll. Purely a display fact: no game logic reads this back (lastRollWasDouble/currentDoublesStreak already carry everything advanceTurn()/moveAndResolve() themselves need) — it exists only because, before this, the two individual die faces/total never reached the client in any form, anywhere. **Known, deliberately-not-covered case**: moveAndResolve()'s sentToJail short-circuit (a 3rd consecutive double) does not set this at all — advanceTurn() immediately cascades into the *next* player's startTurn() within that same transition, which would reset it to null before any broadcast could ever show it, so setting it there would just be dead code. Fixing that would mean carrying a "just-jailed player's last roll" fact across a turn boundary startTurn() has no other reason to know about; judged not worth the complexity for a rare edge case (three consecutive doubles) versus the dominant case (every ordinary roll, and every doubles-bonus continuation) this field correctly covers.
 * @property {number} lastRollSeq - bug fix 2026-08-23 (finding #37), exact companion to lastDrawnEventCardSeq and added for the identical reason: `lastRoll` above is only cleared at TURN_START, so it stays unchanged for the whole rest of the roller's turn, while `stateVersion` bumps on every action anyone takes. DiceRoll.jsx keyed its tumble animation off `stateVersion`, so the already-settled dice re-tumbled on every unrelated action (a purchase, an event-card choice, another player's trade proposal). This counter increments by exactly 1 only where `lastRoll` is genuinely set, so it is the real "a new roll happened" signal — including the case a naive `${die1}-${die2}` key would miss, a doubles bonus turn that rolls the exact same faces again. Starts at 0; never reset (TURN_START clears `lastRoll` to null, which already hides the dice, so the counter has no reason to go backwards). **Reading it needs `?? 0` at any arithmetic site** — see lastDrawnEventCardSeq's own note for why createGameState()'s default does not reach an already-in-progress match.
 * @property {number} currentDoublesStreak - dice.js's rollDice() own
 *   `doublesStreak` output from the current player's most recent roll this
 *   turn; 0 at the start of a fresh turn. Whoever calls rollDice() for the
 *   *next* roll (a real ROLL_DICE action, or timers.js synthesizing a
 *   ROLLING-timeout default) must pass this back in as that call's input
 *   doublesStreak, or a real 3rd-consecutive-double could never be
 *   detected. Added alongside lastRollWasDouble in P07-T02 for the same
 *   reason: found while implementing the timeout-default roll for ROLLING,
 *   an identical "GameState must be self-contained" gap.
 * @property {object|null} pendingAuction - engine/auction.js's AuctionState while phase is FLASH_AUCTION_ACTIVE; null otherwise. Same "GameState must be self-contained across phase transitions" reasoning as lastRollWasDouble/currentDoublesStreak (P07-T02) — a live auction can't be reconstructed from anything else on GameState.
 * @property {import('./trade.js').Trade[]} pendingTrades - every currently-active (status 'PROPOSED') trade, regardless of gameState.phase — trade actions are deliberately independent of the turn sub-machine (stateMachine/tradeMachine.js, not turnMachine.js), so this can hold entries at any point in a game, not just during a specific phase. Defaults empty. An entry is removed the instant it resolves (ACCEPTED/REJECTED/CANCELLED/COUNTERED) or is found expired (EXPIRED, lazily, not via a background timer — see tradeMachine.js's own header) — never left sitting with a terminal status
 * @property {{debtorId: string, creditorId: string, amount: number, transactionType: string, onSettled?: ('POST_ACTIONS'|'RELEASE_TO_ROLLING'|'RELEASE_AND_ADVANCE')}|null} pendingLiquidation - Win Condition design (2026-08-19): the debt context while phase is LIQUIDATION_REQUIRED (settleDebt() couldn't pay from cash alone, but checkSolvency() says liquidation can cover it); null otherwise. Same self-contained-GameState reasoning as pendingAuction — SELL_HOUSE/MORTGAGE actions taken during LIQUIDATION_REQUIRED re-check this against the debtor's post-sale currentBalance to know when the debt is actually settled. `onSettled` (finding #28, 2026-08-19) generalizes what happens once it clears — absent/'POST_ACTIONS' for the original rent/tax case; 'RELEASE_TO_ROLLING'/'RELEASE_AND_ADVANCE' for a jail-fine debt (payJailFineOrLiquidate() in turnMachine.js), which also needs the debtor released from jail at that exact moment, not before.
 * @property {number} roundNumber - Win Condition design: 0 at match start, incremented by advanceTurn() every time turn order wraps back to its start (i.e., once per full cycle through active players, not once per individual turn) — the Final Phase trigger/duration clock.
 * @property {number|null} finalPhaseStartedAtRound - Win Condition design: null until Final Phase begins (roundNumber reaches FINAL_PHASE_TRIGGER_ROUND), then frozen at the roundNumber it began — Final Phase ends when roundNumber reaches this value + FINAL_PHASE_DURATION_ROUNDS. Never reset once set (a match only enters Final Phase once).
 * @property {('elimination'|'final_phase')|null} endReason - Win Condition design: null while status is 'in_progress'; set once, at the moment status becomes 'finished', recording *why* the match ended (frontend Game Over screen context — "the story" — not used by any game logic itself, which only ever checks status/finalRank)
 * @property {string|null} pendingEventCardId - domain/eventDictionary.js's EVENT_CARDS key for the card awaiting a choice while phase is AWAITING_EVENT_CHOICE; null otherwise. MAKE_EVENT_CHOICE needs this to know which card's options it's resolving against.
 * @property {string|null} lastDrawnEventCardId - domain/eventDictionary.js's EVENT_CARDS key for the most recently drawn card, of *either* type — wired 2026-08-21 alongside the new GET /api/v1/event-cards endpoint, closing a real frontend gap (EventCardModal.jsx's own header): an INSTANT card resolves synchronously and pendingEventCardId is CHOICE-only, so GameState previously recorded which card was drawn only for the CHOICE case, never the INSTANT one — the frontend's instant-card toast could show the resulting money movement but never the card's own real text. Set by resolveDrawingCard() on both branches (INSTANT and CHOICE alike), never cleared afterward — it's simply overwritten on the next draw, same "last known value, not a pending/consumed flag" reasoning as e.g. finalNetWorth. Harmless to read stale *by value* (it's still the real last-drawn card), but NOT safe to use as a "did a new draw just happen" signal on its own — see lastDrawnEventCardSeq.
 * @property {number} lastDrawnEventCardSeq - bug fix 2026-08-23 (real user report: the instant-card notice kept reappearing over and over for the rest of the match after a single Cơ Hội/Khí Vận draw). EventCardModal.jsx originally detected "is this a new draw worth (re)showing" by comparing its own dismissed-at stateVersion against the live gameState.stateVersion — but stateVersion increments on *every* successful action in the whole match (stateMachine/idempotency.js), not just draws, and lastDrawnEventCardId is never cleared (see above), so any later unrelated action made an already-dismissed, stale draw look "new" again, showing it once more for INSTANT_CARD_VISIBLE_MS, forever. This counter increments by exactly 1 only inside resolveDrawingCard() (turnMachine.js), on every draw including a repeat of the same card id — the correct "new draw" signal, decoupled from stateVersion. Starts at 0, never reset.
 * @property {string[]} eventDeck - domain/eventDictionary.js's EVENT_CARDS keys, in draw order; engine/eventResolver.js's drawCard() consumes from the front and cycles to the back. Defaults empty — this file takes no runtime dependency on eventDictionary.js (see the file-level comment), so seeding a real deck is the caller's job, same as players/properties are caller-supplied, not auto-generated here. One shared deck regardless of tile type (chance vs fortune) — domain/eventCard.js's EVENT_CARD_DECKS split has no equivalent here yet, a known simplification.
 * @property {string} startedAt - ISO timestamp
 * @property {string|null} endedAt - ISO timestamp
 * @property {number} houseSupply - Phase 14 design (2026-08-19): global, shared across all players — GAME_DESIGN_SPEC.md §12's own `HOUSE_SUPPLY_TOTAL`, now confirmed enforced (was `[OPEN DESIGN DECISION]`). Starts at 32 (classic physical set). Decremented by BUILD_HOUSE (1-4), or by +4 when a 4th house converts to a hotel (returned to the shared pool, not consumed); incremented by SELL_HOUSE and by a real-bankruptcy-to-the-Bank settlement (never by a bankruptcy transfer to another player, whose properties keep their buildings as-is).
 * @property {number} hotelSupply - companion to houseSupply — GAME_DESIGN_SPEC.md §12's `HOTEL_SUPPLY_TOTAL`. Starts at 12. Decremented by 1 exactly when upgradeLevel reaches MAX_UPGRADE_LEVEL (the 4-houses-to-1-hotel conversion); incremented back by SELL_HOUSE off a hotel or a real-bankruptcy-to-the-Bank settlement.
 * @property {number} freeParkingJackpot - Phase 14 design (2026-08-19): GAME_DESIGN_SPEC.md §14's own tax-jackpot variant, now confirmed adopted (was `[OPEN DESIGN DECISION]`, default "disappears"). A running total, not itself a real ledger participant — ECONOMY_SPECIFICATION.md's own guidance for exactly this variant ("funded by a real source... an accumulating pool of Tax/Fine payments the Bank already collected"): tax/jail-fine payments still pay the Bank normally (unchanged, real transactions), this field separately tracks that same running total; landing on the real `free_parking` tile (tileType-matched, not a fixed board position — this project's board size is adaptive, Free Parking sits at a different position on Small vs. Large) pays it out to that player via one real Bank→player transaction and resets this to 0.
 * @property {string|null} pendingHostileBuyoutPropertyId - Phase 14 design (2026-08-19): the property just landed on, set the instant a real (unmortgaged, someone-else-owned) rent payment resolves — null otherwise. Same self-contained-GameState reasoning as pendingLiquidation/pendingAuction. Consumed (cleared) by a real HOSTILE_BUYOUT, or whenever POST_ACTIONS ends (END_TURN) — never carries over to a later turn.
 * @property {{propertyId: string, ownerId: string, payerId: string, amount: number}|null} pendingRentGamble - Rent Risk Choice, REVISED 2026-08-25 (real user correction — see BOARD_SPECIFICATION.md's own entry for the full before/after): rent no longer blocks on an owner decision at all — PAYING_RENT settles the real, fixed rent amount immediately, same as before that mechanic ever existed, and this field is set right after, purely as an OPTIONAL, non-blocking side offer to the owner: "you may gamble the `amount` you just collected against the Bank" (a `GAMBLE_RENT` action, legal any time, gated to no particular phase — same "needs to work in any phase" precedent FORFEIT_MATCH/trade actions already established). Win pays the owner another `amount` from the Bank (their total take doubles); loss takes the `amount` back from the owner to the Bank (they end with nothing from this rent event) — either way the PAYER's own payment, already settled, is never touched again. Deliberately only ever set for a clean, immediate, in-full CASH payment to a real (non-Bank) owner — a payer who couldn't cover it in cash (LIQUIDATION_REQUIRED, bankruptcy) offers no gamble opportunity, since there is no clean "amount just collected" to gamble in those cases. Superseded (overwritten) by the next rent event before it's used, same as before; also cleared if the owner themselves goes bankrupt or forfeits with it still unclaimed (`applyBankruptcy`'s own cleanup, alongside its existing `pendingTrades`/`pendingAuction` handling).
 * @property {{propertyId: string, ownerId: string, grantedAtRound: number}|null} propertyProtection - C08 "Bảo Vệ Tài Sản" (card deck v2, 2026-08-25). The one card in the whole deck that touches the Steal/Hostile-Acquisition system: it makes ONE of the owner's own unimproved properties temporarily immune to HOSTILE_BUYOUT, which is otherwise only achievable by actually building on it. Deliberately narrow — it blocks nothing else (rent, trade, mortgage, bankruptcy transfer all behave exactly as before).
 *   Expiry, per the card's own text ("đến khi người chơi bắt đầu lượt tiếp theo, hoặc Property được Build"), is derived rather than stored as a deadline: `roundNumber > grantedAtRound` means the owner's next turn has begun. That equivalence holds for the same reason PropertyRECENTLY_ACQUIRED's own gate relies on it — roundNumber advances once per full cycle through active players, and a card is always drawn on the owner's own turn, so exactly one full round of opponents sits inside the protection window. Building on the property clears it early (HOUSE_PROTECTED takes over permanently from there, so keeping it would be redundant), as does the owner going bankrupt/forfeiting with it still live.
 * @property {number} rentModifierPercent - 2026-08-22 (the 24-card "Cơ Hội/Khí Vận" deck, K01 "Thị Trường Sôi Động" +10 / K02 "Thị Trường Suy Thoái" -10): a global, round-scoped percentage applied on top of calculateRent.js's own output — that function itself stays untouched/pure, this is layered on at turnMachine.js's own PAYING_RENT call site. 0 = no modifier. Reset to 0 by advanceTurn() at the exact moment turn order wraps back to its start (the same real round boundary roundNumber's own doc already describes) — "trong một vòng" (for the rest of the current round), not a fixed-duration timer.
 * @property {number} buildCostModifierAmount - companion to rentModifierPercent, same round-scoped reset — K07 "Giá Vật Liệu Tăng" +50 / K08 "Vật Liệu Giảm Giá" -50 per build, layered on top of economy/propertyEconomy.js's own calculateBuildHouse() output at handleBuildHouse's own call site, that function likewise untouched.
 * @property {string[]} movementDeck - [ASYMMETRIC] Chồng bài di chuyển chung (rút thẻ từ đây)
 * @property {string[]} movementDiscardPile - [ASYMMETRIC] Chồng bài di chuyển đã dùng
 * @property {{ tileIndex: number, type: ('ROADBLOCK'|'TOLL_BOOTH'), ownerId: string, expiresAtRound: number }[]} activeTraps - [ASYMMETRIC] Hệ thống Bẫy / Chướng ngại vật trên bản đồ (engine/trapEngine.js). The shape here said `duration: number` until 2026-09-04 and was simply wrong — V1 sketched a decrementing counter, nothing ever decremented it, and the real implementation ships lazy `expiresAtRound` expiry instead (trapEngine.js's own file header explains why). Corrected rather than left contradicting the only code that writes this array. **Redacted per viewer** on the way out (engine/stateRedaction.js's maskTrap): only the trap's own owner receives the real fields, everyone else gets a length-preserving anonymous stub, so a client can count live traps but not locate anyone else's.
 * @property {{tileIndex: number, type: ('ROADBLOCK'|'TOLL_BOOTH')}[]} lastTrapHits - [ASYMMETRIC] Display-only (2026-09-04, frontend "Mặt trận 3"): which traps the most recent movement-card play actually SET OFF, in crossing order. Empty on any move that set nothing off, so a stale explosion can never replay. No game logic reads it — it exists purely so the board can render a "bẫy phát nổ" effect on the right tile, which is otherwise unreconstructable client-side: a victim never saw the trap in the first place (activeTraps is redacted), and a TOLL_BOOTH leaves no trace in activeTraps even after it fires. Deliberately NOT redacted: a ROADBLOCK named here is already consumed and gone, and a TOLL_BOOTH has just charged someone in full public view (the token visibly crossed that tile and money moved), so treating it as still-secret afterwards would be a fiction — it stays hidden until its first victim, which is the part the design actually needs.
 * @property {number} lastTrapHitSeq - companion counter to lastTrapHits, same role lastRollSeq/lastDrawnEventCardSeq play for their own fields: `stateVersion` bumps on every action anyone takes, so a client keying an explosion animation off it would replay that explosion on every later unrelated action (the exact bug finding #37 fixed for the dice). Incremented by exactly 1 only when lastTrapHits is non-empty. Starts at 0, never reset — **reading it needs `?? 0` at any arithmetic site**, for the same reason lastRollSeq does (createGameState()'s default never reaches an already-in-progress match restored from a snapshot).
 * @property {{round: number, pickOrder: string[], currentPickIndex: number, availableTileIds: string[]}|null} draftState - [ASYMMETRIC] engine/draftPhase.js's live Draft Phase progress — null once the draft ends (or for CLASSIC, always). `round` is 1 or 2; `pickOrder` is THIS round's snake-ordered player ids (reversed for round 2); `currentPickIndex` indexes into it for whose pick it currently is — getCurrentPlayer() (turnMachine.js) reads through this instead of currentTurnIndex while phase === 'DRAFTING_ACTIVE'; `availableTileIds` is this round's random 4-tile offer (property tiles only, never transport/utility — see draftPhase.js's own file header for why).
 */
// Note: eventDeck (added alongside pendingAuction/pendingEventCardId when
// turnMachine.js first wired DRAWING_CARD/AWAITING_PURCHASE-decline to real
// effects) covers draw order only, not discard-pile/reshuffle bookkeeping —
// no recycle mechanism exists once eventDeck is exhausted. This also still
// doesn't model any other in-flight action context (e.g. a pending dice
// roll) — game_state_snapshots.state is documented as needing to hold "the
// full internal GameState recovery blob" (0002_rls_policies.sql's comment),
// so a truly complete GameState will need more than this eventually, but no
// concrete shape for the rest is specified anywhere yet. Left out rather
// than guessed — same standing as EventCard.text content.

/**
 * @param {Partial<GameState>} fields
 * @returns {GameState}
 */
export function createGameState(fields) {
  if (!GAME_STATUSES.includes(fields.status)) {
    throw new TypeError(`Unknown status: ${fields.status}`);
  }
  const phase = fields.phase ?? null;
  if (phase !== null && !GAME_PHASES.includes(phase)) {
    throw new TypeError(`Unknown phase: ${phase}`);
  }
  if (phase !== null && fields.status !== 'in_progress') {
    throw new TypeError(`phase must be null when status is '${fields.status}'`);
  }

  return {
    id: fields.id,
    roomId: fields.roomId,
    boardId: fields.boardId,
    ruleset: fields.ruleset ?? 'CLASSIC',
    status: fields.status,
    phase,
    currentTurnIndex: fields.currentTurnIndex ?? 0,
    stateVersion: fields.stateVersion ?? 0,
    players: fields.players ?? [],
    properties: fields.properties ?? [],
    lastRollWasDouble: fields.lastRollWasDouble ?? null,
    lastRoll: fields.lastRoll ?? null,
    lastRollSeq: fields.lastRollSeq ?? 0,
    currentDoublesStreak: fields.currentDoublesStreak ?? 0,
    pendingAuction: fields.pendingAuction ?? null,
    pendingTrades: fields.pendingTrades ?? [],
    pendingLiquidation: fields.pendingLiquidation ?? null,
    roundNumber: fields.roundNumber ?? 0,
    finalPhaseStartedAtRound: fields.finalPhaseStartedAtRound ?? null,
    endReason: fields.endReason ?? null,
    pendingEventCardId: fields.pendingEventCardId ?? null,
    lastDrawnEventCardId: fields.lastDrawnEventCardId ?? null,
    lastDrawnEventCardSeq: fields.lastDrawnEventCardSeq ?? 0,
    eventDeck: fields.eventDeck ?? [],
    startedAt: fields.startedAt,
    endedAt: fields.endedAt ?? null,
    houseSupply: fields.houseSupply ?? HOUSE_SUPPLY_TOTAL,
    hotelSupply: fields.hotelSupply ?? HOTEL_SUPPLY_TOTAL,
    freeParkingJackpot: fields.freeParkingJackpot ?? 0,
    pendingHostileBuyoutPropertyId: fields.pendingHostileBuyoutPropertyId ?? null,
    pendingRentGamble: fields.pendingRentGamble ?? null,
    propertyProtection: fields.propertyProtection ?? null,
    rentModifierPercent: fields.rentModifierPercent ?? 0,
    buildCostModifierAmount: fields.buildCostModifierAmount ?? 0,
    movementDeck: fields.movementDeck ?? [],
    movementDiscardPile: fields.movementDiscardPile ?? [],
    activeTraps: fields.activeTraps ?? [],
    lastTrapHits: fields.lastTrapHits ?? [],
    lastTrapHitSeq: fields.lastTrapHitSeq ?? 0,
    draftState: fields.draftState ?? null,
  };
}
