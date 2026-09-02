# CoBacTyPhu — Implementation Plan

Plan only — nothing implemented. All ten prior documents are the approved sources of truth this plan builds tasks from.

## Repository analysis (before planning)

Direct inspection, not Graphify — see note below.

```
CoBacTyPhu/
├── docs/                    10 approved specification documents
├── src/
│   ├── App.jsx              Vite template placeholder — unmodified since scaffold
│   ├── main.jsx              React 19 entry point
│   └── supabaseClient.js     Working Supabase client (URL + anon key wired)
├── .env / .env.example        Supabase credentials, gitignored
├── package.json               react, react-dom, @supabase/supabase-js
└── (Vite/Oxlint config)
```

**No backend exists. No database migrations exist. No Socket.IO code exists. No auth flow exists beyond a configured client. No game logic of any kind exists.** Every prior phase's "do not implement yet" held — this is a genuinely clean slate, not an approximation of one.

**On Graphify**: `graphify-out/` doesn't exist — no knowledge graph has ever been built for this project. A code-to-knowledge-graph tool has nothing to extract from ten markdown files and an unmodified template component; there are no modules, dependencies, entry points, or architecture to graph yet, because none of it is implemented. This plan is built from direct inspection of the repository and the ten approved specs instead — which is also *more* reliable here than a graph would be, since the graph could only describe code, and the actual source of truth for what to build is the specs, not any code that doesn't exist yet.

---

## Phase ordering: your 15 phases, Authentication inserted, renumbered

| Your phase | This plan's phase | Note |
|---|---|---|
| 1. Foundation | **P01** Foundation | unchanged |
| 2. Database | **P02** Database | unchanged |
| — | **P03** Authentication | **inserted**, per your explicit requirement — before Game domain models, so every later phase can assume an authenticated `userId` exists |
| 3. Game domain models | **P04** Game domain models | |
| 4. Game engine | **P05** Game engine | |
| 5. Economy engine | **P06** Economy engine | |
| 6. State machine | **P07** State machine | |
| 7. Room/lobby | **P08** Room/lobby | |
| 8. Socket.IO | **P09** Socket.IO | |
| 9. Reconnection | **P10** Reconnection | |
| 10. React board | **P11** React board | |
| 11. Gameplay UI | **P12** Gameplay UI | |
| 12. Supabase integration | **P13** Supabase integration | see note below — this is *not* "connect to Supabase" (already done, P01) |
| 13. Testing | **P14** Testing | |
| 14. Security validation | **P15** Security validation | |
| 15. Balance instrumentation | **P16** Balance instrumentation | |

**Why "Supabase integration" is phase 13, not phase 1**: the architecture doc's layer boundary (`ARCHITECTURE.md`, restated in `GAME_STATE_MACHINE.md`) requires the Game Engine and State Machine to be **pure** — functions over state, no I/O, unit-testable without a database. P05–P07 build and test that pure logic in isolation; P13 is where it gets wired to real persistence (snapshot writes, transaction logging). Building the pure logic before the I/O wiring isn't a delay, it's the point — it's what makes P05–P07 fast to test and safe to change. Basic Supabase *connectivity* (client config, project credentials) is already done and gets exercised immediately in P02/P03.

**Why Authentication sits where it does**: it depends on P01 (an Express app must exist to hold middleware) and P02 (the `profiles` table must exist). It has to come before P04 because every domain model downstream — `game_players`, `room_players`, every ledger entry — is keyed to a real `userId`, per your instruction that "every gameplay-related action can be associated with an authenticated userId/playerId."

---

## Task format

Every task below follows the same eleven fields, in a compact table. Task IDs are `P<phase>-T<task>`, sortable and phase-scoped.

---

## Phase 01 — Foundation

Gets the repository into the two-sided shape `ARCHITECTURE.md`'s folder structure recommended, and stands up a backend that doesn't exist yet.

### P01-T01 — Restructure into `frontend/` + `backend/`

| Field | Detail |
|---|---|
| Objective | Move the existing React app under `frontend/`, matching the architecture doc's recommended layout, and create an empty `backend/` sibling |
| Dependencies | None — first task in the whole plan |
| Files to create | `backend/` (empty, structure added in P01-T02) |
| Files to modify | Move `src/`, `index.html`, `vite.config.js`, `package.json`, `.env*`, `public/` into `frontend/` (git mv, preserving history) |
| Files not to touch | `docs/`, `.claude/` — this task is pure relocation, not a rewrite of anything inside the moved files |
| Implementation details | Git-aware move (not delete+recreate) so file history survives; update any relative paths the move breaks (none expected — Vite config is self-contained) |
| Acceptance criteria | `npm run dev` still works from `frontend/`; app renders identically to before the move |
| Tests | Manual: `npm run dev`, confirm the existing "Supabase: ✅ đã kết nối" status still renders |
| Risks | Low — mechanical move. The one real risk is breaking `.gitignore`'s `.env` exclusion if paths aren't updated to match the new location |

### P01-T02 — Backend Express skeleton

| Field | Detail |
|---|---|
| Objective | A running Express app with environment config and a health check — the foundation every later backend task builds on |
| Dependencies | P01-T01 |
| Files to create | `backend/package.json`, `backend/src/server.js`, `backend/src/app.js`, `backend/.env.example`, `backend/.gitignore` |
| Files to modify | Root `.claude/launch.json` — add a `backend-dev` preview config (matching the existing `CoBacTyPhu-dev` frontend entry) |
| Files not to touch | `frontend/` entirely |
| Implementation details | Express app factory pattern (`app.js` exports the app, `server.js` starts it) so it's importable by tests without binding a port; `GET /api/v1/health` per `API_CONTRACT.md`, no auth required |
| Acceptance criteria | `curl localhost:5000/api/v1/health` returns `{ "status": "ok" }`; server starts cleanly with `npm run dev` |
| Tests | Integration: request the health endpoint, assert `200` and the exact body shape |
| Risks | Port collision with the frontend dev server if not configured distinctly — `API_CONTRACT.md`/architecture doc already assume separate ports (5173 frontend, 5000 backend) |

---

## Phase 02 — Database

Schema only — the tables from `DATABASE_DESIGN.md`, not the application code that uses them (that's P13).

### P02-T01 — Core table migrations

| Field | Detail |
|---|---|
| Objective | Create all 13 tables from `DATABASE_DESIGN.md` §1–§13 as Supabase migrations |
| Dependencies | P01-T02 (needs somewhere to keep migration tooling, even though migrations run against Supabase directly, not through the Express app) |
| Files to create | `backend/supabase/migrations/0001_core_tables.sql` (or per-table files — grouping is an implementation choice, not a design one) |
| Files to modify | None |
| Files not to touch | Any table's actual production data, obviously n/a pre-launch |
| Implementation details | Exact column/type/PK/FK/nullable/default/constraint definitions per `DATABASE_DESIGN.md` §1–§13, including the Bank sentinel constraint on `game_players` (§5) and the `from`/`to` shape on `game_transactions` (§12) |
| Acceptance criteria | Every table, constraint, and index from `DATABASE_DESIGN.md` exists in the Supabase project exactly as specified; a schema diff against the doc shows zero deviation |
| Tests | Migration applies cleanly on a fresh database; a schema-introspection test asserts every documented constraint (e.g. `CHECK (current_balance >= 0 OR is_bank)`) actually exists |
| Risks | This is the single highest-leverage task in the whole plan to get wrong — every later phase assumes this schema exactly. Any deviation from `DATABASE_DESIGN.md` here should be treated as a spec change, not a silent implementation detail |

### P02-T02 — RLS policies

| Field | Detail |
|---|---|
| Objective | Implement the RLS strategy from `DATABASE_DESIGN.md` § RLS strategy — no client write policies on gameplay tables, membership-scoped reads, one exception for `profiles` |
| Dependencies | P02-T01 |
| Files to create | `backend/supabase/migrations/0002_rls_policies.sql` |
| Files to modify | None |
| Files not to touch | — |
| Implementation details | `EXISTS`-subquery-based membership checks against `room_players`/`game_players`; explicit `service_role`-only intent documented in comments since RLS policies don't positively grant `service_role` anything — it bypasses RLS by definition |
| Acceptance criteria | An `anon`/`authenticated`-role client cannot `INSERT`/`UPDATE`/`DELETE` any gameplay table; can `SELECT` only rows for rooms/games it belongs to; can `UPDATE` only its own `profiles` row |
| Tests | A negative-permission test suite: attempt every forbidden write as an `authenticated` role, assert every one is rejected by Postgres itself (not application code) — this is `SECURITY_DESIGN.md`'s threats #1/#3/#9 verified at the database layer directly |
| Risks | RLS policies are easy to get subtly wrong (e.g. a `USING` clause that's too permissive under a specific join). Test the *rejection* cases explicitly, not just that legitimate access works |

### P02-T03 — Board/tile seed data

| Field | Detail |
|---|---|
| Objective | Seed `boards` (2 rows: small/large, `ADAPTIVE_BOARD_DESIGN.md`) and `board_tiles` (structural layout for both) |
| Dependencies | P02-T01 |
| Files to create | `backend/supabase/seed/boards.sql` |
| Files to modify | None |
| Files not to touch | — |
| Implementation details | `boards` rows are fully specified (36/44 tiles, min/max players) and can be seeded exactly as approved. `board_tiles` **cannot be fully seeded yet** — `BOARD_SPECIFICATION.md` marked most property names/prices `UNKNOWN`, and `ADAPTIVE_BOARD_DESIGN.md` §7's content (theming, exact arrangement) is still an open item. Seed the *structural* tiles that are fully confirmed (4 corners, tile-type distribution counts from `ADAPTIVE_BOARD_DESIGN.md`'s composition tables) with clearly-marked placeholder names/prices for property-type tiles |
| Acceptance criteria | `SELECT COUNT(*) FROM board_tiles WHERE board_id = 'small'` = 36, `= 'large'` = 44; corner tiles have their real, confirmed names; property tiles are flagged as placeholder content in a way the frontend can detect (e.g. a `is_placeholder_content` convention, or simply obviously-fake names like `"Property #7"`) |
| Tests | Row-count assertions per board; a check that every `tile_type` in the composition matches `ADAPTIVE_BOARD_DESIGN.md`'s approved category counts exactly |
| Risks | **This task is blocked on real content, not just implementation effort.** Real board content (property names, prices, theming) needs to come from you or a content designer before this can be finalized — re-seeding later, once content exists, is a straightforward follow-up, not a schema change, but it is a second pass this task should expect to need |

---

## Phase 03 — Authentication

Explicitly inserted per your requirement. Nothing past this phase should ever need to re-derive "who is this," anywhere.

### P03-T01 — `profiles` auto-creation trigger

| Field | Detail |
|---|---|
| Objective | A Postgres trigger that creates a `profiles` row the instant a user signs up via Supabase Auth, per the standard Supabase pattern noted in `DATABASE_DESIGN.md` §1 |
| Dependencies | P02-T01 |
| Files to create | `backend/supabase/migrations/0003_profiles_trigger.sql` |
| Files to modify | None |
| Files not to touch | `auth.users` — Supabase-managed, never written to directly by application migrations beyond the trigger's own attachment |
| Implementation details | `AFTER INSERT ON auth.users` trigger calling a function that inserts into `profiles` with a sensible default `display_name` derived from auth metadata (email local-part, or a placeholder) |
| Acceptance criteria | Signing up a new user via `supabase.auth.signUp()` produces exactly one `profiles` row, automatically, with no application code involved |
| Tests | Integration: sign up a test user against a real (test) Supabase project, assert the `profiles` row exists within the same request cycle |
| Risks | Trigger failures fail the signup transaction itself (by design — a user without a profile shouldn't exist) — needs to be simple and defensive enough to never throw on a legitimate signup shape |

### P03-T02 — JWT verification utility + Express auth middleware

| Field | Detail |
|---|---|
| Objective | The single, shared function that turns a JWT into a verified `userId` — used by every protected REST route (this phase) and, later, the Socket.IO handshake (P09) |
| Dependencies | P01-T02, P03-T01 |
| Files to create | `backend/src/auth/verifyJwt.js`, `backend/src/auth/authMiddleware.js` |
| Files to modify | None |
| Files not to touch | — |
| Implementation details | Signature + expiry verification against the Supabase project's JWT secret (not a round-trip to Supabase's API — `API_CONTRACT.md`'s stated latency preference); middleware attaches `req.user = { id }` on success, responds `401 UNAUTHORIZED` (matching `API_CONTRACT.md`'s error envelope) on any failure |
| Acceptance criteria | A request with a valid JWT reaches the route handler with `req.user.id` populated; a missing, malformed, or expired JWT never reaches the handler at all |
| Tests | Unit: valid token → passes through; expired/malformed/missing token → `401`, handler never invoked (mock the next handler, assert it's not called) |
| Risks | This function is the root of `SECURITY_DESIGN.md` threat #9's trust anchor — a bug here compromises every downstream authorization check in the entire system. Warrants disproportionate test coverage relative to its size |

### P03-T03 — `GET /api/v1/auth/me`

| Field | Detail |
|---|---|
| Objective | The first real, protected REST endpoint — proves the middleware end-to-end and gives the frontend a way to know who's logged in and where they should land (lobby/game/home) |
| Dependencies | P03-T02 |
| Files to create | `backend/src/routes/auth.js` |
| Files to modify | `backend/src/app.js` (mount the route) |
| Files not to touch | — |
| Implementation details | Exact shape from `API_CONTRACT.md`: `{ id, displayName, avatarUrl, activeRoomId, activeGameId }`; `activeRoomId`/`activeGameId` derived by querying `room_players`/`game_players` for a non-terminal room/game — **this query will return nothing meaningful until P08/P02 respectively have real rows to find**, which is fine, just worth noting the fields are correctly `null` until then, not broken |
| Acceptance criteria | Authenticated request returns the caller's own profile; unauthenticated request returns `401` |
| Tests | Integration: call with a valid session, assert shape and correct `id`; call with none, assert `401` |
| Risks | Low — thin read endpoint. The `active*` field logic will silently look inert until later phases populate real rows; worth a comment in the code, not a functional risk |

### P03-T04 — Frontend authentication UI

| Field | Detail |
|---|---|
| Objective | Sign-up, sign-in, and sign-out — calling `supabase-js` directly, per `API_CONTRACT.md`'s explicit note that this backend never proxies credentials |
| Dependencies | P01-T01 (existing `frontend/src/supabaseClient.js`) |
| Files to create | `frontend/src/features/auth/SignUpForm.jsx`, `SignInForm.jsx`, `AuthContext.jsx` (or equivalent session-state provider), `frontend/src/pages/Login.jsx` |
| Files to modify | `frontend/src/main.jsx` (wrap in the auth provider), `frontend/src/App.jsx` — **replace** the Vite template placeholder content here, not patch around it (`GAME_DESIGN_SPEC.md`'s own earlier audit already flagged `App.jsx` as 100% disposable template) |
| Files not to touch | `frontend/src/supabaseClient.js` — already correct, no changes needed |
| Implementation details | `supabase.auth.signUp()` / `signInWithPassword()` / `signOut()` directly; session state read from `supabase.auth.onAuthStateChange` so the UI reacts to login/logout without a page reload |
| Acceptance criteria | A new user can sign up, land in an authenticated state, sign out, and sign back in — all without the Express backend being involved in any of it |
| Tests | Manual (per this project's UI-testing pattern established since the first Supabase connection): sign up a test account in the running dev app, verify the session persists across a page refresh |
| Risks | Password handling still happens — but entirely inside `supabase-js`, never touching application code or logs. Confirm no accidental logging of credentials in dev-mode console output |

### P03-T05 — Auth error handling, session refresh verification, password-reset scope note

| Field | Detail |
|---|---|
| Objective | Close out the remaining items from your Authentication list that are mostly *verification*, not net-new construction |
| Dependencies | P03-T02, P03-T04 |
| Files to create | None |
| Files to modify | `backend/src/auth/authMiddleware.js` (ensure every failure path returns the standard error envelope, not a raw stack trace) |
| Files not to touch | — |
| Implementation details | **Session expiration/refresh**: `supabase-js` refreshes tokens automatically client-side — this task verifies that behavior (a session that outlives its access token's expiry keeps working transparently) rather than building a refresh endpoint, since `API_CONTRACT.md` already established none exists. **Password reset**: not called for by any approved spec — noting explicitly that `supabase.auth.resetPasswordForEmail()` is available out of the box if it's ever needed, requiring no backend work either way |
| Acceptance criteria | A deliberately-malformed auth header produces a clean `401` with the standard error shape, never a `500`; a session left open past its access token's natural expiry continues working without user-visible interruption |
| Tests | Manual: force an access token expiry (or wait one out) mid-session, confirm a subsequent action still succeeds transparently |
| Risks | Low — this task is mostly confirming default `supabase-js` behavior works as documented, not building new mechanism |

---

## Phase 04 — Game domain models

Pure data shapes. No logic yet — that's P05.

### P04-T01 — Core domain types

| Field | Detail |
|---|---|
| Objective | The data structures every later phase imports: `Tile`, `Property`, `EventCard`, `PlayerGameState`, `GameState` |
| Dependencies | P01-T02 |
| Files to create | `backend/src/domain/tile.js`, `property.js`, `eventCard.js`, `gameState.js` (JSDoc-typed or equivalent, per whatever type-checking approach the backend adopts — not decided by this plan) |
| Files to modify | None |
| Files not to touch | — |
| Implementation details | Exact shapes from `GAME_DESIGN_SPEC.md` §2/§7/§8/§9/§13, `ADAPTIVE_BOARD_DESIGN.md`'s tile categories |
| Acceptance criteria | Every field named in the specs above exists with the correct type; no extra, undocumented fields |
| Tests | Unit: construct a minimal valid instance of each type, assert required fields are enforced (however the chosen type system enforces "required") |
| Risks | Low — this is transcription work, but transcription errors here propagate everywhere downstream. Worth a careful line-by-line diff against the source docs rather than working from memory |

### P04-T02 — Board config loader

| Field | Detail |
|---|---|
| Objective | A function that loads a full board (all tiles, in order) for a given `boardId`, from the seed data P02-T03 created |
| Dependencies | P02-T03, P04-T01 |
| Files to create | `backend/src/domain/loadBoard.js` |
| Files to modify | None |
| Files not to touch | — |
| Implementation details | Reads `board_tiles` ordered by `position`, maps rows onto the `Tile`/`Property` types from P04-T01 |
| Acceptance criteria | `loadBoard('small')` returns exactly 36 ordered tiles; `loadBoard('large')` returns 44 |
| Tests | Unit against a test database seeded per P02-T03; assert tile count and corner positions match `ADAPTIVE_BOARD_DESIGN.md` exactly |
| Risks | Inherits P02-T03's content-placeholder risk — this loader will faithfully return placeholder property names until that's resolved, which is correct behavior, not a bug in this task |

---

## Phase 05 — Game engine

Pure functions: `(GameState, action) → GameState`. No network, no database — the property this whole architecture has insisted on since the very first design pass.

### P05-T01 — Dice and movement

| Field | Detail |
|---|---|
| Objective | Server-side dice generation and the resulting token movement |
| Dependencies | P04-T01 |
| Files to create | `backend/src/engine/dice.js`, `movement.js` |
| Files to modify | None |
| Files not to touch | — |
| Implementation details | `GAME_DESIGN_SPEC.md` §6 — `Math.random`-based, no cryptographic requirement; doubles-streak tracking, 3rd-consecutive-double short-circuit to jail per `GAME_STATE_MACHINE.md` §6 |
| Acceptance criteria | Rolling is a pure function with no external dependency, returns `{die1, die2, isDouble}`; movement correctly wraps around `BOARD_TILE_COUNT` and detects a GO pass |
| Tests | Unit: statistical distribution sanity check (not a security guarantee — see `SECURITY_DESIGN.md` threat #2's note that this class of correctness needs a *code-level* check that the function has no external input, which this task's code review, not this test, provides); movement wrap-around at both board sizes |
| Risks | None significant — this is the most self-contained function in the whole engine |

### P05-T02 — Tile resolution

| Field | Detail |
|---|---|
| Objective | Given a landed-on tile, determine which resolution branch applies — the dispatcher behind `GAME_STATE_MACHINE.md` §2's `LANDING →` fan-out |
| Dependencies | P05-T01, P04-T02 |
| Files to create | `backend/src/engine/resolveTile.js` |
| Files to modify | None |
| Files not to touch | — |
| Implementation details | Pure dispatch by `tile.type` to the correct next state name (`AWAITING_PURCHASE`/`PAYING_RENT`/`DRAWING_CARD`/`PAYING_TAX`/`POST_ACTIONS`) — this task determines *which branch*, not what happens inside it (rent calc is P05-T03, card effects are a separate concern) |
| Acceptance criteria | Every tile type in `ADAPTIVE_BOARD_DESIGN.md`'s taxonomy maps to exactly one correct next state |
| Tests | Unit: one test per tile type, asserting the correct branch |
| Risks | Low, but a missed tile type here silently breaks that entire tile category — worth a completeness assertion (e.g. an exhaustive switch with no default fallthrough) |

### P05-T03 — Rent calculation

| Field | Detail |
|---|---|
| Objective | The rent formulas — base, group-bonus, railroad, utility |
| Dependencies | P04-T01 |
| Files to create | `backend/src/engine/calculateRent.js` |
| Files to modify | None |
| Files not to touch | — |
| Implementation details | `GAME_DESIGN_SPEC.md` §11, `ECONOMY_SPECIFICATION.md` §2 — group-bonus doubling contingent on the still-open property-grouping decision (`BOARD_SPECIFICATION.md` §15); railroad `base × 2^(n-1)`, utility `diceRoll × (4 or 10)` |
| Acceptance criteria | Correct rent for every ownership/upgrade combination; group bonus correctly no-ops if grouping data is absent (given P02-T03's placeholder content may not include real group assignments yet) |
| Tests | Unit: one case per rent tier (unimproved through hotel), one for railroad count 1–4, one for utility with 1 vs. 2 owned |
| Risks | Depends on the still-open group-assignment decision — the function should be written so it degrades gracefully (no group bonus applied) rather than erroring, if group data isn't populated yet |

### P05-T04 — Jail logic

| Field | Detail |
|---|---|
| Objective | Entry, the three exit paths (pay/card/roll), and the forced-exit-on-3rd-attempt rule |
| Dependencies | P05-T01 |
| Files to create | `backend/src/engine/jail.js` |
| Files to modify | None |
| Files not to touch | — |
| Implementation details | `GAME_DESIGN_SPEC.md` §15, `MAX_JAIL_TURNS` |
| Acceptance criteria | All three exit paths correctly clear `inJail`; a 3rd failed roll attempt auto-charges the fine and releases, per the documented default |
| Tests | Unit: one test per exit path, one for the forced-3rd-attempt case |
| Risks | Low |

### P05-T05 — Bankruptcy detection and liquidation

| Field | Detail |
|---|---|
| Objective | Pure calculation of solvency — cash vs. debt, liquidation value if cash falls short |
| Dependencies | P04-T01 |
| Files to create | `backend/src/engine/bankruptcy.js` |
| Files to modify | None |
| Files not to touch | — |
| Implementation details | `ECONOMY_SPECIFICATION.md` §5 — this task computes *whether* and *how much* is recoverable; it does **not** move any coins (that's P06) |
| Acceptance criteria | Correctly identifies solvent vs. bankrupt for every combination of cash/mortgageable assets/debt; correctly computes the "creditor gets whatever's left" shortfall amount from `ECONOMY_SPECIFICATION.md` §5 |
| Tests | Unit: solvent case, liquidation-covers-it case, liquidation-insufficient case, exact-zero-remainder edge case |
| Risks | This is the function `SECURITY_DESIGN.md` threat #15's test case (partial-transaction rollback) most directly depends on being correct — get the boundary conditions right |

---

## Phase 06 — Economy engine

Also pure — the ledger and the finite-Bank model, still with no I/O.

### P06-T01 — Ledger application

| Field | Detail |
|---|---|
| Objective | Given a `GameState` and a transfer request, produce the new `GameState` and a transaction record — the `from`/`to`, always-positive shape from `DATABASE_DESIGN.md` §12 |
| Dependencies | P04-T01 |
| Files to create | `backend/src/economy/applyTransaction.js` |
| Files to modify | None |
| Files not to touch | — |
| Implementation details | `CHECK (from ≠ to)`, `CHECK (amount > 0)` enforced in-code as well as at the DB layer (defense in depth, `SECURITY_DESIGN.md` threat #1) |
| Acceptance criteria | Every application updates exactly two balances (debit one, credit the other) by the exact same amount; rejects a zero/negative amount or matching from/to before it ever reaches a balance |
| Tests | Unit: normal transfer, self-transfer rejection, zero/negative amount rejection |
| Risks | This function is the one place `ECONOMY_SPECIFICATION.md` §4's invariant either holds or doesn't — see P06-T04 |

### P06-T02 — Bank sentinel handling

| Field | Detail |
|---|---|
| Objective | The finite, negative-capable Bank participant from `ECONOMY_SPECIFICATION.md` §0 |
| Dependencies | P06-T01 |
| Files to create | `backend/src/economy/bank.js` |
| Files to modify | None |
| Files not to touch | — |
| Implementation details | Bank balance is *derived*, not stored (`DATABASE_DESIGN.md` §5) — this task provides the derivation function; the negative-allowed / no-bankruptcy behavior is a "do nothing extra" case, not special logic, worth confirming explicitly in a test rather than assuming |
| Acceptance criteria | Bank balance correctly goes negative without triggering any bankruptcy path; only real players' negative balances route to P05-T05 |
| Tests | Unit: drive the Bank's derived balance negative via repeated GO payouts with no offsetting purchases, assert no error and no bankruptcy trigger |
| Risks | Easy to accidentally write a shared "if balance < 0" check that doesn't distinguish Bank from player — worth an explicit `is_bank` branch test |

### P06-T03 — Property economy functions

| Field | Detail |
|---|---|
| Objective | Purchase, mortgage, unmortgage, and build/sell-house cost calculations |
| Dependencies | P06-T01 |
| Files to create | `backend/src/economy/propertyEconomy.js` |
| Files to modify | None |
| Files not to touch | — |
| Implementation details | `ECONOMY_SPECIFICATION.md` §2/§3 — mortgage value out, `×1.1` back in, `HOUSE_SELLBACK_RATIO` (0.5) on sell-back |
| Acceptance criteria | Each function returns the correct amount and correct transaction direction (matches §3's source→destination table exactly) |
| Tests | Unit: one test per row of `ECONOMY_SPECIFICATION.md` §3's flow table that this task covers |
| Risks | Low — direct transcription of an already-precise table |

### P06-T04 — Invariant assertion helper

| Field | Detail |
|---|---|
| Objective | A function that checks `Σ(player balances) + bank balance = MATCH_POOL` at any point — `ECONOMY_SPECIFICATION.md` §4's invariant, made real as code, not just a claim in a document |
| Dependencies | P06-T01, P06-T02 |
| Files to create | `backend/src/economy/assertInvariant.js` |
| Files to modify | None |
| Files not to touch | — |
| Implementation details | Pure function over a `GameState`, no I/O — usable both as a test helper (this phase) and, later, wired into a monitoring job (P16-T01) |
| Acceptance criteria | Returns `true`/violation-details for any given state; correctly flags a deliberately-corrupted test state (e.g. one with a manually-injected extra coin) as invalid |
| Tests | Unit: valid state passes; a state with the invariant deliberately broken fails with a specific, actionable error, not just `false` |
| Risks | Low implementation risk, high *value* — this is the single test most worth having, since it's the one that would catch an entire category of future bugs across every other economy function |

---

## Phase 07 — State machine

The orchestrator — sequences P05/P06's pure functions according to `GAME_STATE_MACHINE.md`'s approved transition table.

### P07-T01 — Core state machine

| Field | Detail |
|---|---|
| Objective | The state enum and transition table from `GAME_STATE_MACHINE.md` §1/§2/§8, wired to call the P05/P06 functions in the right order |
| Dependencies | P05 (all), P06 (all) |
| Files to create | `backend/src/stateMachine/turnMachine.js`, `roomMachine.js` |
| Files to modify | None |
| Files not to touch | — |
| Implementation details | Exact states and transitions from the approved diagrams — no reinterpretation. `DRAWING_CARD`'s auto-resolve-and-continue behavior in particular (no player input point, per `SOCKET_CONTRACT.md`'s `game:acknowledge_event` note) should be implemented literally as designed |
| Acceptance criteria | Every transition in `GAME_STATE_MACHINE.md` §8's table is reachable and produces the documented next state |
| Tests | Unit: walk a full turn end-to-end (roll → move → land → resolve → post-actions → end-turn) asserting each intermediate state; separately, one test per branch not covered by that happy path (jail, bankruptcy, doubles loop) |
| Risks | The largest, most central piece of logic in the whole backend — get the transition table transcribed exactly, and prefer many small tests over one large one so a future regression localizes to a specific transition |

### P07-T02 — Timer system

| Field | Detail |
|---|---|
| Objective | Server-side scheduled timers per `GAME_STATE_MACHINE.md` §7 — `deadlineAt` generation, and the default-action-on-timeout mechanism |
| Dependencies | P07-T01 |
| Files to create | `backend/src/stateMachine/timers.js` |
| Files to modify | None |
| Files not to touch | — |
| Implementation details | One scheduled callback per room per active timer, not per-player polling; a fired timeout synthesizes the state's documented default action and runs it through the *same* apply pipeline as a real action — no separate timeout code path (§7's explicit requirement) |
| Acceptance criteria | Every timed state in `GAME_STATE_MACHINE.md` §4's table fires its documented default at the correct proposed duration |
| Tests | Unit with a fake/injectable clock (not real `setTimeout` waits) — assert the default action fires exactly at `deadlineAt`, not before or meaningfully after |
| Risks | Untestable-in-real-time bugs are the classic failure mode here — insist on an injectable clock from the start, not bolted on later |

### P07-T03 — Idempotency layer

| Field | Detail |
|---|---|
| Objective | `clientActionId` dedup cache and the monotonic `stateVersion` counter, per `GAME_STATE_MACHINE.md` §6 |
| Dependencies | P07-T01 |
| Files to create | `backend/src/stateMachine/idempotency.js` |
| Files to modify | None |
| Files not to touch | — |
| Implementation details | In-memory, per-game — this is the layer P02-T01's `game_actions` unique constraints back up later (P13), not a replacement for them |
| Acceptance criteria | A repeated `clientActionId` within the cache window is a no-op, not a reapplication; `stateVersion` increments exactly once per successfully-applied action, never on a rejected one |
| Tests | Unit: send the same action twice, assert one state change; assert a rejected action leaves `stateVersion` unchanged |
| Risks | Directly implements `SECURITY_DESIGN.md` threat #5's mitigation — test the exact scenario in that threat's TEST CASE row |

### P07-T04 — Special mechanic states (conditional)

| Field | Detail |
|---|---|
| Objective | Flash Auction / Rent Risk Choice / Hostile Acquisition state transitions, per `GAME_STATE_MACHINE.md` §3 |
| Dependencies | P07-T01 |
| Files to create | `backend/src/stateMachine/flashAuction.js`, `rentRiskChoice.js`, `hostileAcquisition.js` |
| Files to modify | None |
| Files not to touch | — |
| Implementation details | **Conditional on approval status** — these three mechanics remain `[PROPOSED]`, not `[CONFIRMED]`, across every document that's touched them. This task should not start until they're either confirmed as final rules or explicitly descoped from the MVP — building against a mechanic that then changes shape is wasted work in a way none of this plan's other tasks are |
| Acceptance criteria | If built: matches `GAME_STATE_MACHINE.md` §3's state diagrams exactly, including the still-open Hostile Acquisition timeout-default fork |
| Tests | Unit per mechanic, mirroring P07-T01's approach |
| Risks | **Scope risk, not implementation risk** — the biggest open question this whole plan surfaces is whether these three mechanics ship in the MVP at all |

---

## Phase 08 — Room/lobby

The REST endpoints from `API_CONTRACT.md`'s Rooms section.

### P08-T01 — Create/get room

| Field | Detail |
|---|---|
| Objective | `POST /api/v1/rooms`, `GET /api/v1/rooms/:id` |
| Dependencies | P03-T02 (auth middleware), P02-T01 |
| Files to create | `backend/src/routes/rooms.js` |
| Files to modify | `backend/src/app.js` |
| Files not to touch | — |
| Implementation details | Exact request/response/error shapes from `API_CONTRACT.md`; `Idempotency-Key` support on create; the 404-for-both-cases privacy rule on get |
| Acceptance criteria | Matches `API_CONTRACT.md`'s tables for these two endpoints exactly, including status codes |
| Tests | Integration: create, then get as a member (success) and as a non-member (404) |
| Risks | Low |

### P08-T02 — Join/leave/ready

| Field | Detail |
|---|---|
| Objective | `POST /rooms/:code/join`, `POST /rooms/:id/leave`, `PATCH /rooms/:id/ready` |
| Dependencies | P08-T01 |
| Files to create | None (extends `rooms.js`) |
| Files to modify | `backend/src/routes/rooms.js` |
| Files not to touch | — |
| Implementation details | Join's natural (constraint-backed, not header-based) idempotency; the strict rate limit on join specifically (`SECURITY_DESIGN.md` threat #8/#12) |
| Acceptance criteria | Rejoining an already-joined room is a no-op, not an error; leaving mid-game (once P08-T03 exists) is correctly rejected as out-of-window |
| Tests | Integration per endpoint; a specific test hammering the join rate limit, asserting it engages at the documented threshold |
| Risks | The join rate limit is doing real security work (brute-force resistance) — this is the one endpoint in this phase worth a dedicated abuse-focused test, not just a happy-path one |

### P08-T03 — Start game

| Field | Detail |
|---|---|
| Objective | `POST /rooms/:id/start` — the first point where Room, Database, Domain models, Engine, and Economy phases all connect |
| Dependencies | P08-T01, P04-T02, P06-T01, P07-T01 |
| Files to create | None (extends `rooms.js`) |
| Files to modify | `backend/src/routes/rooms.js` |
| Files not to touch | — |
| Implementation details | Full host/ready/count validation from `API_CONTRACT.md`; board auto-selection by player count (`ADAPTIVE_BOARD_DESIGN.md`); the multi-statement DB transaction from `DATABASE_DESIGN.md` § Transaction strategy ("Game start") — **this is the first task in the plan that actually needs P13's persistence wiring to be meaningfully testable end-to-end**, so its integration test should be written now but may need to stub persistence until P13 lands |
| Acceptance criteria | A valid start produces a `games` row, `game_players` rows (including the Bank sentinel), initial `properties` rows, and the initial-deal `game_transactions` rows, all-or-nothing |
| Tests | Integration: the happy path; a deliberately-injected mid-transaction failure, asserting full rollback (`SECURITY_DESIGN.md` threat #15's test case, applied to this specific operation) |
| Risks | The highest-integration-risk task in P08 — it's the seam where five earlier phases first have to actually agree with each other |

### P08-T04 — Kick player *(gap closure)*

| Field | Detail |
|---|---|
| Objective | A host-kick endpoint — `GAME_DESIGN_SPEC.md` §4 defines the rule, but `API_CONTRACT.md`'s Phase 08 scope never designed the endpoint, and `SECURITY_DESIGN.md` flagged this gap explicitly |
| Dependencies | P08-T01 |
| Files to create | None (extends `rooms.js`) |
| Files to modify | `backend/src/routes/rooms.js`, and **`docs/API_CONTRACT.md`** — this task should add the missing endpoint definition to that document before or alongside implementing it, so the contract doc stays the source of truth rather than implementation quietly outrunning it |
| Files not to touch | — |
| Implementation details | Same host-authorization pattern as `start_game`; pre-game only, per `GAME_DESIGN_SPEC.md` §4 |
| Acceptance criteria | Non-host attempts rejected (`403`); kicked player removed from `room_players` |
| Tests | Integration, mirroring P08-T01's pattern |
| Risks | Low technically — the actual risk was the spec gap itself, already called out |

---

## Phase 09 — Socket.IO

The realtime contract from `SOCKET_CONTRACT.md`.

### P09-T01 — Server setup and authenticated connection

| Field | Detail |
|---|---|
| Objective | Socket.IO server, per-game namespacing (`/game/:gameId`), and the handshake-time JWT + participant check |
| Dependencies | P01-T02, P03-T02, P08-T03 (a game must be creatable to have something to connect to) |
| Files to create | `backend/src/sockets/server.js`, `backend/src/sockets/authenticate.js` |
| Files to modify | `backend/src/server.js` (attach Socket.IO to the same HTTP server) |
| Files not to touch | — |
| Implementation details | Reuses P03-T02's JWT utility directly, not a re-implementation; **`SECURITY_DESIGN.md`'s connection-level tightening applies here** — reject a non-participant at the namespace handshake, before any event handler runs, not just per-event |
| Acceptance criteria | A valid participant connects successfully; a non-participant's connection attempt is refused outright |
| Tests | Integration: connect as a participant (success), connect as a non-participant (refused at handshake, confirmed by asserting no `connection` event ever fires server-side for that attempt) |
| Risks | Directly closes `SECURITY_DESIGN.md` gap #3 — worth a dedicated test proving the rejection happens at connect, not first-event, since that distinction is the whole point of the fix |

### P09-T02 — Core gameplay events

| Field | Detail |
|---|---|
| Objective | `game:roll_dice`, `game:buy_property`, `game:decline_purchase`, `game:end_turn` — the happy-path turn loop |
| Dependencies | P09-T01, P07-T01 |
| Files to create | `backend/src/sockets/handlers/gameplay.js` |
| Files to modify | None |
| Files not to touch | — |
| Implementation details | Exact payload/validation/broadcast per `SOCKET_CONTRACT.md`'s tables for these four events; strict schema validation on every payload before it reaches the state machine (`SECURITY_DESIGN.md` threats #1/#11) |
| Acceptance criteria | A full turn (roll → resolve → end) is playable between two connected test clients |
| Tests | Integration with two real socket connections (not mocked) — a complete turn cycle, asserting both clients receive the correct broadcasts |
| Risks | First point in the plan where real-time, multi-client behavior is actually exercised — budget more test-writing time here than the line count suggests |

### P09-T03 — Special mechanic events (conditional)

| Field | Detail |
|---|---|
| Objective | `game:auction_bid`, `game:risk_reward_choice`, `game:initiate/respond_hostile_acquisition` |
| Dependencies | P09-T02, P07-T04 |
| Files to create | `backend/src/sockets/handlers/specialMechanics.js` |
| Files to modify | None |
| Files not to touch | — |
| Implementation details | Same conditionality as P07-T04 — don't start until those mechanics' rule status is resolved |
| Acceptance criteria | Matches `SOCKET_CONTRACT.md`'s tables for these events |
| Tests | Integration, one scenario per mechanic |
| Risks | Same scope risk as P07-T04, not implementation risk |

### P09-T04 — State broadcast wiring

| Field | Detail |
|---|---|
| Objective | `game:state_update`, `game:player_moved`, `game:dice_result`, `game:property_ownership_changed`, `game:rent_resolved`, `game:balance_updated`, `game:turn_changed` — the server→client half |
| Dependencies | P09-T02 |
| Files to create | `backend/src/sockets/broadcast.js` |
| Files to modify | None |
| Files not to touch | — |
| Implementation details | Each event's exact payload and recipient scope from `SOCKET_CONTRACT.md`; `stateVersion` included on every state-carrying broadcast |
| Acceptance criteria | Every event a client action can trigger produces exactly the broadcasts `SOCKET_CONTRACT.md` documents for it, no more, no fewer |
| Tests | Integration: assert the exact broadcast set for each action from P09-T02, not just that *some* broadcast happened |
| Risks | Low once P09-T02 exists — this is largely mechanical wiring against an already-precise contract |

### P09-T05 — Missing event contracts *(gap closure)*

| Field | Detail |
|---|---|
| Objective | `build_house`/`sell_house`/`mortgage`/`unmortgage`/`propose_trade`/`respond_trade` — referenced in `GAME_DESIGN_SPEC.md` §12 but never given full `SOCKET_CONTRACT.md` event tables (`SECURITY_DESIGN.md` gap #1) |
| Dependencies | P09-T02, P06-T03 |
| Files to create | `backend/src/sockets/handlers/propertyManagement.js` |
| Files to modify | **`docs/SOCKET_CONTRACT.md`** — add the missing event tables before/alongside implementation, same reasoning as P08-T04 |
| Files not to touch | — |
| Implementation details | Same rigor as every other Socket Contract event — sender authorization, state requirement, validation, idempotency, all specified before code is written, not decided ad hoc during implementation |
| Acceptance criteria | These six events reach the same specification bar every other event in `SOCKET_CONTRACT.md` was held to |
| Tests | Mirrors P09-T02's pattern |
| Risks | This is where the "no client event carries an amount that becomes a balance" property (§ Server-authority boundary) most needs deliberate attention — trading in particular involves two-sided offers, which is a richer surface than anything else in this contract |

---

## Phase 10 — Reconnection

### P10-T01 — `game:sync` and connection tracking

| Field | Detail |
|---|---|
| Objective | The reconnect/refresh handler, and in-memory (never persisted) connection status |
| Dependencies | P09-T01 |
| Files to create | `backend/src/sockets/handlers/sync.js` |
| Files to modify | None |
| Files not to touch | Do **not** add a `connected` column to `game_players` — `DATABASE_DESIGN.md`'s ephemeral-state exclusion is deliberate, not an oversight to "fix" here |
| Implementation details | Matches by `userId`, never socket id, per `GAME_DESIGN_SPEC.md` §23; naturally idempotent, no mutation |
| Acceptance criteria | A disconnect-then-reconnect cycle (simulated by closing and reopening a test socket) correctly restores the player to `connected: true` and delivers current state |
| Tests | Integration: disconnect, wait briefly, reconnect, assert `player:reconnected` fires and the reconnecting socket receives full state |
| Risks | Low — this task is largely already fully specified by `SOCKET_CONTRACT.md` and `GAME_STATE_MACHINE.md` §5/§9 |

### P10-T02 — Disconnect/AFK timers

| Field | Detail |
|---|---|
| Objective | Grace period, auto-skip-on-timeout, and the AFK escalation after repeated misses |
| Dependencies | P10-T01, P07-T02 |
| Files to create | `backend/src/sockets/afkTracker.js` |
| Files to modify | None |
| Files not to touch | — |
| Implementation details | `RECONNECT_GRACE_SECONDS`, `AFK_THRESHOLD_MISSED_TURNS` — the disconnect-exploitation mitigations from `SECURITY_DESIGN.md` threat #13 apply directly here: the grace timer must never pause a state's own action timeout |
| Acceptance criteria | A disconnected current-turn player's turn is auto-skipped exactly at grace-period expiry, not delayed by anything |
| Tests | Directly implements `SECURITY_DESIGN.md` threat #13's test case — disconnect mid-decision, assert the timeout default fires on schedule |
| Risks | Timer-interaction bugs are easy to introduce here; reuse P07-T02's injectable-clock testing approach rather than real-time waits |

### P10-T03 — Server-restart recovery

| Field | Detail |
|---|---|
| Objective | Rehydrate in-memory `GameState` from the latest `game_state_snapshots` row on process boot |
| Dependencies | P13-T01 (needs snapshots to actually exist in the database) |
| Files to create | `backend/src/recovery/rehydrate.js` |
| Files to modify | `backend/src/server.js` (run on boot) |
| Files not to touch | — |
| Implementation details | Query `games WHERE status = 'in_progress'`, load each one's snapshot, resume the `stateVersion` counter from the persisted value (`GAME_STATE_MACHINE.md` §9) |
| Acceptance criteria | Killing and restarting the backend mid-match results in the match being fully resumable, indistinguishable to reconnecting players from an ordinary disconnect |
| Tests | Integration: start a game, advance a few turns, kill the process, restart, reconnect, assert state matches what it was before the kill |
| Risks | This task can't be meaningfully tested until P13 exists — listed here to keep it next to P10-T01/T02 conceptually, but its real dependency is on the persistence phase, not just the reconnection phase |

---

## Phase 11 — React board

### P11-T01 — Adaptive board rendering

| Field | Detail |
|---|---|
| Objective | The board component itself, honoring `ADAPTIVE_BOARD_DESIGN.md`'s rendering strategy |
| Dependencies | P04-T02 (needs real tile data to render, even if placeholder content) |
| Files to create | `frontend/src/features/game/Board.jsx`, `Tile.jsx` |
| Files to modify | None |
| Files not to touch | — |
| Implementation details | **Consistent, readable tile size — no forced shrink-to-fit**; a pan/zoom viewport for the board specifically, not the whole page |
| Acceptance criteria | Both board sizes render correctly at their approved tile counts (36/44); tiles remain legibly sized on the Large board, which exceeds one unzoomed screen by design, not by bug |
| Tests | Manual, per this project's established UI-testing pattern: render both board sizes, visually confirm against `ADAPTIVE_BOARD_DESIGN.md`'s described layout |
| Risks | This is the first genuinely new frontend surface since the project's initial scaffold — expect this task to reveal UI decisions the specs left open (exact pixel sizing, for instance) that will need small judgment calls during implementation |

### P11-T02 — Pawn rendering and stacking

| Field | Detail |
|---|---|
| Objective | Player tokens, including the count-badge stacking behavior for multiple pawns on one tile |
| Dependencies | P11-T01 |
| Files to create | `frontend/src/features/game/Pawn.jsx`, `PawnStack.jsx` |
| Files to modify | None |
| Files not to touch | — |
| Implementation details | `ADAPTIVE_BOARD_DESIGN.md`'s readability decisions — larger corner footprint, compact stack-with-badge instead of overlapping icons |
| Acceptance criteria | 6 pawns on the GO tile (the worst case, guaranteed at every match's start) render legibly, not as an unreadable cluster |
| Tests | Manual: render a 6-player game state with all pawns at GO, visually confirm legibility |
| Risks | Low |

### P11-T03 — Property/tile visual states

| Field | Detail |
|---|---|
| Objective | Ownership, mortgage, and upgrade-level visual indicators on tiles |
| Dependencies | P11-T01 |
| Files to create | None (extends `Tile.jsx`) |
| Files to modify | `frontend/src/features/game/Tile.jsx` |
| Files not to touch | — |
| Implementation details | Owner-color marking, mortgaged indicator, house/hotel count display |
| Acceptance criteria | A tile's visual state always matches the `properties` data it's given — no independent client-side ownership tracking of any kind |
| Tests | Manual, across the ownership/mortgage/upgrade state space |
| Risks | Low |

---

## Phase 12 — Gameplay UI

### P12-T01 — HUD

| Field | Detail |
|---|---|
| Objective | Balance, dice display, turn indicator — in a fixed layout region **outside** the board's pan/zoom viewport, per your explicit rendering requirement (`ADAPTIVE_BOARD_DESIGN.md`) |
| Dependencies | P11-T01 |
| Files to create | `frontend/src/features/game/Hud.jsx` |
| Files to modify | None |
| Files not to touch | — |
| Implementation details | Structurally separate component tree from the board viewport, not just visually overlapping it — the two must be independently scrollable/zoomable |
| Acceptance criteria | Zooming or panning the board never hides or moves the HUD |
| Tests | Manual: zoom/pan the board to an extreme, confirm HUD remains fully visible and operable throughout |
| Risks | Easy to get subtly wrong with CSS (an HUD that's *visually* separate but *structurally* nested inside the zoomable container) — worth explicitly testing the failure mode, not just the default view |

### P12-T02 — Action controls

| Field | Detail |
|---|---|
| Objective | Buy/decline/build/mortgage/end-turn controls, contextual to the current state |
| Dependencies | P12-T01, P09-T02 |
| Files to create | `frontend/src/features/game/ActionPanel.jsx` |
| Files to modify | None |
| Files not to touch | — |
| Implementation details | Only renders controls valid in the current state (per `GAME_STATE_MACHINE.md` §4's allowed-actions column) — not just disabling invalid ones, since a control for an impossible action shouldn't exist to begin with |
| Acceptance criteria | The only visible actions at any moment are ones the server would actually accept |
| Tests | Manual, across a full turn's state progression |
| Risks | Low |

### P12-T03 — Special mechanic UI (conditional)

| Field | Detail |
|---|---|
| Objective | Auction bidding panel, risk/reward choice modal, hostile acquisition prompt |
| Dependencies | P12-T02, P09-T03 |
| Files to create | `frontend/src/features/game/AuctionPanel.jsx`, `RiskRewardModal.jsx`, `HostileAcquisitionPrompt.jsx` |
| Files to modify | None |
| Files not to touch | — |
| Implementation details | Same conditionality as P07-T04/P09-T03 |
| Acceptance criteria | Matches whichever mechanics were actually built in P09-T03 |
| Tests | Manual, one per mechanic |
| Risks | Same scope dependency as P07-T04 |

### P12-T04 — Lobby UI

| Field | Detail |
|---|---|
| Objective | Room creation, join-by-code, player list, ready toggle, start button |
| Dependencies | P08 (all), P03-T04 |
| Files to create | `frontend/src/pages/Lobby.jsx` |
| Files to modify | None |
| Files not to touch | — |
| Implementation details | Calls the P08 REST endpoints directly; per `API_CONTRACT.md`'s scope note, listens for the (not-yet-designed-in-detail) `room:updated` push notification to refresh without polling — falling back to a manual refresh/poll if that notification isn't built yet is an acceptable interim state, not a blocker |
| Acceptance criteria | Two browser sessions can create, join, ready up, and start a game together end-to-end |
| Tests | Manual, two-browser-session walkthrough |
| Risks | Low |

---

## Phase 13 — Supabase integration

Wiring the pure P05–P07 logic to real persistence.

### P13-T01 — Snapshot persistence

| Field | Detail |
|---|---|
| Objective | `game_state_snapshots` upsert, triggered at every `SNAPSHOT_TRIGGER` point |
| Dependencies | P07-T01, P02-T01 |
| Files to create | `backend/src/persistence/snapshots.js` |
| Files to modify | `backend/src/stateMachine/turnMachine.js` (call the persistence hook at the documented trigger points) |
| Files not to touch | — |
| Implementation details | `UPSERT ... ON CONFLICT (game_id)`, per `DATABASE_DESIGN.md` §9 — one row per game, not accumulated history |
| Acceptance criteria | A snapshot exists and is current after every turn-end, bankruptcy, and game-over |
| Tests | Integration: play through several turns, assert the snapshot's `state_version` matches the in-memory counter after each |
| Risks | Low — a well-specified, single-purpose write |

### P13-T02 — Transaction/action/event logging

| Field | Detail |
|---|---|
| Objective | Wire `game_transactions`/`game_actions`/`game_events` writes into the outputs of P06/P07 |
| Dependencies | P06-T01, P07-T01, P02-T01 |
| Files to create | `backend/src/persistence/ledger.js`, `actionLog.js`, `eventLog.js` |
| Files to modify | `backend/src/economy/applyTransaction.js`, `backend/src/stateMachine/turnMachine.js` (call the logging hooks) |
| Files not to touch | — |
| Implementation details | The `idempotency_key`/`client_action_id`/`state_version` unique constraints from P02-T01 are what actually make this durable — this task just needs to supply the right values, not reimplement the guarantee |
| Acceptance criteria | Every applied action/transaction produces exactly the durable rows `DATABASE_DESIGN.md` describes; a duplicate write attempt is rejected by the database itself, confirmed by test, not assumed |
| Tests | Integration: apply a transaction twice with the same idempotency key, assert the second is rejected at the database layer (`SECURITY_DESIGN.md` threat #5/#6's database-protection row, verified for real) |
| Risks | This is where several of `SECURITY_DESIGN.md`'s "database protection" claims stop being descriptions and start being testable facts — treat those claims as this task's acceptance criteria, not just design intent |

### P13-T03 — Properties table live-write wiring

| Field | Detail |
|---|---|
| Objective | `properties.owner_id`/`upgrade_level`/`mortgaged` written live, per `DATABASE_DESIGN.md` §8's explicit "not snapshot-cadence" decision |
| Dependencies | P06-T03, P02-T01 |
| Files to create | `backend/src/persistence/properties.js` |
| Files to modify | `backend/src/economy/propertyEconomy.js` |
| Files not to touch | — |
| Implementation details | Written immediately on every ownership-changing action, not batched — the frequency argument from `DATABASE_DESIGN.md` §8 (much lower frequency than balance changes) is what makes this affordable |
| Acceptance criteria | `properties` in the database always reflects live ownership within one action's latency, never stale by a full turn |
| Tests | Integration: buy a property, immediately query `properties` directly (bypassing the in-memory state), assert it's already correct |
| Risks | Low |

### P13-T04 — Match settlement persistence

| Field | Detail |
|---|---|
| Objective | `match_results` + final `game_players` updates (`final_rank`, `bankrupt_at`) |
| Dependencies | P07-T01, P02-T01 |
| Files to create | `backend/src/persistence/settlement.js` |
| Files to modify | `backend/src/stateMachine/turnMachine.js` (call on `GAME_ENDING`) |
| Files not to touch | — |
| Implementation details | The multi-statement transaction from `DATABASE_DESIGN.md` § Transaction strategy ("Match settlement") |
| Acceptance criteria | A finished game produces a `match_results` row and correct `final_rank` ordering, queryable via `GET /api/v1/games/:id/result` unchanged from what `game:finished` broadcast live |
| Tests | Integration: play a game to completion, compare the REST result endpoint's response against the `game:finished` payload the winning client actually received — they should be identical, per `API_CONTRACT.md`'s explicit design intent |
| Risks | Low — the two response shapes were deliberately designed to match; this task is really about not accidentally diverging them |

---

## Phase 14 — Testing

Integration/end-to-end work, building on the unit tests every earlier task already required.

### P14-T01 — Unit coverage audit

| Field | Detail |
|---|---|
| Objective | Confirm nothing from P04–P07's acceptance criteria was skipped under time pressure during earlier phases |
| Dependencies | P04–P07 (all) |
| Files to create | None |
| Files to modify | Backfill any test gaps found, in their original files |
| Files not to touch | — |
| Implementation details | A deliberate audit pass, not new construction — cross-check every earlier task's "Acceptance criteria" and "Tests" rows against what actually exists |
| Acceptance criteria | Every acceptance criterion from P04–P07 has a corresponding passing test |
| Tests | This task *is* the test-writing |
| Risks | The most likely phase to get compressed under schedule pressure — worth protecting explicitly rather than assuming it happens implicitly during earlier phases |

### P14-T02 — Full-lifecycle integration test

| Field | Detail |
|---|---|
| Objective | Room create → join (×N) → ready → start → several turns → a bankruptcy → game finish, as one continuous automated test |
| Dependencies | P13 (all) |
| Files to create | `backend/test/integration/fullMatch.test.js` |
| Files to modify | None |
| Files not to touch | — |
| Implementation details | Drives real REST + Socket.IO calls against a real (test) database — the closest thing to an actual played match this plan produces without a human at the keyboard |
| Acceptance criteria | The whole sequence completes without manual intervention, and the final state matches every relevant approved spec (economy invariant holds, correct winner, correct standings) |
| Tests | This task is itself the test |
| Risks | Likely to be the single test that surfaces the most integration bugs — expect it to take longer than its description implies |

### P14-T03 — Concurrency/race-condition suite

| Field | Detail |
|---|---|
| Objective | Directly implement `SECURITY_DESIGN.md` threats #5, #7, and #14's TEST CASE entries as real automated tests |
| Dependencies | P09-T02, P13-T02 |
| Files to create | `backend/test/security/concurrency.test.js` |
| Files to modify | None |
| Files not to touch | — |
| Implementation details | Includes the specific "deliberately introduce an `await` mid-mutation" regression test from threat #14 — proving the database-level backstop actually works, not just the in-process guarantee |
| Acceptance criteria | Every TEST CASE row from those three threats passes |
| Tests | This task is the test suite |
| Risks | Genuinely hard to write well — simulating true concurrency in a test harness often requires deliberately-introduced timing hooks, not just "call two things at once" |

### P14-T04 — Full security regression suite

| Field | Detail |
|---|---|
| Objective | Every remaining TEST CASE from `SECURITY_DESIGN.md`'s 15 threats, as automated tests |
| Dependencies | P14-T03, all of P02/P03/P08/P09 |
| Files to create | `backend/test/security/` (one file per threat, or grouped sensibly) |
| Files to modify | None |
| Files not to touch | — |
| Implementation details | A direct implementation pass over a document that already specifies exactly what to test — the least ambiguous task in this entire plan |
| Acceptance criteria | All 15 threats' test cases pass |
| Tests | This task is the test suite |
| Risks | Low ambiguity, but real effort — 15 threats' worth of adversarial test-writing is not small |

---

## Phase 15 — Security validation

Closing the loop on `SECURITY_DESIGN.md` with the real implementation in hand.

### P15-T01 — Close the four documented gaps

| Field | Detail |
|---|---|
| Objective | Confirm the four gaps `SECURITY_DESIGN.md` flagged were actually closed by P08-T04, P09-T01, and P09-T05, plus revisit the admin-role scoping note |
| Dependencies | P08-T04, P09-T01, P09-T05 |
| Files to create | None |
| Files to modify | `docs/SECURITY_DESIGN.md` — update its § Gaps found section to reflect closure, or explain why one wasn't closed |
| Files not to touch | — |
| Implementation details | A verification pass, not new construction |
| Acceptance criteria | Each of the four gaps has a documented resolution |
| Tests | Re-run the relevant tests from P14-T04 |
| Risks | Low |

### P15-T02 — RLS policy verification against the real schema

| Field | Detail |
|---|---|
| Objective | Confirm P02-T02's policies, as actually deployed, match `DATABASE_DESIGN.md`'s intent exactly |
| Dependencies | P02-T02 |
| Files to create | None |
| Files to modify | None (fixes only if a deviation is found) |
| Files not to touch | — |
| Implementation details | Query `pg_policies` directly against the real project, diff against the documented strategy |
| Acceptance criteria | Zero undocumented policies, zero missing documented ones |
| Tests | The verification itself |
| Risks | Low if P02-T02 was done carefully; this is a safety net, not a first line of defense |

### P15-T03 — Rate-limit load testing

| Field | Detail |
|---|---|
| Objective | Confirm the proposed numbers in `API_CONTRACT.md`/`SOCKET_CONTRACT.md` actually engage at their stated thresholds under real load |
| Dependencies | P08 (all), P09 (all) |
| Files to create | `backend/test/load/rateLimits.js` |
| Files to modify | None |
| Files not to touch | — |
| Implementation details | All the proposed rate-limit numbers across this whole project were explicitly marked as untested starting points — this is where that changes |
| Acceptance criteria | Every documented limit engages within a reasonable margin of its stated threshold, neither drastically early nor drastically late |
| Tests | The load test itself |
| Risks | May surface that some proposed numbers need adjusting — expected, not a failure of earlier design work |

---

## Phase 16 — Balance instrumentation

### P16-T01 — Invariant monitoring

| Field | Detail |
|---|---|
| Objective | Operationalize P06-T04's invariant-assertion helper as a live monitor over real, in-progress games |
| Dependencies | P06-T04, P13 (all) |
| Files to create | `backend/src/monitoring/invariantCheck.js` |
| Files to modify | None |
| Files not to touch | — |
| Implementation details | Runs the same pure assertion function from P06-T04 against every in-progress game's current state, on a schedule or after every snapshot; alerts (however alerting is eventually wired — logging at minimum) on any violation |
| Acceptance criteria | A deliberately-corrupted test game (same technique as P06-T04's unit test, run against a real persisted game) is detected |
| Tests | Integration: corrupt a test game's ledger directly in the database, confirm the monitor flags it |
| Risks | Low technical risk — the hard part (the assertion logic) was already built and tested in P06-T04 |

### P16-T02 — Economy metrics

| Field | Detail |
|---|---|
| Objective | Lightweight logging of transaction volume, average game length, and similar figures — groundwork for eventually tuning the many values this whole project marked `BALANCE TBD`/`PROPOSED` |
| Dependencies | P13-T02 |
| Files to create | `backend/src/monitoring/metrics.js` |
| Files to modify | None |
| Files not to touch | — |
| Implementation details | Deliberately minimal for this plan's scope — enough to eventually inform real numbers for `STARTING_BALANCE`, `BANK_RESERVE_INITIAL`, and the rest, not a full analytics platform |
| Acceptance criteria | Basic counts (transactions per game, turns per game) are captured somewhere queryable |
| Tests | Manual verification the numbers look sane after a few played test games |
| Risks | Scope creep is the main risk here — easy to over-build a "metrics platform" when the actual need is a handful of counters |

---

## Cross-cutting notes

- **Every task phase above lists real dependencies on earlier tasks** — this plan is meant to be followed roughly in order within a phase and strictly in order across phases, not treated as a flat backlog to reorder freely. P08-T03 in particular is the first genuine integration seam; treat it as a milestone, not just another task.
- **Three tasks (P07-T04, P09-T03, P12-T03) are explicitly conditional** on Flash Auction/Rent Risk Choice/Hostile Acquisition being confirmed as real rules rather than remaining proposed concepts. Worth resolving that before this plan reaches those tasks, not during them.
- **Two tasks (P08-T04, P09-T05) update an already-"approved" spec document as part of implementing it** — flagged explicitly in those tasks rather than done silently, consistent with how every other cross-document revision in this project has been handled.
