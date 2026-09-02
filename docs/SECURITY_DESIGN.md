# CoBacTyPhu — Security & Server Authority Design

Review, not new design — no source code touched. Threat-models the architecture across all eight prior documents (Architecture doc, `GAME_DESIGN_SPEC.md`, `BOARD_SPECIFICATION.md`, `ADAPTIVE_BOARD_DESIGN.md`, `GAME_STATE_MACHINE.md`, `ECONOMY_SPECIFICATION.md`, `DATABASE_DESIGN.md`, `API_CONTRACT.md`, `SOCKET_CONTRACT.md`). Most of the 15 threats below turn out to be **already mitigated** by earlier decisions — this document's real value is the handful of genuine gaps it surfaces along the way (§ Gaps found), not re-announcing protections that already exist.

---

## Server-authority boundary

One line, restated from the very first architecture pass and unbroken since: **the client supplies intent, never fact.** Concretely:

| The server alone determines | The client may only ever supply |
|---|---|
| Dice results | "I want to roll" — no value attached |
| Player balance | An action *type* (buy, pay, bid) — never a resulting balance |
| Property ownership | "I want to buy/acquire this" — never an ownership claim |
| Rent amounts | Which *option* was chosen (standard/gamble) — never a figure |
| Turn order / whose turn it is | Nothing — purely read |
| Auction winners and final prices | A bid *amount* — validated against server truth before ever becoming the new high bid |
| Win/loss and final standings | Nothing — purely read |
| The live `GameState` itself | Nothing — every write path is server-only, no exceptions |

Verified while writing this document: no payload across `SOCKET_CONTRACT.md`'s 10 client→server events, or `API_CONTRACT.md`'s REST bodies, contains a field through which a client could assert any of the left column directly. Where a client-supplied number exists at all (`game:auction_bid.amount`, `game:initiate_hostile_acquisition.offerAmount`), it's always treated as a *proposal to validate*, never a fact to record.

---

## Threat model

### 1. Client-side balance manipulation

| Field | Detail |
|---|---|
| Threat | A client asserts or influences its own or another player's balance |
| Attack | Modify a `game:state_update` payload locally (only fools the attacker's own screen); craft an event with an injected `balance`/`newBalance` field hoping a handler trusts it |
| Impact | Unearned funds, corrupted economy, invalidates `ECONOMY_SPECIFICATION.md` §4's invariant if it ever succeeded |
| Mitigation | Balance is never client-writable anywhere in the contract — server-computed on every transaction |
| Server validation | Strict payload schema per event — **unexpected fields are rejected, not silently ignored**, so an injected `balance` field fails validation outright rather than being dropped and hoped-not-to-matter |
| Database protection | No `authenticated`-role write policy on `game_transactions`/`game_players` (`DATABASE_DESIGN.md` RLS strategy); `CHECK (current_balance >= 0 OR is_bank)` |
| Test case | Send a valid `game:buy_property` with an added `{ balance: 999999 }` field; assert `400`-equivalent schema rejection, not silent stripping-and-continue |

### 2. Fake dice results

| Field | Detail |
|---|---|
| Threat | A client supplies or predicts a favorable roll |
| Attack | Send `game:roll_dice` with an injected result field; attempt to broadcast a spoofed `game:dice_result` directly to other players |
| Impact | Cheating, broken fairness, loss of trust in the whole match |
| Mitigation | `game:roll_dice`'s payload is `{}` — structurally nothing to inject. Direct client-to-client broadcast is **impossible at the transport level**, not just disallowed by convention — Socket.IO clients can only emit to the server; only the server can `emit` to a room |
| Server validation | Handler generates `die1`/`die2` itself and never reads the incoming payload at all |
| Database protection | `game_actions.payload` for a `roll_dice` row records what the server generated, never an echo of client input |
| Test case | The reliable test here is static, not statistical: assert the roll-handler function has no code path that reads a die value from its input. A probabilistic "roll 1000 times, check the distribution" test is weaker — it could pass by chance even with a real vulnerability present |

### 3. Fake property ownership

| Field | Detail |
|---|---|
| Threat | A client claims ownership it doesn't have, to unlock rent collection, building, or mortgaging |
| Attack | Send a build/mortgage-style action targeting a tile the sender doesn't own |
| Impact | Free buildings, uncollectable rent collected anyway, ownership confusion |
| Mitigation | `properties.owner_id` is the sole source of truth, checked fresh on every ownership-dependent action, never inferred from anything the client asserts about "my properties" |
| Server validation | Re-read `properties.owner_id` (or the in-memory equivalent) at action time; reject if it doesn't match the sender |
| Database protection | No client write policy on `properties`; `UNIQUE (game_id, board_tile_id)` prevents two conflicting ownership rows for the same tile |
| Test case | Attempt to build/mortgage/collect on a tile owned by another player, assert rejection regardless of what the client's local UI believed |
| **Gap noted while reviewing this threat** | `build_house`, `mortgage`, `unmortgage`, and trade events are referenced in `GAME_DESIGN_SPEC.md` §12 but weren't given full event contracts in `SOCKET_CONTRACT.md` (Phase 09's scope was the 9 explicitly requested actions). The *principle* above holds regardless of their eventual shape, but this document can't fully verify their validation until they're formally specified — see § Gaps found |

### 4. Fake auction bids

| Field | Detail |
|---|---|
| Threat | A bid the bidder can't cover, or a claimed auction win that didn't happen |
| Attack | `game:auction_bid` with `amount` exceeding actual balance; rapid bid-flooding to disrupt legitimate bidders |
| Impact | Winning a property at a price that can't be paid; denial-of-service within the auction window |
| Mitigation | `sender.balance >= amount` re-checked at the moment each bid is processed, not just at settlement |
| Server validation | Solvency + `amount > currentHighBid` checked per bid, in server-processed arrival order (`GAME_STATE_MACHINE.md` §5) |
| Database protection | **Genuinely thin here** — there's no `auctions` table by design (`DATABASE_DESIGN.md` §"ephemeral"), so nothing protects the bidding process itself at the DB level. The eventual settlement transaction is protected the same way any `game_transactions` row is (`CHECK (amount > 0)`), but that's after the fact, not during. Worth being honest that this threat's protection is entirely in-process, not defense-in-depth at the DB layer |
| Test case | Bid above current balance, assert `INSUFFICIENT_FUNDS` and no change to `currentHighBid`; fire many rapid bids from one socket, assert rate limiting (§12) engages before they reach the auction logic |

### 5. Duplicate actions

| Field | Detail |
|---|---|
| Threat | The same logical action applied more than once |
| Attack | Double-click; a client or network layer retrying a request that already succeeded |
| Impact | Double-charged rent, double-purchased property, corrupted ledger |
| Mitigation | `clientActionId` dedup (`GAME_STATE_MACHINE.md` §6) |
| Server validation | Short-lived per-socket cache of recently-processed ids; a repeat is a no-op re-acknowledgment |
| Database protection | `UNIQUE (game_id, client_action_id) WHERE client_action_id IS NOT NULL` on `game_actions` — the durable backstop if the in-memory cache ever misses one (e.g. right after a restart) |
| Test case | Send the same `clientActionId` twice within the cache window, assert exactly one `game_actions` row and one applied effect |

### 6. Replay attacks

| Field | Detail |
|---|---|
| Threat | A captured, legitimate message resent later — distinct from #5's accidental duplication: this is deliberate reuse, potentially after meaningful time has passed |
| Attack | Capture a valid event (and the JWT that authorized it) and resend it after the game state has moved on; attempt to open a *new* connection later with a captured, now-expired JWT |
| Impact | Applying an action against outdated assumptions; continued unauthorized access if a stolen token stayed valid indefinitely |
| Mitigation | JWT expiry (short-lived, Supabase-managed) means a captured token stops working for *new* connections once expired; `stateVersion` staleness catches actions replayed against outdated context |
| Server validation | JWT signature + expiry checked at connect. **Worth stating precisely, not glossing over**: it is *not* re-checked for the lifetime of an already-open socket — a long-lived connection can outlive the JWT that opened it. This is an accepted tradeoff (common for persistent connections), not an oversight, but it means JWT expiry alone isn't a mechanism for *revoking* an already-connected player mid-match — that would need a separate kick/ban action, which doesn't exist yet (see § Gaps found) |
| Database protection | `UNIQUE (idempotency_key)` on `game_transactions` — the final backstop even if a replay somehow got past every application-level check |
| Test case | Capture a valid action, let its `stateVersion` go stale (other actions occur), replay it, assert `STALE_ACTION`. Separately: let a JWT expire, attempt a *new* socket connection with it, assert the connection itself is refused |

### 7. Stale actions

| Field | Detail |
|---|---|
| Threat | A legitimately-sent action arrives after the state it was based on already changed — the "honest but late" case, distinct from #6's deliberate resend, though the mechanism overlaps |
| Attack | Not adversarial in the common case (network lag), but *can* be weaponized: deliberately holding an action and releasing it at a chosen moment to try to win a race — this overlaps with #14 and is cross-referenced there |
| Impact | Incorrect state application if unprotected; at minimum, player confusion |
| Mitigation | `stateVersion` echoed by the client on target-specific actions, checked against the server's current value |
| Server validation | `STALE_ACTION` rejection on mismatch |
| Database protection | `UNIQUE (game_id, state_version)` on `game_actions` |
| Test case | Simulate two clients acting on the same `stateVersion` where only one can legitimately succeed (e.g. both buying the same tile); assert exactly one succeeds and the other gets a clean, specific rejection — not a corrupted or partially-applied state |

### 8. Unauthorized room access

| Field | Detail |
|---|---|
| Threat | Viewing or acting within a room/game without membership |
| Attack | Brute-force the 6-character join code (room UUIDs aren't realistically guessable); attempt to connect to a game's Socket.IO namespace without being a participant |
| Impact | Viewing a private room, disrupting a game one shouldn't be in |
| Mitigation | `404` for both "not found" and "found but not a member" (`API_CONTRACT.md`); strict join-endpoint rate limiting; `game:sync`'s `NOT_A_PARTICIPANT` rejection |
| Server validation | Membership re-checked on every room/game-scoped REST call and socket event. **Refinement added by this review**: the socket *namespace connection itself* should reject a non-participant at handshake time, before any event is processed — not just at the individual-event level. Not explicitly stated this precisely in `SOCKET_CONTRACT.md`; recommending it be tightened there |
| Database protection | RLS `SELECT` policies scoped to membership (defense-in-depth, not the primary path — `DATABASE_DESIGN.md`); composite/unique keys prevent duplicate or conflicting membership rows |
| Test case | `GET /api/v1/rooms/:id` for a room the caller isn't in, assert `404` not `403`; attempt `game:sync` for a non-participant, assert rejection *at connection*, not just at the first event |

### 9. Player impersonation

| Field | Detail |
|---|---|
| Threat | Acting as another user |
| Attack | Forge a JWT (cryptographically infeasible if Supabase's signing key holds — this is the **root trust anchor** of the entire design; everything downstream assumes it); steal an already-issued, valid JWT (via XSS, a compromised device) |
| Impact | Full impersonation within the game — could drain another player's balance via otherwise-legitimate-looking actions |
| Mitigation | JWT signature verification for forgery; for theft, **explicitly out of this backend's threat model** — a stolen-but-valid token is indistinguishable from a legitimate one server-side, and defending against theft is a client/frontend security concern (secure token storage, XSS prevention), not something this architecture can fix at the backend |
| Server validation | Every identity check across REST and Socket.IO uses `req.user.id`/`socket.data.userId`, derived solely from the verified JWT. **Confirmed while reviewing this threat**: no event or endpoint payload anywhere in `SOCKET_CONTRACT.md`/`API_CONTRACT.md` lets a client assert "I am player X" — identity is never a payload field, always derived from the credential |
| Database protection | `profiles.id` anchors to `auth.users(id)` — identity isn't reimplemented anywhere else in the schema |
| Test case | Send a valid action with a JWT for player A, assert the server treats it as player A's action under every circumstance — there's no field to even attempt asserting otherwise, so this is really a schema/code-review-level check, not a runtime one |

### 10. Admin manipulation

| Field | Detail |
|---|---|
| Threat | Abuse of an elevated role |
| Attack | A non-host attempting a host-only action |
| Impact | Premature/unwanted game starts, lobby disruption |
| Mitigation | `sender === rooms.host_id`, checked server-side against the DB column |
| Server validation | Host check never trusts a client claim of "I am the host" |
| Database protection | `rooms.host_id` is `service_role`-only writable; changes only via the server-controlled host-transfer-on-leave logic |
| Test case | Non-host calls `POST /rooms/:id/start`, assert `403 NOT_HOST` |
| **Note** | **No site-wide admin role exists anywhere in the current design** — no moderation, no ban capability, no admin dashboard. This isn't a gap to fix now (nothing calls for one yet), but it means this threat category is currently scoped to *host* privilege only. If a real admin role is added later, it needs its own dedicated security pass — it can't be threat-modeled here because it doesn't exist yet |

### 11. Socket event abuse

| Field | Detail |
|---|---|
| Threat | Malformed, oversized, or nonsensical payloads probing for crashes or unexpected behavior |
| Attack | Wrong-typed fields (`amount: "not a number"`), oversized strings, unrecognized event names, rapid malformed-event spam |
| Impact | **The severe case is worth stating plainly**: this backend holds many concurrent games in one Node process (established from the first architecture pass). An unhandled exception from *one* malformed event in *one* game can crash the whole process — taking down every other game currently in progress on that instance. The blast radius is much larger than "one bad request, one bad response" |
| Mitigation | Strict schema validation on every field of every event, before any handler logic runs; unrecognized event names are ignored, not errored |
| Server validation | Type, shape, and range validation (e.g. `amount` positive-integer within the overflow sanity ceiling, `ECONOMY_SPECIFICATION.md` §7) on every incoming field. **Required engineering practice, stated explicitly**: every event handler must be wrapped so an exception is caught, logged, and turned into a clean rejection — never allowed to propagate and take the process down |
| Database protection | `CHECK` constraints as the last line — `amount > 0`, `upgrade_level BETWEEN 0 AND 5`, etc. — catch anything that somehow got past application validation |
| Test case | Fuzz every event's payload with wrong types, extreme values, and missing fields — assert clean rejection every time, never a crash or hang; send an unrecognized event name and confirm the connection survives |

### 12. Rate-limit abuse

| Field | Detail |
|---|---|
| Threat | Exceeding intended usage to exhaust resources, gain an unfair speed advantage, or defeat a security-motivated limit |
| Attack | Scripted client sending far more requests/events than a human could generate; distributed brute-force against the join-code limit using multiple accounts to each stay under their own per-user cap |
| Impact | DoS; successful join-code brute-force despite a nominal limit, if that limit is scoped too narrowly |
| Mitigation | Limits scoped **both per-user and per-IP** where the limit exists for security reasons, not just courtesy (`API_CONTRACT.md` already does this for the join endpoint specifically) |
| Server validation | REST: standard per-request middleware. **Socket.IO needs a different mechanism, worth being explicit about**: there's no natural "one request" boundary on a long-lived connection, so socket-side rate limiting has to be a token-bucket tracked across the connection's lifetime, not a per-message check in isolation |
| Database protection | **Honestly, mostly N/A** — rate limiting is an abuse/DoS concern, not a data-correctness one, so DB constraints don't directly protect against it the way they protect against corruption elsewhere in this document. The real backstop is that even a rate-limit bypass still has to pass every other threat's mitigations (ownership checks, idempotency, etc.) to do any actual damage |
| Test case | Script requests past the stated limit, assert `429`/socket-equivalent rejection at the correct threshold, not later; attempt to bypass a per-user limit with multiple throwaway accounts from one IP, assert the IP-scoped limit still catches it |

### 13. Disconnect exploitation

| Field | Detail |
|---|---|
| Threat | Deliberately disconnecting at a strategic moment to dodge a consequence |
| Attack | Disconnect right as a costly rent payment is about to apply, hoping it doesn't land because the player "wasn't there"; disconnect during a decision window (`RENT_RISK_DECISION`, `HOSTILE_ACQUISITION_PENDING`) hoping to stall indefinitely |
| Impact | If unprotected: indefinite stalling, or an applied action somehow "undone" by leaving |
| Mitigation | Already strong, established across two prior documents: a state's own timeout fires on schedule **regardless of connection status** (`GAME_STATE_MACHINE.md` §5) — disconnecting never pauses a countdown. A transaction in progress has no client round-trip in the middle to interrupt (§5, "non-event by design"). Repeated disconnection just escalates to AFK auto-skip, never a stall |
| Server validation | Timeout-driven defaults apply identically whether the player is connected or not |
| Database protection | **A feature, not just a protection**: nothing in this schema supports editing or deleting a `game_transactions` row once written — there's no "undo." Any correction to a disputed outcome would have to be a new, separate offsetting transaction, preserving the full audit trail rather than rewriting history |
| Test case | Disconnect a player at the exact moment a mandatory payment is applying, assert it completes normally and is correctly reflected on reconnect; disconnect during `RENT_RISK_DECISION`, assert the timeout default fires on schedule, not extended by the disconnect |
| Cross-reference | Hostile Acquisition's still-open timeout default (block vs. forced-through, `GAME_STATE_MACHINE.md` §3) has a griefing angle worth weighing alongside its original fairness framing: if "forced-through" is chosen, it becomes a lever a player could use *against* a disconnected opponent, not just a consequence a disconnected player might dodge. Worth considering both directions when that decision is finally made |

### 14. Race conditions

| Field | Detail |
|---|---|
| Threat | Two actions interleaving in a way that corrupts state |
| Attack | Two players simultaneously buying the same property; a player's own double-submit |
| Impact | Double-spend, duplicate ownership |
| Mitigation | Synchronous per-room mutation — no `await` gap between reading and writing a room's shared state (`GAME_STATE_MACHINE.md` §5) |
| Server validation | The second of two near-simultaneous actions is validated against the *already-updated* result of the first. **Worth flagging as an ongoing engineering discipline, not a one-time guarantee**: if a future change ever introduces an `await` in the middle of a read-then-write sequence for one room's state, this guarantee silently breaks. Nothing enforces this structurally except code discipline — it's a real regression risk to watch for in review, not something that, once true, stays true automatically |
| Database protection | `UNIQUE (game_id, board_tile_id)` on properties, `UNIQUE (game_id, state_version)` / `UNIQUE (idempotency_key)` on actions/transactions — genuine backstops if the in-process guarantee is ever violated |
| Test case | Fire two `buy_property` events for the same tile within one simulated event-loop tick, assert exactly one succeeds. A stronger test: *deliberately* introduce an `await` before the mutation completes (simulating a future regression) and confirm the database-level constraint still prevents corruption even when the in-memory guarantee has been broken — this is what makes the defense-in-depth claim verifiable rather than assumed |

### 15. Database transaction abuse

| Field | Detail |
|---|---|
| Threat | Exploiting a multi-statement operation failing partway through |
| Attack | Cause a bankruptcy settlement (ledger entries + ownership transfers + a status flag, several statements) to fail after some statements succeed but before others — e.g. ending up with properties transferred but the corresponding debt never actually recorded as paid |
| Impact | Violates `ECONOMY_SPECIFICATION.md` §4's invariant directly; a "free" transfer; a game stuck half-initialized if this happens during `STARTING` |
| Mitigation | `DATABASE_DESIGN.md`'s Transaction Strategy already names exactly which operations require explicit `BEGIN`/`COMMIT` (bankruptcy settlement, game start, match settlement) precisely because of this risk |
| Server validation | Reframed for this threat, since it's about the server's own code rather than client input: **every multi-statement mutation identified in that strategy must actually be wrapped in a real transaction at implementation time** — this is a code-review/lint-rule concern, not a runtime validation one |
| Database protection | Postgres's own ACID guarantees, *once a transaction is correctly opened* — the risk is entirely in the application correctly using the mechanism, not in Postgres failing to honor it |
| Test case | Inject a failure partway through a simulated bankruptcy settlement (e.g. the ownership-transfer statement succeeds, a later statement throws), assert the entire operation rolls back — no partial property transfer without the matching debt settlement |

---

## Gaps found while reviewing (not fixed here — flagged for a follow-up pass)

1. **`build_house`/`sell_house`/`mortgage`/`unmortgage`/`propose_trade`/`respond_trade` have no formal Socket.IO event contract yet.** They're referenced by name and behavior in `GAME_DESIGN_SPEC.md` §12, but `SOCKET_CONTRACT.md`'s Phase 09 scope only covered the 9 explicitly-requested actions. This document's threat #3 analysis holds in principle but can't be fully verified until these are specified with the same rigor.
2. **`kick_player` has no REST endpoint.** `GAME_DESIGN_SPEC.md` §4 defines it as a host action; `API_CONTRACT.md`'s Phase 08 scope didn't include it among the six room endpoints designed. Currently unusable via the contract as written, even though the rule for it already exists.
3. **Socket namespace connection should reject non-participants at handshake time**, not just reject their individual events afterward — a small tightening this review surfaces, not previously stated this precisely.
4. **No site-wide admin/moderation role exists.** Not a flaw — just noting the boundary of what this document could threat-model, since Admin Manipulation (#10) could only meaningfully be assessed against the one privileged role (Host) that actually exists today.

None of these are fixed in this document, consistent with "do not modify source code" (and, by extension, not silently expanding two already-approved contract documents mid-review). Recommending they become their own small follow-up phase.

---

## Decisions requiring your approval

1. Whether to commission a follow-up phase closing the four gaps above before implementation starts.
2. The JWT-not-rechecked-per-event tradeoff (#6) — accept as-is, or design a credential-revocation mechanism (e.g. a forced-disconnect on ban) for the future admin role noted in #10.
3. Hostile Acquisition's timeout default, now with the added griefing consideration from #13 factored in alongside the original fairness framing.
