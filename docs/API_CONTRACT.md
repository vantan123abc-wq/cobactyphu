# CoBacTyPhu — REST API Contract

Design only — no endpoints implemented. Builds on every prior document; `DATABASE_DESIGN.md` is the schema this API reads and writes. Same tagging convention: **[CONFIRMED]**, **[PROPOSED]**, **[OPEN DESIGN DECISION]**.

## Scope boundary, and one revision this doc makes

**REST**: room lifecycle (create/get/join/leave/ready/start), and persistence-oriented reads (game metadata, current state as a snapshot, match results, player info, history). **Socket.IO** (a separate, future contract — not designed here): every in-match gameplay action once a game exists — roll, buy, build, trade, and all the rest already specified in `GAME_DESIGN_SPEC.md`/`GAME_STATE_MACHINE.md`.

**[PROPOSED — revises the architecture doc's event catalog for five events only]** `room:join`, `room:leave`, `room:set_ready`, and `room:start` were originally sketched as Socket.IO events. This document moves their write path to REST instead, for a reason specific to the lobby phase: these are low-frequency, naturally request/response actions (a handful of calls before a match starts, not a continuous stream), and HTTP semantics — status codes, an `Idempotency-Key` header, cacheable GETs — fit them better than a bidirectional socket channel built for a fast-moving turn loop. **This does not change how other lobby members find out** — after a successful REST call mutates room state, the backend still pushes a lightweight notification over Socket.IO ~~(e.g. `room:updated`, payload TBD in the Socket.IO contract phase)~~ — **implemented 2026-08-21 as `S2C_ROOM_UPDATED`, `{ roomId, roomStatus }`, see `WEBSOCKET_API.md` §6** — so connected clients refresh without polling. The mutation and its validation happen in the REST handler; the socket message is just "something changed, go re-fetch or use what's attached." Nothing about in-match `game:*` events changes.

**On RLS vs. this API**: `DATABASE_DESIGN.md`'s RLS `SELECT` policies remain in place as defense-in-depth (and to leave room for a future direct-Supabase read, e.g. an admin view), but **this REST API is the intended read path for clients** — every endpoint below is implemented by the Express backend using `service_role`, doing its own membership/authorization checks in code, not by the client querying Supabase directly under RLS. One authorization code path, not two that have to be kept in sync.

---

## Conventions (stated once, not repeated per endpoint)

- **Base path**: `/api/v1` — **[PROPOSED]** versioning from the start, even though there's only one version so far.
- **Auth header**: `Authorization: Bearer <supabase_jwt>` on every endpoint except `/api/v1/health`. The backend verifies the JWT against the Supabase project (signature check, not a round-trip to Supabase's own API, for latency) — a missing or invalid token is `401` before any endpoint-specific logic runs, so it's not repeated in every AUTHORIZATION row below beyond noting the extra condition (e.g. "must be a member").
- **Casing**: request/response JSON is `camelCase`; the database (`DATABASE_DESIGN.md`) is `snake_case`. The backend maps between them — not a client concern.
- **Error envelope**, every non-2xx response: `{ "error": { "code": "STRING_CODE", "message": "human-readable" } }`.
- **Shared error codes** (endpoint-specific ones are listed per endpoint): `UNAUTHORIZED` (401), `VALIDATION_ERROR` (400), `RATE_LIMITED` (429), `INTERNAL_ERROR` (500).
- **Privacy default**: where "not found" and "found but you're not authorized to see it" could both apply (a room/game a user isn't a member of), the response is **`404` for both**, never `403` — confirming a private room/game *exists* to a non-member is its own small leak, worth avoiding by default.
- **Idempotency mechanism**: an optional-or-required (noted per endpoint) client-generated `Idempotency-Key` header (UUID). The server caches the first response for a given key (**[PROPOSED]** 24h) and replays it on a repeat instead of reapplying the operation — the REST-world counterpart to `clientActionId` in `GAME_STATE_MACHINE.md` §6. Not every endpoint needs it — several are naturally idempotent already, and that's stated explicitly rather than bolting the header on everywhere by default.
- **Rate limiting**: **[PROPOSED]** all values; scoped per authenticated user (by JWT subject) unless noted otherwise. Numbers are a starting point for tuning, not load-tested.

---

## Authentication

No `/register`, `/login`, `/logout`, or `/refresh` endpoints exist on this API — Supabase Auth handles all of that directly, client-side, via `supabase-js` (established from the very first setup in this project). This backend only **consumes** the JWT `supabase-js` already issued; it never issues or validates credentials itself. The one endpoint below exists because "who am I, and where am I right now" is a real backend concern (it drives reconnect routing) that Supabase's own client SDK can't answer on its own.

### `GET /api/v1/auth/me` — current user

| Field | Detail |
|---|---|
| Authorization | Valid JWT — no further check |
| Request | none |
| Validation | JWT signature + expiry |
| Success response | `200` — `{ id, displayName, avatarUrl, activeRoomId, activeGameId }`. `activeRoomId`/`activeGameId` are nullable, derived by checking `room_players`/`game_players` for a non-terminal room/game — this is what lets a client that just reloaded the page decide "show the lobby" vs "show the board" vs "show the home screen" in one call |
| Error response | `401 UNAUTHORIZED` |
| Idempotency | Naturally idempotent — `GET`, no side effects |
| Rate limit | 60/min per user — called on every app load/reconnect, should tolerate normal use without being a polling channel |

---

## Rooms

### `POST /api/v1/rooms` — create room

| Field | Detail |
|---|---|
| Authorization | Valid JWT |
| Request | Empty body — no configurable settings exist at room-creation time (`ADAPTIVE_BOARD_DESIGN.md`: board size is auto-selected later, not chosen at creation) |
| Validation | JWT only; rate limit is the abuse control here, not request validation |
| Success response | `201` — `{ roomId, joinCode, status: "waiting_for_players", hostId, createdAt }` |
| Error response | `401`; `500 INTERNAL_ERROR` on repeated join-code collision (the backend retries generation a few times against `rooms.join_code`'s unique index before giving up — vanishingly rare, still worth a defined failure mode) |
| Idempotency | **Requires `Idempotency-Key`.** A retried create request must not silently produce two rooms for one user click |
| Rate limit | 5 rooms per user per 10 minutes — prevents join-code-space churn from spam |

### `GET /api/v1/rooms/:id` — get room

| Field | Detail |
|---|---|
| Authorization | Valid JWT, sender must be a current member (`room_players`) |
| Request | none |
| Validation | Membership check |
| Success response | `200` — `{ roomId, joinCode, hostId, status, players: [{ playerId, displayName, avatarUrl, isReady, isHost }], createdAt }` |
| Error response | `404` (not found *or* not a member — merged, see Conventions) |
| Idempotency | Naturally idempotent |
| Rate limit | 30/min — may be polled as a fallback alongside the Socket.IO push notification, but isn't meant to replace it |

### `POST /api/v1/rooms/:code/join` — join room

| Field | Detail |
|---|---|
| Authorization | Valid JWT |
| Request | Path param `code`; empty body — the joining player is the JWT subject, not something the client asserts |
| Validation | Code resolves to a room; room status is `waiting_for_players` or `ready_check`; room not at `MAX_PLAYERS` (unless the sender is already a member — see Idempotency) |
| Success response | `200` — same shape as `GET /rooms/:id` |
| Error response | `404 INVALID_JOIN_CODE` (bad/unknown/expired code — same status as "room not found," deliberately indistinguishable to a prober); `409 ROOM_FULL`; `409 ALREADY_STARTED` |
| Idempotency | **Naturally idempotent by database constraint**, not a header — `room_players`' composite primary key (`DATABASE_DESIGN.md` §3) makes rejoining an already-joined room a no-op that just returns current state, never a duplicate row |
| Rate limit | **Strict — 10/min per user, plus a stricter per-IP ceiling.** `ROOM_JOIN_CODE_LENGTH = 6` is a real but not enormous keyspace; without a tight limit here specifically, this endpoint is a brute-force vector against an active room's code. This is the one endpoint in this document where the rate limit is a security control, not just an abuse-prevention nicety |

### `POST /api/v1/rooms/:id/leave` — leave room

| Field | Detail |
|---|---|
| Authorization | Valid JWT, sender is a current member |
| Request | none |
| Validation | Room status is `waiting_for_players` or `ready_check` — **leaving mid-match is not this endpoint**, it's a disconnect (`GAME_STATE_MACHINE.md` §5), a different mechanism entirely, on purpose |
| Success response | `200` — `{ success: true }`. If the sender was host, host role has already transferred to the next-joined player server-side (`GAME_DESIGN_SPEC.md` §4) before this responds |
| Error response | `404` (not found / not a member); `409 ALREADY_STARTED` (past the leave-eligible window) |
| Idempotency | Naturally idempotent — leaving twice just 404s the second time, which is an expected outcome, not an error worth guarding against |
| Rate limit | 10/min |
| **Implemented** | 2026-08-21, `room.controller.js`'s `leaveRoom` — see `docs/PROJECT_STATUS.md` |

### `POST /api/v1/rooms/:id/kick` — kick a player (host only)

**Not originally in this document** — `GAME_DESIGN_SPEC.md` §4 defined the `kick_player` rule (host only, lobby-phase only) from Phase 04 onward, but this REST contract never got a matching entry (`PROJECT_STATUS.md`'s own "Known gaps" #2). Added here, wired 2026-08-21, modeled directly on `leave`'s own already-approved shape above rather than inventing an unrelated one.

| Field | Detail |
|---|---|
| Authorization | Valid JWT, sender must be `rooms.host_id` |
| Request | `{ "targetPlayerId": "uuid" }` — `profiles.id`, the same id space every other player-identifying field in this API already uses, never a client-asserted display name |
| Validation | Room status is `waiting_for_players` or `ready_check` (same pre-game-only boundary as `leave`); target is a real member and is not the host themselves |
| Success response | `200` — `{ success: true }`, same shape `leave` uses |
| Error response | `404` (room not found / sender not a member / target not a member); `403 NOT_HOST`; `400 VALIDATION_ERROR` (missing `targetPlayerId`); `400 CANNOT_KICK_HOST`; `409 ALREADY_STARTED` |
| Idempotency | Naturally idempotent in effect — kicking an already-absent target 404s, same posture as a repeated `leave` |
| Rate limit | 10/min |
| Socket events | ~~**Not wired**~~ — **wired 2026-08-21, same pass as `S2C_ROOM_UPDATED`** (`WEBSOCKET_API.md` §6): kick broadcasts it like every other room-mutating endpoint, closing `GAME_DESIGN_SPEC.md` §4's `room:kicked`/`room:state` names against the real, generic event rather than inventing kick-specific ones |
| **Implemented** | 2026-08-21, `room.controller.js`'s `kickPlayer` — see `docs/PROJECT_STATUS.md` |

### `PATCH /api/v1/rooms/:id/ready` — ready/unready

| Field | Detail |
|---|---|
| Authorization | Valid JWT, sender is a current member |
| Request | `{ ready: boolean }` |
| Validation | Room status is `waiting_for_players` or `ready_check` |
| Success response | `200` — same shape as `GET /rooms/:id`, so the client immediately sees whether the room as a whole just crossed into `ready_check` |
| Error response | `404`; `409 ALREADY_STARTED`; `400 VALIDATION_ERROR` (missing/non-boolean `ready`) |
| Idempotency | Naturally idempotent — `PATCH` with an explicit target value always ends in the same state no matter how many times it's sent, unlike `POST /rooms` which creates something new on every unguarded call |
| Rate limit | 20/min — generous enough for a player toggling the checkbox a few times, still bounded |

### `POST /api/v1/rooms/:id/start` — start game

| Field | Detail |
|---|---|
| Authorization | Valid JWT, sender must be **the host specifically**, not just any member |
| Request | none |
| Validation | Sender is `rooms.host_id`; status is `ready_check`; player count in `[MIN_PLAYERS, MAX_PLAYERS]`; every non-host player `is_ready`. All re-checked server-side against current DB state — never trusted from anything the client claims (`GAME_DESIGN_SPEC.md` §27, applies to REST exactly as it does to sockets) |
| Success response | `201` — `{ gameId, boardId, status: "in_progress", startedAt }`. From this point, the client is expected to open its Socket.IO connection scoped to `gameId` for everything else — this endpoint's job ends at handing off the new game's id |
| Error response | `403 NOT_HOST`; `409 NOT_ALL_READY`; `409 INVALID_PLAYER_COUNT`; `409 ALREADY_STARTED` |
| Idempotency | **Requires `Idempotency-Key`.** Double-starting a match is exactly the kind of bug this document's whole idempotency chain exists to prevent — and it has a second, independent backstop: `games.room_id` is `UNIQUE` (`DATABASE_DESIGN.md` §4), so even a gap in idempotency-key handling can't produce two `games` rows for one room |
| Rate limit | 5/min — a one-shot action, no legitimate reason to call it often |

---

## Games

Every endpoint below requires the sender to be a **participant** — a real player (not the Bank sentinel row) in that game's `game_players` — checked the same "merge 404" way as room membership.

### `GET /api/v1/games/:id` — get game

| Field | Detail |
|---|---|
| Authorization | Valid JWT, participant |
| Request | none |
| Validation | Participant check |
| Success response | `200` — `{ gameId, roomId, boardId, status, currentTurnIndex, stateVersion, startedAt, endedAt }`. This is the persistent `games` row (`DATABASE_DESIGN.md` §4) — metadata, not full live state; see the next endpoint for that |
| Error response | `404` |
| Idempotency | Naturally idempotent |
| Rate limit | 30/min |

### `GET /api/v1/games/:id/state` — get current game state

| Field | Detail |
|---|---|
| Authorization | Valid JWT, participant |
| Request | none |
| Validation | Participant check |
| Success response | `200` — the full `GameState` shape (`GAME_DESIGN_SPEC.md` §2): positions, balances, turn phase, property ownership, activity log. **Served from the live in-memory state when the backend process is currently holding this game**; falls back to the latest `game_state_snapshots` row (`DATABASE_DESIGN.md` §9) if it isn't — e.g. immediately after a restart, before recovery has rehydrated it. A finished game always returns its final frozen state with `status: "finished"`, useful for a post-game board review |
| Error response | `404`; `503 SERVICE_UNAVAILABLE` — the rare case where a game is `in_progress` in the database but neither held in memory nor snapshotted yet (should not happen given per-turn snapshotting, but an explicit code beats an undefined `500` if it ever does) |
| Idempotency | Naturally idempotent in the HTTP sense (safe to repeat, no side effects) — **not** idempotent in the sense of "same response every time," since the underlying state legitimately changes turn to turn. Worth being precise about which meaning applies |
| Rate limit | 20/min — **this is a reconnect/refresh aid, not a polling substitute.** During normal play, clients get updates from `game:state_update` over Socket.IO; this endpoint exists for the moment before or during establishing that connection, not as an alternative to it |

### `GET /api/v1/games/:id/result` — get match result

| Field | Detail |
|---|---|
| Authorization | Valid JWT, participant |
| Request | none |
| Validation | Participant check; game status is `finished` or `aborted` |
| Success response | `200` — `{ resultType, winnerId, standings: [{ playerId, displayName, finalRank, finalBalance, bankruptAt }], endedAt }`. Assembled by joining `match_results` with `game_players`/`profiles` (`DATABASE_DESIGN.md` §13) — not a stored blob, so this is a real query every time, not a cache read |
| Error response | `404`; `409 GAME_NOT_FINISHED` — deliberately distinct from `404`, since "come back later" and "this doesn't exist" call for different client behavior |
| Idempotency | Naturally idempotent, and genuinely stable once the game is finished — unlike `/state`, this endpoint's response never changes after the first successful call, which makes it safe for a client to cache indefinitely |
| Rate limit | 30/min |

### `GET /api/v1/games/:id/players/:playerId` — get player information

| Field | Detail |
|---|---|
| Authorization | Valid JWT, sender must be a participant of `:id` (can look up any player *in that same game*, not just themselves — needed to render an opponent's card) |
| Request | none |
| Validation | Sender is a participant of `:id`; `:playerId` belongs to that same game |
| Success response | `200` — `{ playerId, displayName, avatarUrl, turnOrder, currentBalance, currentPosition, inJail, bankrupt, finalRank }`. **`currentBalance`/`currentPosition` are the denormalized, snapshot-cadence values from `game_players`** (`DATABASE_DESIGN.md` §5) — accurate as of the last completed turn, not necessarily this exact instant. For split-second accuracy during an active game, use `game:state_update` (Socket.IO) or `/games/:id/state` (which prefers live memory) instead |
| Error response | `404` |
| Idempotency | Naturally idempotent |
| Rate limit | 30/min |

---

## Supplementary endpoints

Carried over from the architecture doc's already-established requirements — not newly requested this phase, included for a complete contract.

### `GET /api/v1/players/me/history` — match history

| Field | Detail |
|---|---|
| Authorization | Valid JWT |
| Request | Query params `?limit=20&cursor=<opaque>` — **[PROPOSED]** cursor pagination, since a player's history only grows |
| Validation | `limit` capped server-side (**[PROPOSED]** max 50) regardless of what's requested |
| Success response | `200` — `{ games: [{ gameId, boardId, resultType, finalRank, finishedAt }], nextCursor }` |
| Error response | `401`; `400 VALIDATION_ERROR` (malformed cursor) |
| Idempotency | Naturally idempotent |
| Rate limit | 30/min |

### `GET /api/v1/health` — liveness

| Field | Detail |
|---|---|
| Authorization | None — no JWT required, this is what the hosting platform's health check calls |
| Request | none |
| Validation | none |
| Success response | `200` — `{ status: "ok" }` |
| Error response | Platform-level only (process not responding) — no application error path |
| Idempotency | Naturally idempotent |
| Rate limit | None — excluded from the auth-scoped limiter entirely; the hosting platform controls its own check frequency |

---

## Decisions requiring your approval

1. **Moving the four room-lifecycle actions from Socket.IO to REST** (top of this document) — the single biggest architectural call in this phase. If you'd rather keep the lobby fully on Socket.IO for consistency with in-match play, this document's Rooms section would need to be redesigned as socket events instead, and this phase's REST scope would shrink to Games-only reads.
2. All proposed rate-limit numbers — none are load-tested, all are reasonable starting guesses.
3. The join-endpoint rate limit specifically (10/min + per-IP ceiling) — flagged separately from the others because it's doing real security work (brute-force resistance), not just abuse prevention, so it deserves a deliberate rather than default number.
4. `Idempotency-Key` TTL (24h proposed) and cache storage (not designed here — likely Redis or an in-process cache with the backend's existing per-room state, to be decided when the backend itself is designed).
5. History pagination limits (default 20, max 50) — arbitrary starting points.
