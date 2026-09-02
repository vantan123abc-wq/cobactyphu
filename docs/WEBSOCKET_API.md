# CoBacTyPhu — WebSocket API Contract (v2)

**Supersedes `SOCKET_CONTRACT.md` — not a companion to it.** That document specified a granular, one-event-per-action-type contract (`game:roll_dice`, `game:buy_property`, `game:auction_bid`, 24 distinct events total) with room joining kept on REST specifically to avoid a live channel before a `games` row exists. This document replaces that shape with a generic action envelope: one client→server event (`C2S_GAME_ACTION`) dispatched by an `actionType` string, and one primary server→client broadcast (`S2C_STATE_UPDATE`) carrying the full recalculated state rather than many narrow per-effect events. `SOCKET_CONTRACT.md` is marked superseded at its own top, not deleted — its per-event reasoning (idempotency conventions, the disconnect/reconnect model, the `[PROPOSED]` special-mechanic events) is still useful background, just no longer the wire format.

Design only — nothing here is implemented (P09/Socket.IO hasn't started; `PROJECT_STATUS.md`). `GAME_STATE_MACHINE.md` remains the source of truth for states/transitions/timers; this document only defines how those get carried over the wire.

---

## Conventions

- **Transport**: Socket.IO, JWT in the handshake `auth` payload, verified once at connect (unchanged from the superseded contract).
- **Namespace/room scope**: this contract connects and joins **per room** (`C2S_JOIN_ROOM`, below) — a reversion from the superseded contract's per-*game* namespacing, which assumed lobby actions stayed on REST. Under this design a socket can be live before a `games` row exists. **Flagged, not fully resolved here**: `API_CONTRACT.md`'s REST room lifecycle (create/join/leave/ready/start) is untouched by this document — `C2S_JOIN_ROOM` attaches an already-authenticated, already-REST-joined player's live connection to that room's broadcast group; it does not create `room_players` membership itself. Worth confirming explicitly before implementation, since it's the one place this contract and `API_CONTRACT.md` now overlap.
- **One action envelope, one state broadcast**: every in-game move is `C2S_GAME_ACTION`; every successful transition is `S2C_STATE_UPDATE`. Per-effect animation hooks (a specific dice roll, a specific balance delta) are a client-side concern — diffed from consecutive `S2C_STATE_UPDATE` payloads and the `transactions` array carried on each one, not separate wire events.
- **`clientActionId` is mandatory on every `C2S_GAME_ACTION`**, not implicit at the transport level (a deliberate change from the superseded contract) — it is the literal dedup key `stateMachine/idempotency.js`'s `applyWithIdempotency` keys its cache on (`GAME_STATE_MACHINE.md` §6, `[PROPOSED]` ~60s window).
- **Server-authoritative, unchanged from the superseded contract**: dice values, rent/tax amounts, event-card effects, and auction resolution are always server-computed. No `C2S_GAME_ACTION.payload` ever carries a result, only an intent (which dice-roll-in-progress action to take, which option to pick, how much to bid).

---

## 1. `C2S_GAME_ACTION` (Client → Server)

The single entry point for every in-game move.

```json
{
  "roomId": "uuid",
  "playerId": "uuid — game_players.id, NOT profiles.id",
  "actionType": "ROLL_DICE",
  "payload": { "...": "actionType-specific, see table below" },
  "clientActionId": "uuid"
}
```

| Field | Type | Required | Detail |
|---|---|---|---|
| `roomId` | `uuid` | yes | Which room's broadcast group this targets — must match a room the sender already joined via `C2S_JOIN_ROOM` |
| `playerId` | `uuid` | yes | **Security-critical, not trusted as-is**: the server must resolve the sender's real identity from the authenticated socket session (JWT → `profiles.id` → `game_players.id`) and reject the action outright (`NOT_AUTHORIZED`) if it doesn't match this field. This field exists because most actions are implicitly "the current-turn player," but `FLASH_AUCTION_ACTIVE`'s `PLACE_BID`/`FOLD_AUCTION` are the one case where the actor is *not* necessarily the current-turn player (`turnMachine.js`'s `handleAuctionAction` — any eligible bidder can act) — the server still authenticates who's really sending, this field only says who they're claiming to act as, and those two must match. **Implementation note (`socketServer.js`, P09-T02)**: the two id spaces named above are genuinely different values, not just a phrasing detail — `socket.user.id` (the JWT `sub`) is `profiles.id`; every engine/state-machine comparison (`auction.js`'s `activeBidders`, `turnMachine.js`'s player lookups) is keyed on `PlayerGameState.id` (`game_players.id`) instead. The server resolves `socket.user.id` → the matching `PlayerGameState.id` via `gameState.players`, then injects *that* value — never the raw `socket.user.id` — as the actor identity. A client-supplied `playerId` in the payload, at any id, is simply never read |
| `actionType` | `string` | yes | Maps 1:1 to `turnMachine.js`'s `action.type` — see the exhaustive table below |
| `payload` | `object \| undefined` | actionType-dependent | Maps 1:1 to `turnMachine.js`'s `action.payload` — identical shape, no translation layer |
| `clientActionId` | `uuid` | yes | Dedup key for `idempotency.js`. A repeat within the cache window is **not** rejected — it's a no-op re-acknowledgment (`applyWithIdempotency`'s `deduped: true`), answered with the same `S2C_STATE_UPDATE` the original produced, never `S2C_ACTION_REJECTED` |
| `lastSeenStateVersion` | `number` | no, wired 2026-08-21 | `GAME_STATE_MACHINE.md` §6 point 2's staleness check, genuinely optional (backward compatible with every client that never sends it): when present, rejected with `STALE_ACTION` unless it exactly matches `gameState.stateVersion` at the moment the server processes it. Checked uniformly for every `actionType` that includes it — a client opts in to staleness-checking by including the field at all, rather than the server guessing which specific actions are "target-specific" enough to need it |

### `actionType` → `payload` (exhaustive — every value `turnMachine.js`'s `VALID_ACTIONS_BY_PHASE` currently accepts, plus the five trade actions below it, which deliberately aren't gated by `VALID_ACTIONS_BY_PHASE` at all)

| `actionType` | Valid phase | `payload` shape | Notes |
|---|---|---|---|
| `START_TURN` | `TURN_START` | `{}` | |
| `PAY_JAIL_FINE` | `JAIL_DECISION` | `{}` | |
| `USE_JAIL_CARD` | `JAIL_DECISION` | `{}` | |
| `ATTEMPT_JAIL_ROLL` | `JAIL_DECISION` | `{}` | Roll is server-generated, never client-supplied |
| `ROLL_DICE` | `ROLLING` | `{}` | Roll is server-generated |
| `BUY_PROPERTY` | `AWAITING_PURCHASE` | `{}` | Tile is the sender's current position, not client-supplied |
| `SKIP_PURCHASE` | `AWAITING_PURCHASE` | `{}` | **Auction V2 (2026-09-01).** Free: no fee, no auction, the tile stays unowned |
| `FORCE_AUCTION` | `AWAITING_PURCHASE` | `{ "basePrice"?: integer }` | **Auction V2 (2026-09-01).** Pays `calculateAuctionFee` (5% of the tile's **printed** price, clamped [$20,$80]) to open a live auction; on SETTLED the initiator is paid a broker commission of 20% of the winning bid, **funded by the Bank**, not taken out of the winner's payment. Rejected with `INSUFFICIENT_BALANCE` if the fee is unaffordable — deliberately not a silent fallback, so a client bug cannot be masked. **`basePrice` (optional, added 2026-09-03)** sets the auction's opening bid. Omit it and the auction opens at the printed price, exactly as before. When present it must be an integer in **`[ceil(price × 0.5), price]`** — the host may discount the opening to attract a bid but never open above the printed price; anything else is `INVALID_BASE_PRICE`. The fee is charged on the printed price regardless, so discounting the opening never discounts the host's own cost of running the auction |
| `DECLINE_PURCHASE` | `AWAITING_PURCHASE` | `{}` | **Legacy alias for `SKIP_PURCHASE`.** Before Auction V2 this single action both declined *and* force-started an auction; it now routes to the free skip branch. Kept so existing clients keep working without a flag day — new clients should send `SKIP_PURCHASE`/`FORCE_AUCTION` explicitly. Note this also changed what an `AWAITING_PURCHASE` **timeout** does: `buildDefaultAction` returns `DECLINE_PURCHASE`, so a timeout is now free and never charges an absent player a fee |
| `PLACE_BID` | `FLASH_AUCTION_ACTIVE` | `{ "amount": number }` | `playerId` (top-level, above) identifies the bidder — need not be the current-turn player |
| `FOLD_AUCTION` | `FLASH_AUCTION_ACTIVE` | `{}` | Same `playerId` note as `PLACE_BID` |
| `GAMBLE_RENT` | **any** | `{}` | **Rent Risk Choice (BOARD_SPECIFICATION.md), revised 2026-08-25 — replaces the original `RENT_RISK_CHOICE`/`RENT_RISK_DECISION` design, which no longer exists.** `PAYING_RENT` now always settles the standard rent immediately and unconditionally, the instant a player lands, with no decision or phase in between. Only after that (and only if paid in cash, not deferred to `LIQUIDATION_REQUIRED`) does `GameState.pendingRentGamble` (`{ propertyId, ownerId, payerId, amount }`) open — `GAMBLE_RENT` is the owner's entirely optional response to it, same empty payload as `FOLD_AUCTION`, risking the `amount` they already collected on a server-rolled 50/50 double **funded by the Bank, not the payer** (`playerId`, top-level above, identifies the owner, same "acting player isn't necessarily the current-turn one" exception `PLACE_BID`/`FOLD_AUCTION` already established). A losing roll settles no transaction at all beyond the standard rent already paid — nothing further to pay, same "no transaction row" shape the original design's gamble-loss case had. Deliberately phase-independent (`TURN_INDEPENDENT_ACTION_TYPES`, dispatched before the `VALID_ACTIONS_BY_PHASE` gate in `transitionTurn`, the same precedent `FORFEIT_MATCH` set) as well as turn-independent — no timer, no timeout, no default-on-silence: it can sit unresolved for as long as the owner likes, since nothing else waits on it any more. Does not advance the turn |
| `AUCTION_TIMEOUT` | `FLASH_AUCTION_ACTIVE` | `{}` | **System-generated only.** A real client must never send this — it's synthesized server-side by the (not-yet-built) timer extension to `timers.js` and dispatched the same way any other timeout default is. Documented here only because it's a legal `actionType` value the state machine accepts; rejecting it if it somehow arrives from a real client socket is a server-side responsibility outside this contract's scope |
| `MAKE_EVENT_CHOICE` | `AWAITING_EVENT_CHOICE` | `{ "optionId": string, "probabilityRoll"?: number }` | `probabilityRoll` is required only if the chosen option has a `PROBABILITY` intent (`domain/eventDictionary.js`) — server-generated in production, never client-supplied in a real deployment despite being a payload field (mirrors dice: the field exists so the pure resolver stays injectable, not so a client can supply it) |
| `BUILD_HOUSE` | `POST_ACTIONS` | `{ "propertyId": string }` | `propertyId` is `properties.id` (the game-scoped ownership row), **not** `board_tiles.id` — the target need not be the sender's current tile, since `POST_ACTIONS` is reached after movement already resolved and any owned property qualifies, group-complete or not (**revised 2026-08-25** — owning the full color group stopped being a precondition; `INCOMPLETE_GROUP` below no longer exists). One house/hotel unit per action. Does **not** advance the turn (`GAME_DESIGN_SPEC.md` §7: build/mortgage/trade may happen in any order, not a forced single slot) — stays in `POST_ACTIONS`, so further post-actions or an explicit `END_TURN` can follow. The upgrade-level ceiling is revalidated server-side regardless of client UI state (`turnMachine.js`'s `handleBuildHouse`), plus a precondition added 2026-08-25: the property must have been owned since *before* the current `roundNumber` (`RECENTLY_ACQUIRED` below) — building must wait until at least the owner's own next turn after acquiring it via `BUY_PROPERTY` or `HOSTILE_BUYOUT` (not a negotiated trade, which leaves this untouched) |
| `SELL_HOUSE` | `POST_ACTIONS` | `{ "propertyId": string }` | `BUILD_HOUSE`'s inverse for the money side — one unit refunded at half `houseCost` (floored). The even-**sell** rule still applies (**note 2026-09-02:** it is now the only "even" constraint left — the matching even-*build* rule was removed; kept on the sell side so a player can't strip one lot bare while its group-mates stay improved, inflating the *sell* refund order): must sell from whichever group member currently sits at the group's *highest* `upgradeLevel` (`turnMachine.js`'s `handleSellHouse`). Does not advance the turn, same as `BUILD_HOUSE` |
| `MORTGAGE` | `POST_ACTIONS` | `{ "propertyId": string }` | **[REVISED 2026-08-18, reverted 2026-09-02]** Precondition is per-property: only the target tile itself may not have `upgradeLevel > 0` (`PROPERTY_HAS_HOUSES` otherwise). It was briefly group-wide (no member of the colour group could have houses) from 2026-08-18 to match classic Monopoly; reverted on explicit instruction — the `×2` group bonus already drops the instant any group member is mortgaged (`calculateRent.js`), so mortgaging one bare lot while its group-mates stay built is a real self-imposed cost, not a loophole (`GAME_DESIGN_SPEC.md` §12). Credits `mortgageValue` to the player. Does not advance the turn |
| `UNMORTGAGE` | `POST_ACTIONS` | `{ "propertyId": string }` | Also per-property — only checks this property's own `mortgaged` flag and the payer's funds (`mortgageValue × 1.1`, ceiled). Does not advance the turn |
| `HOSTILE_BUYOUT` | `POST_ACTIONS` | `{}` | **Phase 14 (2026-08-19).** Only legal when `gameState.pendingHostileBuyoutPropertyId` is non-null — set server-side the instant this same turn's rent payment on another player's property finishes resolving, and unconditionally cleared at every turn advance, so the window never carries into a later turn. No `propertyId` in the payload — the target is always exactly `pendingHostileBuyoutPropertyId`, never client-chosen. Cost is a strict `2.0 × (tile.price + property.upgradeLevel × tile.houseCost)`, paid directly to the current owner (`applyTransaction`, `hostile_acquisition` type) — the Bank is not involved, this is a genuine direct player-to-player transfer. Rejected if the target belongs to a completed color-group monopoly (`MONOPOLY_PROTECTED`) or the buyer can't afford it (`INSUFFICIENT_BALANCE`). Does not advance the turn |
| `END_TURN` | `POST_ACTIONS` | `{}` | |
| `FORFEIT_MATCH` | **any** | `{}` | **2026-08-23, user request.** Voluntary concession — the sender permanently leaves the match. `playerId` (top-level, above) identifies whoever is forfeiting; need not be the current-turn player, same "acting player isn't necessarily `getCurrentPlayer`" exception `PLACE_BID`/`FOLD_AUCTION`/`GAMBLE_RENT` already established. Deliberately phase-independent (checked before `VALID_ACTIONS_BY_PHASE` in `transitionTurn`, same precedent the trade actions below set) — a player must be able to quit mid-roll, mid-auction, mid-anything, not only from `POST_ACTIONS`. Mechanically real bankruptcy (`GAME_DESIGN_SPEC.md` §16's "hand over remaining properties/cash in kind"), reusing that exact machinery rather than a second pathway: properties revert to the Bank (unowned, purchasable again) and all cash transfers to the Bank, UNLESS the forfeiter currently owes a live `LIQUIDATION_REQUIRED` debt to a specific other player, in which case that real creditor receives the cash instead (indistinguishable from "gave up instead of trying to liquidate"). If the forfeiter is the owner a `pendingRentGamble` is still open on (**revised 2026-08-25** — was: "a pending `RENT_RISK_DECISION` is waiting on, resolved to `STANDARD` first"), it is simply dropped unclaimed — there's no decision left to default, since the underlying rent was already settled in cash the instant it was collected; the forfeiter just never gets to risk it now. Checked immediately afterward for elimination, same as any other bankruptcy (`GAME_DESIGN_SPEC.md` §17) — if only one non-bankrupt player remains, the match ends right here. If the forfeiter held the turn at the moment they quit, it is force-advanced immediately (no bonus turn survives — `lastRollWasDouble` is cleared first, same rule an escaped-jail roll already follows); otherwise the real current player's turn is left completely untouched |
| `PROPOSE_TRADE` | **any** (see note) | `{ "targetId": string, "proposerOffer": { "properties": string[], "money": number }, "targetOffer": { "properties": string[], "money": number } }` | Routed to `stateMachine/tradeMachine.js`'s `applyTradeAction`, **not** `transitionTurn` — deliberately independent of `gameState.phase`, either player, at any point in the match (`GAME_DESIGN_SPEC.md` §10, resolved `[REVISED 2026-08-18]`). `properties[]` are `properties.id` (game-scoped ownership rows), not `board_tiles.id`. Server generates a fresh `tradeId`, ignoring any client-supplied one |
| `COUNTER_TRADE` | **any** | `{ "tradeId": string, "proposerOffer": {...}, "targetOffer": {...} }` | Only the existing trade's `targetId` may counter. Flips proposer/target, increments `counterDepth`, fails at `MAX_COUNTER_DEPTH` (5). Server generates a fresh `newTradeId` |
| `ACCEPT_TRADE` | **any** | `{ "tradeId": string }` | Only the trade's `targetId` may accept. Atomically swaps money (direct player-to-player, up to one `game_transactions` row per direction) and properties; clears the trade |
| `REJECT_TRADE` | **any** | `{ "tradeId": string }` | Only the trade's `targetId` may reject. No asset movement |
| `CANCEL_TRADE` | **any** | `{ "tradeId": string }` | Only the trade's `proposerId` may cancel their own offer. No asset movement |

**Trade actions, added 2026-08-18 — architecture notes** (`GAME_DESIGN_SPEC.md` §10 was an `[OPEN DESIGN DECISION]`; the shape below was confirmed explicitly before implementation, not guessed):
- **Phase-independent by design.** Every other `actionType` above is implicitly "the current-turn player, during a specific phase." A trade is fundamentally different — proposable/answerable by either party at any point in the match, matching how trading actually works. `stateMachine/tradeMachine.js`'s `applyTradeAction` is a second `transitionFn` `infrastructure/websocket/socketServer.js`'s `handleGameAction` dispatches to (same `applyWithIdempotency`/idempotency/broadcast pipeline, same `C2S_GAME_ACTION` envelope) whenever `actionType` is one of the five above — `turnMachine.js`/`VALID_ACTIONS_BY_PHASE` are completely untouched by trade actions.
- **Strictly 1-vs-1**, properties + money only, no conditions, no 3+-party trades — `GAME_DESIGN_SPEC.md` §10's own open question, answered on explicit instruction.
- **Asset locking is computed on the fly** from `GameState.pendingTrades`, not a persisted `locked` column — every property/amount of money already offered in another active trade is unavailable to a new proposal or counter (`ASSET_LOCKED`/`INSUFFICIENT_BALANCE` below). No `DATABASE_DESIGN.md` schema change.
- **Expiration is a lazy check** (`TRADE_EXPIRY_SECONDS` = 60), not a new timer — `stateMachine/timers.js`'s `TimerManager` only supports one active timer per room, which can't express several independently-expiring concurrent trades in the same room without a real rework. A trade past `expiresAt` is dropped the next time *any* trade action touches `pendingTrades`; acting on an already-expired one reads as `TRADE_NOT_FOUND`.

---

## 2. `S2C_STATE_UPDATE` (Server → All Clients in Room)

Broadcast once, to every socket in the room's broadcast group, after any state-changing `C2S_GAME_ACTION` succeeds (including a deduped-repeat re-acknowledgment) or a system-triggered transition (a fired timeout) completes.

```json
{
  "stateVersion": 42,
  "gameState": { "...": "full GameState, see below" },
  "transactions": [
    {
      "gameId": "uuid",
      "fromGamePlayerId": "uuid",
      "toGamePlayerId": "uuid",
      "amount": 200,
      "transactionType": "pass_go_salary",
      "idempotencyKey": "uuid:42",
      "resultingBalanceFrom": 1300,
      "resultingBalanceTo": 1700
    }
  ],
  "deadlineAt": "2026-08-18T00:00:15.000Z"
}
```

| Field | Type | Detail |
|---|---|---|
| `stateVersion` | `number` | `GameState.stateVersion` after this action — the client's sync-validation anchor (`GAME_STATE_MACHINE.md` §6). Monotonic per game; a broadcast whose version the client already has is a safe no-op to apply |
| `gameState` | `GameState` | The complete object as shaped by `backend/src/domain/gameState.js`: `id`, `roomId`, `boardId`, `status`, `phase`, `currentTurnIndex`, `stateVersion`, `players[]`, `properties[]`, `lastRollWasDouble`, `lastRoll`, `currentDoublesStreak`, `pendingAuction`, `pendingEventCardId`, `lastDrawnEventCardId`, `eventDeck`, `houseSupply`, `hotelSupply`, `freeParkingJackpot`, `pendingHostileBuyoutPropertyId`, `pendingRentRiskChoice`, `startedAt`, `endedAt`, plus the Win Condition design's own `pendingTrades[]`/`pendingLiquidation`/`roundNumber`/`finalPhaseStartedAtRound`/`endReason` (omitted from this list until now, not because they're new — this row itself had already drifted before today's own two additions; not backfilled further than that here). Not re-derived here field-by-field — `domain/gameState.js`'s own JSDoc is the source of truth, to avoid a second copy drifting out of sync |
| `transactions` | `Transaction[]` | Zero or more, in application order — `economy/applyTransaction.js`'s exact return shape, one entry per ledger movement this action caused. Empty array for actions that moved no money (`ROLL_DICE` with no landing effect, `FOLD_AUCTION` that doesn't resolve, ...). This is the array the UI keys balance-change animations off of, rather than diffing two full `gameState.players[].currentBalance` snapshots itself |
| `deadlineAt` | `string \| null` | **P10-T04.** The absolute ISO timestamp the *new* `gameState.phase`'s timer will fire at, per `GAME_STATE_MACHINE.md` §7 ("the client never runs an authoritative timer... broadcasts an absolute `deadlineAt`... The client renders `deadlineAt − now()` locally"). `null` when the resulting phase has no timed default (`stateMachine/timers.js`'s `TIMER_DURATIONS_SECONDS` — system-only phases like `PAYING_RENT`/`BANKRUPTCY_CHECK`, or a finished/aborted game). On reconnect (§5), this reports whatever is *currently* scheduled rather than starting a fresh one — reconnecting must never reset or extend an already-running timeout (§5/§7 of `GAME_STATE_MACHINE.md`) |

**Reconnect note — resolved, P10-T03**: a reconnecting client requests exactly this via `C2S_RECONNECT` (§5) — the server pushes this same `S2C_STATE_UPDATE` shape to just that socket (`transactions: []`, since a resync moved no money), not a new payload shape. See §5 for the full request/response flow.

---

## 3. `S2C_ACTION_REJECTED` (Server → Sender only)

Never broadcast — a rejected action is only ever visible to the socket that sent it.

```json
{
  "clientActionId": "uuid",
  "errorCode": "BID_TOO_LOW",
  "message": "amount 200 does not exceed the current bid 200"
}
```

| Field | Type | Detail |
|---|---|---|
| `clientActionId` | `uuid` | Echoes the rejected action's own id — how the frontend knows *which* pending action to unlock/unblock its UI for, since multiple actions could theoretically be in flight |
| `errorCode` | `string` | See taxonomy below — stable, machine-readable, for client branching logic |
| `message` | `string` | Human-readable detail (usually the thrown error's own `.message`) — for logs/developer console, not for UI branching |

### `errorCode` taxonomy (grounded in what the engine actually throws today)

| `errorCode` | Thrown by | When |
|---|---|---|
| `PHASE_MISMATCH` | `turnMachine.js`'s `InvalidTurnActionError` | `actionType` isn't legal for `gameState.phase` |
| `NOT_AUTHORIZED` | **`[PLANNED, not yet implemented]`** | Originally envisioned for "authenticated sender's real identity doesn't match the action's client-claimed `playerId`" — that literal scenario is now structurally unreachable (Phase 09: a client-supplied `playerId` is never read at all, the server always injects its own resolved `gamePlayer.id`, so there's nothing left to mismatch). Kept reserved rather than repurposed, in case a genuinely distinct authorization gap surfaces later; **turn-ownership specifically is `NOT_YOUR_TURN` below, a separate code, not this one** |
| `NOT_YOUR_TURN` | Socket-layer check (`handleGameAction`, `socketServer.js`) | **Fixed 2026-08-21, closes `SECURITY_DESIGN.md`-adjacent "Known gaps" #5.** The sender's own resolved `gamePlayer.id` doesn't match `getCurrentPlayer(gameState).id` for a turn-scoped action — checked once, before dispatch, for every `actionType` except `PLACE_BID`/`FOLD_AUCTION`/`AUCTION_TIMEOUT` (Flash Auction's own "all players simultaneously, not turn-ordered" rule), `GAMBLE_RENT` (the property owner decides, not necessarily the current-turn player — its own `NOT_OWNER` check above covers actor validation instead), and the 5 trade actions (their own separate `NOT_TARGET`/`NOT_PROPOSER` model) |
| `NOT_A_PARTICIPANT` | Socket-layer check (`handleGameAction`/`handleReconnect`), `engine/trade.js`'s `InvalidTradeError` | Sender has no `game_players` row for this game, or `PROPOSE_TRADE.targetId` doesn't resolve to a real (non-Bank) player in it |
| `BIDDER_NOT_ACTIVE` | `auction.js`'s `InvalidBidError` | `PLACE_BID`/`FOLD_AUCTION` from a player not in `activeBidders` |
| `BID_TOO_LOW` | `auction.js`'s `InvalidBidError` | `PLACE_BID.amount` doesn't strictly exceed `currentBid` |
| `INSUFFICIENT_BALANCE` | `auction.js`'s `InvalidBidError`, `eventResolver.js`'s `EventChoiceError`, `turnMachine.js`'s `InvalidPropertyActionError`, `engine/trade.js`'s `InvalidTradeError` | Bid, event-choice stake, `BUILD_HOUSE`'s `houseCost`, `UNMORTGAGE`'s `mortgageValue × 1.1`, `HOSTILE_BUYOUT`'s `2.0 × (price + buildings)`, `GAMBLE_RENT`'s `pendingRentGamble.amount` (new 2026-08-25 — the owner must still have the rent they collected on hand to risk it; can go stale if they've since spent it elsewhere, since this can sit open indefinitely), or a trade offer's `money` exceeds the sender's *unlocked* `currentBalance` (total minus whatever's already committed to other active trades) |
| `UNKNOWN_OPTION` | `eventResolver.js`'s `EventChoiceError` | `MAKE_EVENT_CHOICE.optionId` doesn't exist on the pending card |
| `CARD_PROTECTED` | `turnMachine.js`'s `InvalidPropertyActionError` | **New 2026-08-25.** `HOSTILE_BUYOUT`'s target is shielded by C08 "Bảo Vệ Tài Sản" — the temporary, card-granted counterpart of `HOUSE_PROTECTED`. Live only while `gameState.propertyProtection` names that property, `roundNumber <= grantedAtRound` (i.e. the owner's next turn has not begun), **and** the property is still owned by the player the protection was granted to — a trade moving it mid-protection voids the shield rather than transferring it |
| `NOT_PROTECTABLE` | `turnMachine.js`'s `InvalidPropertyActionError` | **New 2026-08-25.** C08's `MAKE_EVENT_CHOICE` named a `propertyId` that is not an unimproved property owned by the acting player. Note this card's payload is the one place `MAKE_EVENT_CHOICE` carries a `propertyId` — the choice of *which* property is the card's whole decision, and a static `options` array cannot enumerate live holdings. If the player owns nothing protectable at all (possible via a phase-independent trade after the draw), the choice resolves as a revealed no-op instead of rejecting, so the blocking phase always clears |
| `ALREADY_OWNED` / `NOT_OWNED` | `turnMachine.js`'s `InvalidPropertyActionError` | **New 2026-08-25.** `HOSTILE_BUYOUT`'s target is re-validated for current ownership, not just for the pending window being open: `ALREADY_OWNED` if the buyer has since acquired it themselves (trades are phase-independent, so this is reachable inside the same turn — it previously crashed on a self-to-self `applyTransaction`), `NOT_OWNED` if its owner forfeited or was bankrupted first and it reverted to the Bank |
| `PLAYER_BANKRUPT` | `engine/trade.js`'s `InvalidTradeError` | **New 2026-08-25.** A bankrupt (eliminated) player is a spectator — `PROPOSE_TRADE`/`COUNTER_TRADE`/`ACCEPT_TRADE` reject when *either* side of the offer belongs to one. Checked in `validateOffer`, so it covers both offer sides on all three actions, including `ACCEPT_TRADE`'s re-validation when a counterparty went bankrupt after the offer was made. Every other action type was already unreachable for a bankrupt player (`advanceTurn` skips them → `NOT_YOUR_TURN` for all turn-scoped actions; `startAuction` excludes them from `eligibleBidders`); trades were the one gap, since they are deliberately turn- and phase-independent |
| `NOT_OWNER` | `turnMachine.js`'s `InvalidPropertyActionError`, `engine/trade.js`'s `InvalidTradeError` | `BUILD_HOUSE`/`SELL_HOUSE`/`MORTGAGE`/`UNMORTGAGE.propertyId` isn't owned by the acting player, a trade offer names a `propertyId` the offering side doesn't own, or `GAMBLE_RENT` is sent by someone other than `pendingRentGamble`'s real property owner |
| ~~`INCOMPLETE_GROUP`~~ | ~~`turnMachine.js`'s `InvalidPropertyActionError`~~ | **No longer exists — removed 2026-08-25**, not merely relaxed: `BUILD_HOUSE` no longer requires full color-group ownership at all (see that row above), so this error code can never be thrown any more. Kept here, struck through, per this project's own convention of flagging a divergence rather than silently deleting it |
| `GROUP_MORTGAGED` | `turnMachine.js`'s `InvalidPropertyActionError` | A property sharing `BUILD_HOUSE` target's `groupId` is mortgaged |
| ~~`UNEVEN_BUILD`~~ | ~~`turnMachine.js`'s `InvalidPropertyActionError`~~ | **No longer exists — removed 2026-09-02.** The even-build rule (`BUILD_HOUSE` had to target the group's lowest `upgradeLevel`) was dropped after a measured A/B showed it prevented no exploit and was a holdover from the also-dropped full-group requirement (`PROJECT_STATUS.md`, "even-build rule"; `GAME_DESIGN_SPEC.md` §12). `handleBuildHouse` can never throw this any more. Kept here, struck through, per the same convention as `INCOMPLETE_GROUP` above. The mirror `UNEVEN_SELL` (below) is deliberately **retained** |
| `MAX_UPGRADE_LEVEL` | `turnMachine.js`'s `InvalidPropertyActionError` | `BUILD_HOUSE` target is already at `upgradeLevel = MAX_UPGRADE_LEVEL` (5, a built hotel) |
| `RECENTLY_ACQUIRED` | `turnMachine.js`'s `InvalidPropertyActionError` | **New 2026-08-25.** `BUILD_HOUSE` target's `property.acquiredAtRound` (set by `BUY_PROPERTY`/`HOSTILE_BUYOUT`, untouched by a negotiated trade) is not strictly less than the current `gameState.roundNumber` — the owner must let at least one full round pass (equivalent to "your own next turn has begun", since a property can only ever be acquired during the acquirer's own turn) before building on it. Closes the window a same-turn build would otherwise open to immediately make a freshly-(hostile-)acquired property `HOUSE_PROTECTED` against a further hostile buyout |
| `INSUFFICIENT_SUPPLY` | `turnMachine.js`'s `InvalidPropertyActionError` | **Phase 14.** `BUILD_HOUSE` would need a house but `gameState.houseSupply = 0`, or would need a hotel (the 4th-house-to-hotel conversion) but `gameState.hotelSupply = 0` — the shared 32-house/12-hotel physical set (`GAME_DESIGN_SPEC.md` §12) is fully checked out |
| `NO_HOUSES_TO_SELL` | `turnMachine.js`'s `InvalidPropertyActionError` | `SELL_HOUSE` target is already at `upgradeLevel = MIN_UPGRADE_LEVEL` (0) |
| `UNEVEN_SELL` | `turnMachine.js`'s `InvalidPropertyActionError` | `SELL_HOUSE` target isn't at the group's *highest* `upgradeLevel` (even-sell rule). **As of 2026-09-02 this is the sole surviving "even" constraint** — the build-side `UNEVEN_BUILD` was removed; even-sell is kept because it governs refund order during forced liquidation, a distinct concern from build pacing |
| `ALREADY_MORTGAGED` | `turnMachine.js`'s `InvalidPropertyActionError` | `MORTGAGE` target's `mortgaged` flag is already `true` |
| `INVALID_BASE_PRICE` | `turnMachine.js`'s `InvalidPropertyActionError` | **New 2026-09-03.** `FORCE_AUCTION.basePrice` is not an integer inside `[ceil(price × 0.5), price]`. The floor exists to stop "open a $400 lot at $1", which at 3+ players is a collusion tool (open low, let an ally take it for pocket change) rather than the self-harm it is heads-up; the ceiling exists because opening above the printed price can only manufacture a guaranteed FAILED auction that still burns the fee. `MIN_AUCTION_OPEN_RATIO` (0.5) is V0's original fixed opening bid — see `BOARD_SPECIFICATION.md` |
| `PROPERTY_HAS_HOUSES` | `turnMachine.js`'s `InvalidPropertyActionError` | `MORTGAGE`: the target property itself has `upgradeLevel > 0` — sell its houses first. **[REVISED 2026-08-18 to group-wide, reverted per-property 2026-09-02]** — other lots in the same colour group no longer matter (was `GROUP_HAS_HOUSES` while the check was group-wide; `GAME_DESIGN_SPEC.md` §12) |
| `NOT_MORTGAGED` | `turnMachine.js`'s `InvalidPropertyActionError` | `UNMORTGAGE` target's `mortgaged` flag is already `false` |
| `NO_PENDING_BUYOUT` | `turnMachine.js`'s `InvalidPropertyActionError` | **Phase 14.** `HOSTILE_BUYOUT` sent while `gameState.pendingHostileBuyoutPropertyId` is `null` — no rent payment on another player's property has resolved yet this turn |
| `MONOPOLY_PROTECTED` | `turnMachine.js`'s `InvalidPropertyActionError` | **Phase 14.** `HOSTILE_BUYOUT` target belongs to a color group the current owner fully monopolizes — a completed monopoly can't be forcibly bought out |
| `NOT_A_PLAYER` | `turnMachine.js`'s `InvalidForfeitError` | **2026-08-23.** `FORFEIT_MATCH.playerId` doesn't resolve to a real (non-Bank) player in this game — structurally shouldn't be reachable from a real client (the socket layer already injects the sender's own resolved id), reserved for a genuinely malformed action |
| `ALREADY_ELIMINATED` | `turnMachine.js`'s `InvalidForfeitError` | **2026-08-23.** `FORFEIT_MATCH` from a player whose `bankrupt` flag is already `true` — they've already left the match, nothing left to forfeit |
| `SOLE_SURVIVOR` | `turnMachine.js`'s `InvalidForfeitError` | **2026-08-23.** `FORFEIT_MATCH` would leave zero non-bankrupt players remaining — the sender is the only one left standing, so there's no one to continue the match with. In practice unreachable in a normal game (elimination already ends the match the instant only one player remains), kept as a defensive guard rather than assumed |
| `SELF_TRADE` | `engine/trade.js`'s `InvalidTradeError` | `PROPOSE_TRADE.targetId` equals the sender's own resolved id |
| `ASSET_LOCKED` | `engine/trade.js`'s `InvalidTradeError` | A `PROPOSE_TRADE`/`COUNTER_TRADE` offer names a `propertyId` already offered in a different active trade |
| `TRADE_NOT_FOUND` | `stateMachine/tradeMachine.js`'s `InvalidTradeError` | `COUNTER_TRADE`/`ACCEPT_TRADE`/`REJECT_TRADE`/`CANCEL_TRADE.tradeId` doesn't exist in `pendingTrades` — never existed, already resolved, or lazily pruned as expired (these three causes are deliberately not distinguished, same "don't leak which case" posture `API_CONTRACT.md`'s merged-404 rule already uses elsewhere) |
| `NOT_TARGET` | `stateMachine/tradeMachine.js`'s `InvalidTradeError`, `engine/trade.js`'s `InvalidTradeError` | `COUNTER_TRADE`/`ACCEPT_TRADE`/`REJECT_TRADE` from a sender who isn't the trade's current `targetId` |
| `NOT_PROPOSER` | `stateMachine/tradeMachine.js`'s `InvalidTradeError` | `CANCEL_TRADE` from a sender who isn't the trade's `proposerId` |
| `MAX_COUNTER_DEPTH_EXCEEDED` | `engine/trade.js`'s `InvalidTradeError` | `COUNTER_TRADE` on a trade already at `counterDepth = MAX_COUNTER_DEPTH` (5) |
| `STALE_ACTION` | **`[PLANNED, not yet implemented]`** | `GAME_STATE_MACHINE.md` §6 point 2's `lastSeenStateVersion` staleness check — `idempotency.js` currently implements only the dedup cache and the `stateVersion` counter itself, not this per-target check. Listed here so the contract is honest about the gap, not because it's live |
| `MALFORMED_PAYLOAD` | `handleGameAction`'s generic `TypeError` fallback (`socketServer.js`) | `payload` doesn't match the `actionType`'s expected shape, or `clientActionId` is missing — any plain `TypeError` the engine throws maps here |
| `ROOM_NOT_IN_PROGRESS` | `handleGameAction`/`handleReconnect` (`socketServer.js`) | `C2S_GAME_ACTION` sent while the room's status isn't `in_progress`; or `C2S_RECONNECT` (§5) sent for a room still in the lobby — that case should use the REST join endpoint instead |
| `GAME_NOT_FOUND` | `handleGameAction`/`handleReconnect` (`socketServer.js`, P10-T02/T03) | Room is `in_progress` but no `GameState` could be loaded, from either the in-memory hot store or a durable Supabase snapshot (`gameRepository.js`'s `resolveLiveGameState`) — a real gap, not expected in normal operation |
| `INTERNAL_ERROR` | `handleGameAction`'s catch-all | Any thrown error not matching a known type — a genuine bug, not a validation rejection; surfaced rather than silently swallowed |

---

## 4. Connection & Room Management

### `C2S_JOIN_ROOM` (Client → Server)

```json
{
  "roomId": "uuid"
}
```

| Field | Detail |
|---|---|
| Validation | Sender's authenticated identity (`socket.user.id`, set by the connection-time auth middleware — never a payload field) resolves to a member of the room's player list — **this event attaches a live connection to an existing REST membership, it does not create one** (see the namespace-scope note above) |
| Server result | Socket joins the room's Socket.IO room/broadcast group |
| Broadcast | `S2C_ROOM_JOINED` to **Sender only** on success; `S2C_ACTION_REJECTED` (`NOT_A_PARTICIPANT`) to Sender on failure, for both "room doesn't exist" and "exists but sender isn't a member" — same merged-privacy posture as `API_CONTRACT.md`'s 404 rule. `clientActionId` is optional here, since joining isn't wrapped in the same action-idempotency flow as gameplay moves |

**Revised from this document's first draft** (implemented in `backend/src/infrastructure/websocket/socketServer.js`, P09-T01): the original schema above also listed a `playerId` field, to be cross-checked against the authenticated sender per §1's `NOT_AUTHORIZED` rule. The shipped version drops the field entirely instead — since it would only ever have been cross-checked and never trusted, there's no reason to accept it as wire input at all. `C2S_GAME_ACTION`'s own `playerId` field (§1) is a different case and is **not** revised by this — that field genuinely identifies which *eligible bidder* is acting during `FLASH_AUCTION_ACTIVE`, information the server can't derive from the sender's identity alone (any eligible bidder, not just the current-turn player, may act).

### `S2C_ROOM_JOINED` (Server → Sender)

```json
{
  "roomId": "uuid",
  "playerId": "uuid",
  "members": ["uuid", "uuid"],
  "roomStatus": "waiting"
}
```

| Field | Type | Detail |
|---|---|---|
| `roomId` / `playerId` | `uuid` | Echoes the join request |
| `members` | `uuid[]` | Every `room_players.player_id` currently in the room — lets the client render the lobby without a separate REST fetch |
| `roomStatus` | `string` | The room's current lifecycle status (`rooms.status`, `DATABASE_DESIGN.md`) |

---

## 5. Reconnection & Disconnection (P10-T03)

Resolves this document's own former "Open items" #1/#2 (kept below, marked resolved rather than deleted — same posture `SOCKET_CONTRACT.md` itself got when superseded). Grounded in `GAME_DESIGN_SPEC.md` §23/§24, which already split this by phase: a **lobby** (pre-game) rejoin is the existing REST `join_room` call (`API_CONTRACT.md`) — naturally idempotent, no socket component, untouched by this section. Reconnecting to an **in-progress game** needs a live socket re-attached *and* a state resync, which is what this section is for. `C2S_JOIN_ROOM` (§4) is therefore **not** the reconnect path — §23's own words: "reconnecting to an in-progress game is `game:sync`... not `join_room`".

Scope note, updated by P10-T04: a disconnected player's turn *is* forced along now — §2's `deadlineAt` timer fires on schedule "regardless of connection status" (`GAME_STATE_MACHINE.md` §5), applying that phase's documented default action whether the player is idling online or genuinely offline. What's still not built: `GAME_DESIGN_SPEC.md` §24's own separate `RECONNECT_GRACE_SECONDS` disconnect timer (its practical effect is already subsumed by the — always shorter — phase timer) and §25's `AFK_THRESHOLD_MISSED_TURNS` streak tracking / soft-AFK auto-skip state, both still `[PROPOSED]`.

### `C2S_RECONNECT` (Client → Server)

```json
{
  "roomId": "uuid"
}
```

Same shape and same "never a client-claimed `playerId`" posture as `C2S_JOIN_ROOM` — the acting identity is always `socket.user.id`.

| Field | Detail |
|---|---|
| Validation | Same room-membership check as `C2S_JOIN_ROOM`, plus: `rooms.status` must be `in_progress` (`ROOM_NOT_IN_PROGRESS` otherwise — a lobby rejoin should use REST), a `GameState` must be loadable (`GAME_NOT_FOUND` otherwise), and the sender must have a real seat in it (`NOT_A_PARTICIPANT` otherwise) |
| Server result | Socket (re)joins the room's Socket.IO broadcast group; connection status flips to online |
| Broadcast on success | `S2C_ROOM_JOINED` then `S2C_STATE_UPDATE` (§2's exact shape, `transactions: []`) to **sender only**; `S2C_PLAYER_RECONNECTED` to **everyone else** in the room |
| Broadcast on failure | `S2C_ACTION_REJECTED` to sender only, `clientActionId: null` (this event carries none, same as `C2S_JOIN_ROOM`) |

### `S2C_PLAYER_DISCONNECTED` / `S2C_PLAYER_RECONNECTED` (Server → Room, excluding the affected socket)

```json
{
  "roomId": "uuid",
  "playerId": "uuid"
}
```

`S2C_PLAYER_DISCONNECTED` is triggered by Socket.IO's own built-in `disconnect` transport event — not a message a client ever sends, just the server noticing a socket dropped. Per `GAME_DESIGN_SPEC.md` §24: **a flag, not a removal** — the player stays in `players[]`/`game_players`, simply marked offline; nothing about turn order, ownership, or balance changes. `GAME_STATE_MACHINE.md` §5 is explicit that gameplay itself doesn't pause for this (a live Flash Auction keeps running; the disconnected player just can't bid until they're back).

Connection status (online/offline) is **process-memory only**, matching `DATABASE_DESIGN.md`'s own ephemeral-state note ("connection status... meaningless at rest") — it is never written to `game_state_snapshots.state` (excluded by that table's own documented scope) or to `room_players` (no column exists for it). A server restart implicitly reads every player as online again until proven otherwise, same as that note describes.

---

## 6. Lobby Real-Time Push (`S2C_ROOM_UPDATED`, wired 2026-08-21)

Closes `API_CONTRACT.md` §"Socket events"'s own long-standing note — a REST room mutation "still pushes a lightweight notification over Socket.IO... payload TBD in the Socket.IO contract phase" — left unbuilt since that document was written. Server → Room (every connected socket in `roomId`'s broadcast group, sender included — unlike `S2C_PLAYER_DISCONNECTED`/`RECONNECTED`, there's no "affected socket" to exclude here, every member's own view can go stale the same way).

```json
{
  "roomId": "uuid",
  "roomStatus": "ready_check"
}
```

| Field | Type | Detail |
|---|---|---|
| `roomId` | `uuid` | The room that changed |
| `roomStatus` | `string` | `rooms.status` immediately after the mutation that triggered this push |

Emitted by `room.controller.js`'s `notifyRoomUpdated()` at the end of all five room-mutating REST endpoints — `join`, `ready`, `start`, `leave`, `kick` — right after each one's own `roomRepository.updateRoom()` call succeeds. `req.app.get('io')` (set by `server.js`'s `app.set('io', io)`, the same DI `boardTilesByBoard` already uses) is how a plain REST handler reaches the one real `io` instance without importing `socketServer.js`'s module state directly; optional-chained so a test harness or a boot without a working socket layer degrades to a silent no-op rather than throwing.

**Deliberately minimal, not the full roster** — unlike a hypothetical richer payload, this does **not** carry `players[]`/`displayName`/`isReady`. That shape only exists on the REST side (`API_CONTRACT.md`'s `GET /api/v1/rooms/:id`), which `Lobby.jsx` already fetches correctly; this push is purely "something changed, go re-fetch," the same "the socket message is just...go re-fetch or use what's attached" framing `API_CONTRACT.md`'s own §9 paragraph already described before this was built. `roomStatus` is the one exception, included because it's not just a lobby-polling nicety: `App.jsx`'s own view routing (`LobbyDiagnostic` / `Lobby` / `GameView`) reads `roomState.roomStatus` directly from the client-side store, which only `network/socketClient.js` ever writes to — without `roomStatus` in this push, a non-host player would never see their own view flip to `GameView` the instant the host starts the match; they'd stay stuck on `Lobby` until their next reconnect or their first real `S2C_STATE_UPDATE`. `socketClient.js`'s new `S2C_ROOM_UPDATED` listener merges `roomStatus` into the existing `roomState` and bumps a `roomUpdatedAt` timestamp the store also now carries; `Lobby.jsx` reacts to that bump by immediately re-running its own existing `GET /api/v1/rooms/:id` fetch (kept as a 3s poll too, not replaced — the same "fast path plus an existing fallback, not fast path instead of it" posture this project already used for `GameControls.jsx`'s `handleStart()` local patch).

**Deliberately not built alongside this**: forcibly evicting a *kicked* player's own socket from the room's Socket.IO broadcast group, or telling their client specifically "you were kicked" — this event only ever tells the *remaining* members to refresh. The kicked player's own client finds out passively, the next time any of its own authenticated calls starts failing (`NOT_A_PARTICIPANT`) — a pre-existing UX gap, not one this pass introduces or was asked to close.

---

## Open items this document does not resolve

1. ~~Reconnect/resync equivalent of the superseded contract's `game:sync`~~ — **resolved, §5 (P10-T03)**: `C2S_RECONNECT`, reusing `S2C_STATE_UPDATE`.
2. ~~Whether `C2S_JOIN_ROOM` should also be the reconnect path, or a separate mechanism is needed~~ — **resolved, §5**: a separate mechanism (`C2S_RECONNECT`), per `GAME_DESIGN_SPEC.md` §23's own phase split. `C2S_JOIN_ROOM` stays lobby-only.
3. ~~`NOT_AUTHORIZED`/`MALFORMED_PAYLOAD` are documented as error codes but have no implementing code yet~~ — **`MALFORMED_PAYLOAD` implemented (P07-era `TypeError` fallback), and the turn-ownership gap this item used to gesture at is now its own separate, implemented code — `NOT_YOUR_TURN`, resolved 2026-08-21, see §3's table above.** `NOT_AUTHORIZED` itself remains genuinely unimplemented, but its own originally-envisioned scenario is now structurally unreachable (see its table row) — kept reserved, not deleted, in case a real distinct future gap needs it.
4. The superseded contract's per-effect broadcasts (`game:dice_result`, `game:player_moved`, `game:turn_changed`, `game:balance_updated`, ...) had a real, stated purpose — letting the UI hook specific animations to specific causes without diffing full state. This design accepts that tradeoff (client-side diffing of `gameState` + `transactions` across consecutive `S2C_STATE_UPDATE`s) without re-litigating it; worth confirming that's an accepted cost, not an oversight.
5. `RECONNECT_GRACE_SECONDS` auto-end-turn and `AFK_THRESHOLD_MISSED_TURNS` (`GAME_DESIGN_SPEC.md` §24/§25) — both still `[PROPOSED]`. Not the same gap it used to be: P10-T04 wired the *per-phase* timer (§2's `deadlineAt`, `stateMachine/timers.js`), which already forces a default action regardless of connection status (`GAME_STATE_MACHINE.md` §5) — what's left unbuilt is specifically the disconnect-only 90s grace timer and the cross-turn AFK streak counter, neither of which the phase timer covers by itself.
6. ~~Turn timeouts / "the client never runs an authoritative timer"~~ — **resolved, P10-T04**: `stateMachine/timers.js`'s `TimerManager`/`buildDefaultAction` (built in P07, previously never called from a live socket) is now wired into `socketServer.js` — see §2's `deadlineAt` field.
