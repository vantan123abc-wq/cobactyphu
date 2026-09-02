# CoBacTyPhu — Realtime Socket.IO Contract

> **[SUPERSEDED — see `WEBSOCKET_API.md`]** This document's granular, one-event-per-action-type wire design (24 distinct events, REST-only room join) is no longer the target contract. `WEBSOCKET_API.md` replaces it with a generic `C2S_GAME_ACTION`/`S2C_STATE_UPDATE` envelope and a socket-level `C2S_JOIN_ROOM`. Kept here, not deleted: the idempotency conventions, disconnect/reconnect model, and per-mechanic reasoning below are still useful background even though the wire format itself changed.

Design only — no Socket.IO implemented. `GAME_STATE_MACHINE.md` is the source of truth for states/transitions/timers this document assigns events to; `API_CONTRACT.md` is the source of truth for the REST/socket boundary. Same tagging convention: **[CONFIRMED]**, **[PROPOSED]**, **[OPEN DESIGN DECISION]**.

**[PROPOSED — continues `API_CONTRACT.md`'s revision]** Namespacing moves from "one per room" (architecture doc) to **one per game** (`/game/:gameId`) — now that lobby actions are REST (`API_CONTRACT.md`), nothing needs a live bidirectional channel before a `games` row exists. A socket connects once a client has a `gameId`, either fresh from `POST /api/v1/rooms/:id/start`'s response or from `GET /api/v1/auth/me`'s `activeGameId` on reconnect.

**[PROPOSED — small refinement]** The architecture doc's single `player:presence` event splits into `player:disconnected` and `player:reconnected` below — matches this document's explicit ask for both as distinct events, and each carries different payload (a grace-period deadline only makes sense on disconnect).

---

## Conventions

- **Connection**: JWT in the socket handshake `auth` payload, verified once at connect (architecture doc, unchanged) — not re-verified per event.
- **Broadcast recipients shorthand**: **Room** = every socket connected to this game's namespace. **Sender** = only the originating socket.
- **Timestamps, never durations**: any deadline in a payload is an absolute `deadlineAt` (epoch ms), never `secondsRemaining` — `GAME_STATE_MACHINE.md` §7's rule that the client timer is only a visual read of server time applies to every payload below that carries one.
- **Idempotency, client→server**: every payload implicitly carries a `clientActionId` (UUID) at the transport level, not repeated as a payload field in every table below — dedup and `stateVersion`-staleness checking work exactly as specified in `GAME_STATE_MACHINE.md` §6. Each event's own **Idempotency** row below only calls out what's non-default for that event.
- **Idempotency, server→client**: reframed as *is it safe for a client to receive this twice* (at-least-once delivery is assumed at the transport level) — state-carrying broadcasts are deduped client-side by `stateVersion`; pure notifications (disconnect/reconnect) are naturally safe to receive twice.
- **Server-originated fields**: for the 14 Server → Client events, **Sender authorization** doesn't apply the way it does for a client request — each table instead states the server-side condition that *triggers* the broadcast. **Validation** and **Server result** are correspondingly N/A or brief, since by the time a broadcast fires, validation already happened as part of the client event (or system trigger) that caused it.
- **Error mechanism**: one shared event, `game:invalid_action` (§ Supplementary), used by every client event's **Error behavior** row below — sent to **Sender only**, never broadcast, so a rejected action is never visible to anyone but the player who sent it.

---

## Client → Server

### `game:roll_dice`

| Field | Detail |
|---|---|
| Direction | Client → Server |
| Payload | `{}` — nothing to supply; the result is entirely server-generated |
| Sender authorization | Current-turn player only |
| Current state requirement | `ROLLING`, or the roll-for-doubles branch of `JAIL_DECISION` |
| Validation | Sender matches `players[currentTurnIndex].userId`; phase check (`GAME_STATE_MACHINE.md` §4) |
| Idempotency | Default (`clientActionId` dedup); no `stateVersion` staleness check needed — this action doesn't target anything that could have changed out from under it |
| Server result | Dice generated (**[CONFIRMED]** — this is the one event that most directly proves the client never determines the dice result, since the client sends nothing and only ever *receives* `game:dice_result`); movement computed; tile resolved — this single event can cascade through `MOVING → LANDING →` whichever resolution state applies |
| Broadcast recipients | Room, via `game:dice_result` + `game:player_moved` + `game:state_update`, plus whatever the landed tile triggers |
| Error behavior | `NOT_YOUR_TURN` / `PHASE_MISMATCH` → `game:invalid_action`, Sender |

### `game:buy_property`

| Field | Detail |
|---|---|
| Direction | Client → Server |
| Payload | `{}` — the tile is the player's current position, not client-supplied (`GAME_DESIGN_SPEC.md` §10) |
| Sender authorization | Current-turn player only |
| Current state requirement | `AWAITING_PURCHASE` |
| Validation | Tile's live `owner_id` is null (server's copy); `balance >= price` (server's copy of both — never the client's) |
| Idempotency | Default |
| Server result | Ownership transfer (`properties.owner_id` set), one `game_transactions` row (type `purchase`), phase → `POST_ACTIONS` |
| Broadcast recipients | Room, via `game:property_ownership_changed` + `game:balance_updated` + `game:state_update` |
| Error behavior | `INSUFFICIENT_FUNDS` / `TARGET_ALREADY_OWNED` / `PHASE_MISMATCH` → `game:invalid_action`, Sender |

### `game:decline_purchase`

| Field | Detail |
|---|---|
| Direction | Client → Server |
| Payload | `{}` |
| Sender authorization | Current-turn player only |
| Current state requirement | `AWAITING_PURCHASE` |
| Validation | Phase check only |
| Idempotency | Default |
| Server result | Phase → `POST_ACTIONS`, or → `FLASH_AUCTION_ACTIVE` if that mechanic is adopted (`GAME_STATE_MACHINE.md` §3) |
| Broadcast recipients | Room, via `game:state_update`, or `game:auction_started` if the auction path is taken |
| Error behavior | `PHASE_MISMATCH` → `game:invalid_action`, Sender |

### `game:auction_bid` — **[PROPOSED mechanic, Flash Auction]**

| Field | Detail |
|---|---|
| Direction | Client → Server |
| Payload | `{ amount: number }` |
| Sender authorization | **Any player in the game**, current-turn or not — the entire point of this mechanic (`BOARD_SPECIFICATION.md` Part 2) |
| Current state requirement | `FLASH_AUCTION_ACTIVE` |
| Validation | `amount > currentHighBid`; `sender.balance >= amount` — both checked against the server's live figures |
| Idempotency | Default, plus one nuance: bids aren't validated against a `stateVersion` the client last saw — they're validated against whatever the current high bid *is at the moment the server processes them*, in arrival order, per the single-threaded per-room mutation guarantee (`GAME_STATE_MACHINE.md` §5). A bid that was valid when sent but arrives after a higher one is simply rejected, not specially reconciled |
| Server result | New high bid recorded; bidding window extended by `FLASH_AUCTION_BID_RESET_SECONDS` |
| Broadcast recipients | Room, via `game:auction_updated` |
| Error behavior | `BID_TOO_LOW` / `INSUFFICIENT_FUNDS` / `PHASE_MISMATCH` (auction already settled) → `game:invalid_action`, Sender |

### `game:risk_reward_choice` — **[PROPOSED mechanic, Rent Risk Choice]**

| Field | Detail |
|---|---|
| Direction | Client → Server |
| Payload | `{ choice: "standard" \| "gamble" }` |
| Sender authorization | The property **owner** specifically — not the current-turn player, not the visitor. Easy to mix up; worth stating explicitly since this is the one decision in the whole contract made by someone other than whoever's turn it is |
| Current state requirement | `RENT_RISK_DECISION` |
| Validation | Sender is the tile's owner |
| Idempotency | Default |
| Server result | `standard` → fixed rent applied. `gamble` → server rolls (**[CONFIRMED]** server-side, same principle as dice), `2× rent` or `0` applied |
| Broadcast recipients | Room, via `game:rent_resolved` + `game:balance_updated` |
| Error behavior | `NOT_AUTHORIZED` (wrong sender) / `PHASE_MISMATCH` → `game:invalid_action`, Sender |

### `game:initiate_hostile_acquisition` — **[PROPOSED mechanic]**

| Field | Detail |
|---|---|
| Direction | Client → Server |
| Payload | `{ targetTileId: string, offerAmount: number }` |
| Sender authorization | Current-turn player, during their own `POST_ACTIONS` — not a mid-turn interrupt any player can throw (`GAME_STATE_MACHINE.md` §3's explicit design choice) |
| Current state requirement | `POST_ACTIONS` |
| Validation | Sender is current-turn player; `targetTileId` is owned by another player (not the Bank, not the sender); `offerAmount` meets the proposed minimum floor (`BOARD_SPECIFICATION.md`: ≥150% of price or mortgage value — still **[OPEN]**, unresolved by this document); sender has sufficient funds to cover the offer |
| Idempotency | Default |
| Server result | Phase → `HOSTILE_ACQUISITION_PENDING`; no funds move yet — that only happens on the target's response |
| Broadcast recipients | Room, via `game:state_update` (the phase change itself conveys "awaiting a decision from the target player" — no separate notification event invented for this, to avoid redundancy) |
| Error behavior | `NOT_YOUR_TURN` / `INVALID_TARGET` / `OFFER_TOO_LOW` / `INSUFFICIENT_FUNDS` → `game:invalid_action`, Sender |

### `game:respond_hostile_acquisition` — **[PROPOSED mechanic]**

| Field | Detail |
|---|---|
| Direction | Client → Server |
| Payload | `{ response: "block" \| "accept" }` — not a plain boolean: blocking (paying a defense fee) and accepting are genuinely different outcomes, not opposites of the same action |
| Sender authorization | The target player specifically |
| Current state requirement | `HOSTILE_ACQUISITION_PENDING` |
| Validation | Sender is the target; if `block`, sender has funds for the defense fee |
| Idempotency | Default |
| Server result | `block` → defense fee charged to target, no ownership transfer. `accept` → ownership transfers to the acquiring player, offer amount charged. Either way, phase → `POST_ACTIONS`. **[OPEN, carried from `GAME_STATE_MACHINE.md` §3]**: what happens if this event never arrives before `HOSTILE_ACQUISITION_RESPONSE_TIMEOUT_SECONDS` — blocked-by-default or forced-through — is still unresolved |
| Broadcast recipients | Room, via `game:property_ownership_changed` (if accepted) + `game:balance_updated` + `game:state_update` |
| Error behavior | `NOT_AUTHORIZED` / `INSUFFICIENT_FUNDS` / `PHASE_MISMATCH` → `game:invalid_action`, Sender |

### `game:acknowledge_event` — **interpretation flagged, see note below**

| Field | Detail |
|---|---|
| Direction | Client → Server |
| Payload | `{}` |
| Sender authorization | Any connected player |
| Current state requirement | Any — purely cosmetic, gates nothing |
| Validation | None |
| Idempotency | N/A — no state-changing effect, safe to send any number of times or never |
| Server result | **None.** `DRAWING_CARD` already auto-resolves and advances the state machine before this could even be sent (`GAME_STATE_MACHINE.md` §2) |
| Broadcast recipients | None (or an optional no-op ack to Sender only) |
| Error behavior | None — there's nothing to reject |

**Why this one is flagged rather than confidently specified**: "resolve event" in your request doesn't map cleanly onto anything in `GAME_STATE_MACHINE.md`, because event-card effects (`GAME_DESIGN_SPEC.md` §13) are all deterministic — none of them require a *choice* from the drawing player, and the state machine already auto-advances past `DRAWING_CARD` without waiting for one. My best-effort reading is that this is a UI "continue" acknowledgment for pacing (so the table has a moment to read the card before the game visually moves on), not a server-validated decision. If you meant something else by "resolve event" — a card variant that *does* require a choice, for instance — this event needs to be redesigned, not just approved.

### `game:end_turn`

| Field | Detail |
|---|---|
| Direction | Client → Server |
| Payload | `{}` |
| Sender authorization | Current-turn player only |
| Current state requirement | `POST_ACTIONS` |
| Validation | Sender is current-turn player; no mandatory payment (rent/tax) still pending |
| Idempotency | Default |
| Server result | Advance to next non-bankrupt player, or same player again if the last roll was doubles (under `MAX_CONSECUTIVE_DOUBLES`) |
| Broadcast recipients | Room, via `game:turn_changed` + `game:state_update` |
| Error behavior | `NOT_YOUR_TURN` / `PENDING_PAYMENT` → `game:invalid_action`, Sender |

### `game:sync` — reconnect / synchronize state

| Field | Detail |
|---|---|
| Direction | Client → Server |
| Payload | `{}` — identity comes from the JWT already verified at socket connection, not the payload |
| Sender authorization | Any authenticated user who is a **participant** of this game (a real row in `game_players`, checked by `player_id`, matched by `userId` — never by socket id, per `GAME_DESIGN_SPEC.md` §23) |
| Current state requirement | Any — the one event valid in every phase, including terminal ones |
| Validation | Sender's `userId` resolves to a `game_players` row for this `gameId` |
| Idempotency | **Naturally idempotent — the only client event with no mutating effect at all.** Always safe to send, any number of times; always just reports current truth |
| Server result | `connected → true` (in-memory only, not persisted — § ephemeral note, `DATABASE_DESIGN.md`); cancels a pending AFK-mark timer if one was running |
| Broadcast recipients | **Sender** gets a full `game:state_update`. **Room** gets `player:reconnected` |
| Error behavior | `NOT_A_PARTICIPANT` → `game:invalid_action`, Sender (connection is not established for this game) |

---

## Server → Client

### `game:state_update`

| Field | Detail |
|---|---|
| Direction | Server → Client |
| Payload | Full `GameState` (`GAME_DESIGN_SPEC.md` §2) + `stateVersion` |
| Trigger (in place of sender authorization) | After every validated state-changing client event or system-triggered transition |
| Current state requirement | N/A |
| Validation | N/A — the underlying action was already validated before this fires |
| Idempotency | Client dedupes by `stateVersion`; a broadcast with a version the client already has is a no-op to apply |
| Server result | N/A — this event *is* the result |
| Broadcast recipients | Room (plus targeted redelivery to a single reconnecting socket, per `game:sync`) |
| Error behavior | N/A — a client that misses one due to a dropped connection recovers via `game:sync` |

### `game:player_moved`

| Field | Detail |
|---|---|
| Direction | Server → Client |
| Payload | `{ playerId, fromPosition, toPosition, passedGo: boolean }` |
| Trigger | `MOVING` resolution, following a validated `game:roll_dice` (or a card effect with `move_to`/`move_relative`) |
| Current state requirement | N/A |
| Validation | N/A |
| Idempotency | Safe to receive twice — a client re-applying the same move is a no-op once `game:state_update` has already landed |
| Server result | N/A |
| Broadcast recipients | Room |
| Error behavior | N/A |

### `game:dice_result`

| Field | Detail |
|---|---|
| Direction | Server → Client |
| Payload | `{ playerId, die1, die2, isDouble, doublesStreak }` |
| Trigger | `ROLLING` resolution |
| Current state requirement | N/A |
| Validation | N/A |
| Idempotency | Safe to receive twice |
| Server result | N/A |
| Broadcast recipients | Room |
| Error behavior | N/A — **[CONFIRMED]** this is the *only* place a dice value ever appears in this contract; no client event carries one in either direction as input |

### `game:property_ownership_changed`

| Field | Detail |
|---|---|
| Direction | Server → Client |
| Payload | `{ tileId, previousOwnerId, newOwnerId, reason }` — `reason ∈ purchase \| mortgage \| unmortgage \| trade \| flash_auction \| hostile_acquisition \| bankruptcy_transfer` |
| Trigger | Any ownership-changing resolution (`properties.owner_id` write, `DATABASE_DESIGN.md` §8) |
| Current state requirement | N/A |
| Validation | N/A |
| Idempotency | Safe to receive twice |
| Server result | N/A |
| Broadcast recipients | Room |
| Error behavior | N/A |

### `game:auction_started` — **[PROPOSED mechanic]**

| Field | Detail |
|---|---|
| Direction | Server → Client |
| Payload | `{ tileId, minimumBid, deadlineAt }` |
| Trigger | `game:decline_purchase` leading into `FLASH_AUCTION_ACTIVE` |
| Current state requirement | N/A |
| Validation | N/A |
| Idempotency | Safe to receive twice |
| Server result | N/A |
| Broadcast recipients | Room |
| Error behavior | N/A |

### `game:auction_updated` — **[PROPOSED mechanic]**

| Field | Detail |
|---|---|
| Direction | Server → Client |
| Payload | `{ currentHighBid, currentHighBidderId, deadlineAt }` — `deadlineAt` reflects the reset window after this bid |
| Trigger | A validated `game:auction_bid` |
| Current state requirement | N/A |
| Validation | N/A |
| Idempotency | Client keeps the latest by `deadlineAt`/arrival order — safe to receive out of exact order given the underlying bid processing is already serialized server-side |
| Server result | N/A |
| Broadcast recipients | Room |
| Error behavior | N/A |

### `game:auction_ended` — **[PROPOSED mechanic]**

| Field | Detail |
|---|---|
| Direction | Server → Client |
| Payload | `{ tileId, winnerId: string \| null, finalPrice: number \| null }` — both null if no bids were placed |
| Trigger | `FLASH_AUCTION_WINDOW_SECONDS` (extended form) expiring with no further bid |
| Current state requirement | N/A |
| Validation | N/A |
| Idempotency | Safe to receive twice |
| Server result | N/A |
| Broadcast recipients | Room |
| Error behavior | N/A |

### `game:rent_resolved`

| Field | Detail |
|---|---|
| Direction | Server → Client |
| Payload | `{ tileId, payerId, ownerId, amount, wasGamble: boolean }` |
| Trigger | `PAYING_RENT` (standard) or `RENT_RISK_DECISION` (gamble) resolution |
| Current state requirement | N/A |
| Validation | N/A |
| Idempotency | Safe to receive twice |
| Server result | N/A |
| Broadcast recipients | Room |
| Error behavior | N/A — **[CONFIRMED]** `amount` is always server-computed (`GAME_DESIGN_SPEC.md` §11); no client event in this contract ever supplies a rent figure |

### `game:event_resolved`

| Field | Detail |
|---|---|
| Direction | Server → Client |
| Payload | `{ playerId, deck: "chance" \| "fortune", cardText, effect, effectDetails }` |
| Trigger | `DRAWING_CARD` auto-resolution |
| Current state requirement | N/A |
| Validation | N/A |
| Idempotency | Safe to receive twice |
| Server result | N/A |
| Broadcast recipients | **Room** — classic rule, drawn card text is visible to everyone, not just the drawer (`GAME_DESIGN_SPEC.md` §13) |
| Error behavior | N/A |

### `game:balance_updated`

| Field | Detail |
|---|---|
| Direction | Server → Client |
| Payload | `{ playerId, previousBalance, newBalance, delta, reason }` |
| Trigger | Any `game_transactions` write |
| Current state requirement | N/A |
| Validation | N/A |
| Idempotency | Safe to receive twice |
| Server result | N/A |
| Broadcast recipients | Room |
| Error behavior | N/A — **deliberately redundant with `game:state_update`**, kept as its own event so the client can hook a specific coin-counter animation to a specific transaction reason, rather than diffing a full state dump to figure out what changed and why. Not a second source of truth — the balance itself still comes from the ledger |

### `game:turn_changed`

| Field | Detail |
|---|---|
| Direction | Server → Client |
| Payload | `{ previousPlayerId, currentPlayerId, turnNumber, isDoublesReroll: boolean }` |
| Trigger | `END_TURN → NEXT_PLAYER`, or `END_TURN → ROLLING` (doubles) |
| Current state requirement | N/A |
| Validation | N/A |
| Idempotency | Safe to receive twice |
| Server result | N/A |
| Broadcast recipients | Room |
| Error behavior | N/A |

### `player:disconnected`

| Field | Detail |
|---|---|
| Direction | Server → Client |
| Payload | `{ playerId, gracePeriodDeadline }` — `deadlineAt`-style timestamp for `RECONNECT_GRACE_SECONDS` |
| Trigger | Socket `disconnect` event for a participant |
| Current state requirement | N/A |
| Validation | N/A |
| Idempotency | Safe to receive twice |
| Server result | N/A — the player is flagged `connected: false` in memory only (never persisted, § ephemeral note) |
| Broadcast recipients | Room |
| Error behavior | N/A |

### `player:reconnected`

| Field | Detail |
|---|---|
| Direction | Server → Client |
| Payload | `{ playerId }` |
| Trigger | A validated `game:sync` from a previously-disconnected participant |
| Current state requirement | N/A |
| Validation | N/A |
| Idempotency | Safe to receive twice |
| Server result | N/A |
| Broadcast recipients | Room. The reconnecting player's own socket additionally receives a full `game:state_update` (via `game:sync`'s own response, not this event) — everyone *else* only needs the lighter notification |
| Error behavior | N/A |

### `game:finished`

| Field | Detail |
|---|---|
| Direction | Server → Client |
| Payload | `{ resultType, winnerId, standings: [{ playerId, finalRank, finalBalance, bankruptAt }] }` — deliberately the same shape as `GET /api/v1/games/:id/result` (`API_CONTRACT.md`), so a client that receives this live and a client that queries it later after refreshing see identical data |
| Trigger | `GAME_OVER_CHECK` → macro `GAME_ENDING` → `GAME_FINISHED` (`GAME_STATE_MACHINE.md` §1) |
| Current state requirement | N/A |
| Validation | N/A |
| Idempotency | Safe to receive twice |
| Server result | N/A |
| Broadcast recipients | Room |
| Error behavior | N/A — **[CONFIRMED]** the winner is always server-declared here; no client event in this contract ever asserts a win or loss |

---

## Supplementary events

Not part of the requested 24, included because several **Error behavior** rows above depend on them existing.

- **`game:invalid_action`** (Server → Client, Sender only) — `{ code, message, relatedClientActionId }`. The single rejection mechanism for every client event above. Shared error codes: `NOT_YOUR_TURN`, `PHASE_MISMATCH`, `INSUFFICIENT_FUNDS`, `TARGET_ALREADY_OWNED`, `INVALID_TARGET`, `STALE_ACTION`, `BID_TOO_LOW`, `OFFER_TOO_LOW`, `NOT_AUTHORIZED`, `NOT_A_PARTICIPANT`, `PENDING_PAYMENT` (extends `GAME_DESIGN_SPEC.md` §26's list with the ones this document introduces).
- **`game:log_entry`** (Server → Client, Room) — `{ text, ts }`, appended to the activity feed alongside most of the events above. Not given a full table since it carries no gameplay authority of its own — it's a narration layer over events that already exist.

---

## The client never determines — proof by event mapping

Every item from your list, mapped to the one server event that's its sole source of truth, and confirmed absent from every client→server payload above.

| Never client-determined | Sole authoritative event | Confirmed absent from client payloads |
|---|---|---|
| Dice result | `game:dice_result` | `game:roll_dice` carries `{}` — no die values in either direction from the client |
| Balance | `game:balance_updated` (and `game:state_update`) | No client event carries an amount that becomes a balance directly — `game:auction_bid`'s `amount` is validated against server state, not trusted as a balance change |
| Property ownership | `game:property_ownership_changed` | `game:buy_property`, `..._hostile_acquisition` carry no ownership assertion, only intent |
| Rent | `game:rent_resolved` | No client event supplies a rent figure — `game:risk_reward_choice` only supplies which *option* was picked, not an amount |
| Winner | `game:finished` | No client event exists that could assert a win |
| Auction winner | `game:auction_ended` | `game:auction_bid` only ever asserts "I bid X," never "I won" |
| Game state | `game:state_update` | No client event carries a state payload — every one carries only an intent (`roll`, `buy`, a choice) |

---

## Decisions requiring your approval

1. `game:acknowledge_event`'s interpretation — flagged in place above as the one event this document isn't confident about.
2. Namespace-per-game (revising architecture doc's namespace-per-room) — confirm this follows correctly from `API_CONTRACT.md`'s lobby-to-REST move.
3. Hostile Acquisition's timeout default (block vs. forced-through) — still open since `BOARD_SPECIFICATION.md`, now also blocking `game:respond_hostile_acquisition`'s timeout row specifically.
4. Hostile Acquisition's minimum-offer floor (≥150%, `BOARD_SPECIFICATION.md`) — still a proposed number, now load-bearing for `game:initiate_hostile_acquisition`'s validation.
5. Whether `game:balance_updated` firing alongside `game:state_update` on every transaction is worth the redundancy, or whether relying on the client to diff state updates is preferred instead.
