# CoBacTyPhu — Board Specification & Mechanics Proposal

Source image: physical "Cờ Tỷ Phú" board (folded cloth/paper mat), photographed at an angle with visible fold creases. This document is what was actually confirmed from that photo — not reconstructed from general knowledge of Vietnamese Monopoly editions. Where text is small, rotated, near a fold, or otherwise not clearly legible in the image, the field is marked `UNKNOWN` rather than filled with a plausible-sounding guess, per your instruction.

**Reading-confidence key:**
- **Confirmed** — large, clearly legible text, read directly.
- **UNKNOWN (tentative: "…")** — some visual signal present, but not clear enough to state as fact. The tentative text is a hint for you to verify against the physical board, not a claim.
- **UNKNOWN** — no reliable reading possible from this image.

If you want full per-tile precision, the fastest path is a straight-on close-up photo of each of the four edges individually — the current single angled full-board shot is the limiting factor, not the analysis.

---

## Part 1 — Board Specification

### 1–3, 11–13, 16: Structure, corners, and direction (Confirmed)

- **Shape**: square, single loop, standard Monopoly-style layout. Physical board is a folding mat (visible center creases), photographed at a slight angle.
- **Center**: title art reading "CỜ TỶ PHÚ" with a mascot illustration (money-bag character), plus two distinct card-deck icons repeated around the board — a **red diamond marked "CƠ HỘI"** ("Opportunity" — the Chance-equivalent deck) and a **yellow diamond marked "KHÍ VẬN"** ("Fortune" — the Community-Chest-equivalent deck).
- **Total tile count**: **UNKNOWN precisely.** Grid lines suggest roughly 4 corners + ~7 tiles per edge (~32 total), consistent with the smaller "mini" Cờ Tỷ Phú sets, but I can't count every division with full confidence from this photo — treat 32 as a working estimate, not a confirmed count.
- **Corner spaces** (all four read clearly — large text, less affected by angle/rotation than edge tiles):

| Corner | Text read | Function |
|---|---|---|
| Bottom-left | "BẮT ĐẦU" + a directional arrow icon | Start / GO |
| Top-left | "Ở TÙ" / "THĂM TÙ" (rotated, stacked — exact line order UNKNOWN) | Jail / Just Visiting |
| Top-right | "BÃI ĐẬU XE MIỄN PHÍ" + car icon | Free Parking |
| Bottom-right | "VÀO TÙ" + police/prisoner icon | Go to Jail |

- **Player movement direction (§16)**: an arrow icon is clearly present on the GO tile — its existence is confirmed — but its exact pointing direction is **UNKNOWN** at this photo's angle and resolution. Practical note: nothing in the Game Design Spec's turn logic depends on which absolute direction is "clockwise," only on a consistent `position = (position + roll) mod tileCount` rule, so this unknown doesn't block implementation — it only needs a physical look at the board to confirm before the board config is finalized.

### 4–10, 14–15: Tile types and property data

**Tile-type taxonomy — Confirmed to exist on this board** (the category labels themselves are legible even where individual instances aren't):

| Type | Label as read | Notes |
|---|---|---|
| Property | (no category label — individual name + price per tile) | Most numerous tile type |
| Chance-equivalent | "CƠ HỘI" (red diamond, "?" mark) | Appears multiple times around the loop |
| Fortune-equivalent | "KHÍ VẬN" (yellow diamond) | Appears multiple times around the loop |
| Tax | "THUẾ …" (e.g. one instance reads "THUẾ ĐẶC BIỆT") | At least one confirmed instance; exact count UNKNOWN |
| Transport / bus station | "BẾN XE …" | At least one confirmed instance; exact count UNKNOWN |
| Utility-equivalent | "CÔNG TY …" ("Company") | At least one confirmed instance; exact count UNKNOWN |
| Corners | see table above | 4, all confirmed |

**Visual grouping / color coding (§15)**: **UNKNOWN.** Unlike classic Monopoly's colored header strip per property, this board's property tiles appear to be a uniform white/cream background with small per-tile icon art rather than a clear color-band grouping system. I can't confirm color-coded property groups exist on this board at all from this image — this may simply not be how this edition groups properties, or the grouping may be too subtle to read at this resolution. Don't assume group-based rent bonuses (§11 of the Game Design Spec) transfer to this board without confirming groups actually exist.

**Per-tile table.** Grouped by physical edge rather than a single clockwise index, since the direction itself is unconfirmed (see §16 above) — converting this to a numbered sequence is a one-line fix once the arrow direction is verified. `L` = left edge (Start-corner to Jail-corner), `T` = top edge, `R` = right edge, `B` = bottom edge, each numbered outward from the corner nearer Start.

| tileId | boardPosition | name | tileType | visualGroup | propertyPrice | ownershipAllowed | baseRent | specialEffect | proposedGameplayRole | openDesignDecisions |
|---|---|---|---|---|---|---|---|---|---|---|
| T-GO | Corner | BẮT ĐẦU | go | — | — | false | — | pass/land salary | turn cycle anchor | salary amount UNKNOWN (see Game Design Spec `PASS_GO_SALARY`) |
| T-L1 | L1 | UNKNOWN (tentative: "HAI BÀ TRƯNG") | property | UNKNOWN | UNKNOWN (tentative: $120) | true | UNKNOWN | none | standard property | verify name/price against board |
| T-L2 | L2 | UNKNOWN (tentative: "VÕ THỊ SÁU") | property | UNKNOWN | UNKNOWN (tentative: $120) | true | UNKNOWN | none | standard property | verify name/price |
| T-L3 | L3 | — | chance (CƠ HỘI) | — | — | false | — | draw card | event trigger | card contents not sourced from this image |
| T-L4 | L4 | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | not legible — near fold crease |
| T-L5 | L5 | UNKNOWN | tax (probable — "THUẾ …" pattern visible) | — | — | false | — | pay fixed amount | tax tile | exact label/amount UNKNOWN |
| T-L6 | L6 | UNKNOWN (tentative: "LÊ LỢI") | property | UNKNOWN | UNKNOWN (tentative: $60) | true | UNKNOWN | none | standard property | verify name/price |
| T-L7 | L7 | — | fortune (KHÍ VẬN) | — | — | false | — | draw card | event trigger | card contents not sourced from this image |
| T-JAIL | Corner | Ở TÙ / THĂM TÙ | jail | — | — | false | — | in-jail state or pass-through | jail corner | exact line-order of the two-line label UNKNOWN |
| T-T1..T-T7 | Top edge, 7 tiles | UNKNOWN (tentative fragments only: "…ĐIỆN LỰC" suggesting a utility-type tile is somewhere on this edge; other names not confidently legible — upside-down text at this photo's resolution) | UNKNOWN (at least one likely `utility`, rest likely `property`) | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | this edge is upside-down relative to the camera and hardest to read — recommend a re-photograph rotated 180° |
| T-PARK | Corner | BÃI ĐẬU XE MIỄN PHÍ | free_parking | — | — | false | — | UNKNOWN whether coins accumulate here (classic rule: no) | rest/neutral corner | see Game Design Spec §14 open item on tax-jackpot variant |
| T-R1..T-R7 | Right edge, 7 tiles | UNKNOWN (tentative fragments only: text patterns consistent with several property-style tiles and one "BẾN XE …" transport tile and one "CÔNG TY …" utility tile somewhere on this edge; exact names/prices/positions not confidently legible) | UNKNOWN mix of `property` / `transport` / `utility` | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | rotated text, same limitation as top edge |
| T-JAILGO | Corner | VÀO TÙ | go_to_jail | — | — | false | — | send to jail corner | penalty corner | none |
| T-B1 | B1 | UNKNOWN (tentative: "TÂN KỲ TÂN QUÝ") | property | UNKNOWN | UNKNOWN (tentative: $400) | true | UNKNOWN | none | standard property | verify — this is the highest tentative-confidence edge tile, still not certain |
| T-B2 | B2 | UNKNOWN (tentative: "THUẾ ĐẶC BIỆT") | tax | — | UNKNOWN (tentative: pay $100) | false | — | pay fixed amount | tax tile | verify exact label/amount |
| T-B3 | B3 | UNKNOWN (tentative: "LŨY BÁN BÍCH") | property | UNKNOWN | UNKNOWN (tentative: $350) | true | UNKNOWN | none | standard property | verify name/price |
| T-B4 | B4 | — | chance (CƠ HỘI) | — | — | false | — | draw card | event trigger | card contents not sourced from this image |
| T-B5 | B5 | UNKNOWN (tentative: "BẾN XE QUANG TRUNG") | transport | — | UNKNOWN (tentative: $200) | true | UNKNOWN | rent scales with # transport tiles owned (classic pattern) | transport tile | verify name/price; confirm rent formula applies here at all |
| T-B6 | B6 | — | fortune (KHÍ VẬN) | — | — | false | — | draw card | event trigger | card contents not sourced from this image |
| T-B7 | B7 | UNKNOWN | property | UNKNOWN | UNKNOWN | true | UNKNOWN | none | standard property | not legible — nearest tile to VÀO TÙ corner, most foreshortened by the photo angle |

**Bottom line on data completeness**: of an estimated ~28 non-corner tiles, roughly 6–8 have a tentative (unconfirmed) name/price reading, and the rest are genuinely `UNKNOWN`. The 4 corners and the two deck types are the only fully-confirmed elements. This board photo is a reliable source for *structure* (corner functions, tile-type categories, overall loop shape) and an unreliable source for *content* (exact names, prices, precise tile count) at its current resolution/angle.

---

## Part 2 — Board Mechanics Proposal

Everything below is explicitly a **PROPOSED CONCEPT**, per your framing — not derived from the source board's actual rules (which weren't fully readable anyway — see Part 1), but designed to use this board's *structure* as a foundation for a distinct game. Each ties to a tile-type category that Part 1 actually confirmed exists, so the proposal is grounded even where exact tile content isn't.

### Flash Auction — **[CONFIRMED]**, V1 "Strategic Denial" — revised 2026-08-17

> **Superseded in part by "Flash Auction V2" below (2026-09-01).** V1 is kept as the historical record, the same convention Hostile Acquisition and Rent Risk Choice already use in this file. Read V2 for the trigger, the folding rule, and the current implementation status — the three points where V1 below no longer describes the shipped game.

Directly answers the open question left in `GAME_DESIGN_SPEC.md` §10 (whether declining a purchase triggers an auction), but is no longer framed as a discount hunt — it's a deliberate denial tool: a player pays a fee to force a property to auction, at full price, to keep it out of a rival's hands. **Supersedes the same-day earlier "V0" design** (50%-of-price opening bid, no fee, no reward for losing bidders) — that version is fully replaced, not layered alongside it. Core bidding engine implemented (`backend/src/engine/auction.js`, `IMPLEMENTATION_PLAN.md` P07-T04, 23/23 tests) — see `GAME_STATE_MACHINE.md` §3 for the full state-machine writeup and current wiring status.

- **Trigger**: current player declines to buy a landed-on property tile.
- **Auction fee — new in V1**: starting the auction costs the initiator a fee: `5%` of the property's base price, clamped to a minimum of `$20` and a maximum of `$80`, rounded up within that range (`Math.ceil(Math.max(20, Math.min(80, basePrice * 0.05)))`) — this is money paid to *start* the auction, separate from any bid placed once it's running.
- **Mechanic**: a short (**proposed 10–15s**; `GAME_STATE_MACHINE.md` §0 pins `FLASH_AUCTION_WINDOW_SECONDS` = 12), server-timed window opens to *all* players simultaneously — not just the current player, and not turn-ordered. Anyone can submit a bid at any point in the window; each new highest bid resets a short countdown (`FLASH_AUCTION_BID_RESET_SECONDS` = 3), so the auction only ends when bidding actually stops, not on a fixed clock alone.
- **Opening bid — changed in V1**: starts exactly at **100% of the property's base price**, not 50%. Superseded rule, struck: ~~`Math.floor(propertyPrice * 0.5)`~~. Every bid, including the opening one, must strictly exceed the current bid — so the first accepted bid must be *more* than full price.
- **Bidding semantics — unchanged from V0**: bids are **absolute amounts**, not increments (bidding `700` outright, never "+100"). A bid is only accepted if `amount > currentBid` and `sender.balance >= amount` at the moment it's received — re-validated server-side exactly like every other action in the Game Design Spec.
- **No money locking — unchanged from V0**: no funds are deducted while bidding is open, only balance-checked against the bid amount. Money moves exactly once, at resolution, from the winning bidder to the Bank.
- **Current-turn (declining) player can bid — unchanged from V0**: yes, they are eligible, entered as an active bidder from the start along with everyone else.
- **Folding — ~~unchanged from V0~~ REVISED 2026-09-02**: ~~the current high bidder may fold and still win if nobody outbids them~~. Folding now **withdraws the folder's bids**: the winner is recomputed from the surviving bid log, falling back to the best bid still standing or to `FAILED` if none remains. The old rule made `FOLD_AUCTION` meaningless for the one player it matters most to (a leader who folded still won *and* was charged), and it let `applyBankruptcy` — which folds an eliminated player out of a live auction — hand the property to a player it had just bankrupted. Folding still does **not** erase bid *history*, which the Near-Miss mechanic below depends on: eligibility is about who genuinely competed, and a player who bid then folded still did.
- **Failed auction — changed in V1**: if nobody ever places a winning bid, the auction resolves to a `FAILED` state — the property remains Bank-owned (unchanged), but **the initiator's fee is not refunded**: paying to start the auction and having it fail anyway is the downside risk of the denial play, by design.
- **Near-Miss reward — new in V1**: every losing bidder is checked for eligibility once the auction settles — **`>= 2` bids of their own, and their own highest bid `>= 90%` of the winning bid**. An eligible loser receives `2%` of the winning premium (`winningBid - basePrice`), rounded down (`Math.floor`), capped at `$50`; a reward that rounds down to `$0` is not paid out at all. A player who folded is still eligible if their bid history otherwise qualifies.
- **Server-authoritative shape**: server owns the timer and the current-high-bid; every bid is re-validated server-side, same as every other action in the Game Design Spec.
- **Implementation status — ~~not yet wired~~ FULLY SHIPPED.** This bullet was stale for a long time (corrected 2026-09-02): the `AWAITING_PURCHASE` → `FLASH_AUCTION_ACTIVE` transition, the fee-charging transaction, and settlement have all been wired into `turnMachine.js` since Phase 07, and the frontend has real buttons for it. The one genuinely outstanding item is the **two-phase timer**: `FLASH_AUCTION_WINDOW_SECONDS`/`FLASH_AUCTION_BID_RESET_SECONDS` are still not expressible by `TimerManager`, so `FLASH_AUCTION_ACTIVE` currently uses a single flat 15s window instead of "12s, extended 3s per new high bid" — a known, separately-flagged simplification, not an oversight.

### Flash Auction V2 — "Nhà Môi Giới" (Broker) — **[CONFIRMED]**, shipped 2026-09-01

Written 2026-09-02 to close a dangling citation: `backend/src/engine/auction.js`'s own header referenced `BOARD_SPECIFICATION.md §"Flash Auction V2"`, and that section did not exist. The code was the only description of these rules.

V2 replaces V1's single `DECLINE_PURCHASE` with a real **three-way decision** on landing at an unowned property, and gives the initiator an upside instead of pure denial:

- **`BUY_PROPERTY`** — pay base price, own it immediately. Unchanged.
- **`SKIP_PURCHASE`** — free. No fee, no auction; the tile stays unowned and may be bought by whoever lands there next.
- **`FORCE_AUCTION`** — pay `calculateAuctionFee` (unchanged from V1: 5% of base price, clamped `[$20, $80]`, rounded up) to open the live auction, **and in return earn a broker commission on settlement**.

**Broker commission — the new mechanic.** On a `SETTLED` auction the initiator receives 20% of the final winning bid, floored (`calculateBrokerCommission`). It is **funded by the Bank**, never carved out of the winner's payment: the winner pays their full bid to the Bank as normal, and the Bank separately pays the initiator — two real `applyTransaction` calls, so the closed-economy invariant (`ECONOMY_SPECIFICATION.md` §4) stays exact. A commission that floors to $0 (winning bid under $5) omits the intents entirely rather than emitting a zero transfer.

The initiator's net position is therefore `commission (20% × winningBid) − fee (5% of basePrice, clamped)`, **which can be negative** if the auction settles barely above base price. That is the intended risk: forcing an auction is a bet that the property will be contested, not a free tax on the table.

**Anti-abuse — "fee-free market research".** After *any* auction outcome, settled or failed, the turn always continues to `POST_ACTIONS`, never back to `AWAITING_PURCHASE`. The initiator cannot force an auction, watch it fail, and then simply buy the property themselves that turn. A `FAILED` auction still does not refund the fee — carried over from V1 unchanged.

**Timeout behaviour changed with V2, and it is a deliberate rule, not a side effect.** `buildDefaultAction` returns `DECLINE_PURCHASE`, which is now the legacy alias for the *free* skip — so an `AWAITING_PURCHASE` timeout costs an absent player nothing. Under V1 a timeout charged the fee and opened an auction on their behalf. The consequence worth knowing: an AFK player's land no longer reaches the market via auction; it simply stays unowned.

**Near-Miss reward is retained** from V1, unchanged, as a secondary incentive for active bidders who narrowly lost. The commission is the primary player-facing incentive; Near-Miss is not replaced by it.

Superseded from V1, struck rather than deleted: ~~the trigger is "current player declines to buy"~~ — declining is now two distinct actions with different costs.

### Rent Risk Choice — **[CONFIRMED]**, shipped 2026-08-21 — revised 2026-08-25

Adds a decision point for the property **owner**, not just the visitor — turns a fixed rent formula (Game Design Spec §11) into a moment of tension between two specific players.

**Superseded, not layered alongside** (same convention as Hostile Property Acquisition below): the original shipped design made the *payer's* liability depend on the owner's choice — pay the standard amount if the owner chose Standard, pay **double** if the owner gambled and won, pay **nothing** if the owner gambled and lost — and blocked the payer (and everyone else) on a `RENT_RISK_DECISION` phase until the owner decided. A real user report caught this as wrong, not a matter of taste: *"nếu quyết định chọn gambling thì người chọn hoặc được x2 hoặc không nhận được số tiền còn người vào đất chỉ mất x1 số tiền thôi chứ sao lại mất x2 và không cần chờ người khác quyết định chọn gì"* — the payer should only ever owe exactly the standard 1x rent, full stop, and should never have to wait on someone else's decision to find out what they owe. Struck through below is what shipped 2026-08-21 and no longer applies; kept as a record per this project's own convention of flagging divergences rather than silently deleting prior text.

- **Trigger**: another player lands on your owned property, whenever the tile has a real, non-Bank owner (unchanged).
- ~~`resolveLanding`'s `PAYING_RENT` case enters a new `RENT_RISK_DECISION` phase instead of settling immediately~~ — **now**: `PAYING_RENT` settles the standard rent **immediately and unconditionally**, exactly as it did before this mechanic ever existed — the payer's balance moves once, by exactly `rent`, the instant they land, full stop. `RENT_RISK_DECISION` no longer exists as a phase; nothing blocks on this at all.
- ~~Owner chooses, via `RENT_RISK_CHOICE` (payload `{ choice: 'STANDARD' | 'GAMBLE' }`), between Standard (guaranteed) or Gamble (payer pays 2x or 0x) *before* the payer's liability is known~~ — **now**: once the standard rent has already landed in the owner's balance (paid in cash, not deferred to `LIQUIDATION_REQUIRED`), `GameState.pendingRentGamble` (`{ propertyId, ownerId, payerId, amount }`) opens an entirely optional, non-blocking side bet — the owner may send `GAMBLE_RENT` (empty payload, same shape as `FOLD_AUCTION`) at any point afterward to risk the `amount` they already collected on a 50/50 double, funded by the **Bank** (a real `rent_gamble` transaction, Bank↔owner) rather than the payer. The payer is not a party to this at all — their `amount` was already fixed and already paid before this ever becomes possible. Declining costs nothing and isn't even a server action — the money is already the owner's.
- **Why fund the win from the Bank, not the payer**: the only real design fork once the payer's liability was fixed at 1x — confirmed with the user rather than assumed (two live options: Bank tops up the owner's win, or the payer's payment is diverted so they get a partial refund on a losing owner-gamble; the user picked the Bank-funded version, keeping the payer's experience completely deterministic either way).
- **Server-authoritative shape**: unchanged in spirit — the gamble's randomness (`action.payload.gambleRoll`) is still generated server-side only (`socketServer.js`'s `serverGeneratedFields`, the same treatment `ROLL_DICE`/`MAKE_EVENT_CHOICE`'s `probabilityRoll` already got, finding #27), a client-claimed value is always discarded. `GAMBLE_RENT` is now both turn-independent *and* phase-independent (`TURN_INDEPENDENT_ACTION_TYPES`, and dispatched via an early-return in `transitionTurn` before the `VALID_ACTIONS_BY_PHASE` gate, the same precedent `FORFEIT_MATCH` established) — the owner can respond whenever, regardless of whose turn it is or what phase the match is in.
- ~~**Timer**: 15 seconds, defaulting to Standard on timeout~~ — **now**: no timer at all (removed from `timers.js`). Nothing is blocked on this decision any more, so there is nothing to time out — it can sit unresolved indefinitely (until the owner acts, goes bankrupt, or the match ends) with zero cost to anyone else.
- **Which properties**: unchanged — every ownable tile (property/transport/utility uniformly), not narrowed to transport/utility.
- **Frontend**: built and live-verified 2026-08-25 (`RentRiskChoice.jsx`/`.module.css`) — a small non-blocking corner drawer shown **only to the owner** (nobody else, not even the payer, has anything to decide or wait on), matching `PropertyActionDrawer.jsx`'s single-actor architecture rather than the original's whole-room `FlashAuction`-style modal.

### Hostile Property Acquisition — **[CONFIRMED]**, shipped Phase 14 (2026-08-19) — revises the proposal below

**Superseded, not layered alongside**: the brief that actually shipped this dropped both the turn-threshold gate and the owner defense-fee/response-window this section originally proposed, in favor of a simpler, fully unilateral action. Struck-through below is what was proposed and *not* adopted; kept as a record of what was considered, per this project's own convention of flagging divergences rather than silently deleting prior proposals.

- ~~**Trigger**: proposed to unlock only after a turn threshold~~ — **shipped**: available every turn, to any player, the instant they finish paying rent on another player's property (`GameState.pendingHostileBuyoutPropertyId` is set right after a `PAYING_RENT` resolution and cleared unconditionally at the next turn advance — a same-turn-only window, not a standing threshold-gated ability). No Late-Game Escalation dependency.
- ~~**Mechanic**: ≥150% of price... owner has a short window to counter with a defense fee~~ — **shipped**: cost is a strict `2.0×` of the property's current value (`tile.price + property.upgradeLevel × tile.houseCost`) — buildings count at full replacement cost, not sellback value, since the buyer is compensating the owner for a going concern, not liquidating it. Fully unilateral: no counter-offer, no defense fee, no response window. The buyer pays, ownership transfers, done — same one-sided shape as `MORTGAGE`/`UNMORTGAGE`, not the two-sided `propose_trade`/`respond_trade` handshake this section originally sketched.
- **Precondition**: rejected outright (`MONOPOLY_PROTECTED`) if the target belongs to a color group the current owner fully monopolizes — a completed monopoly can't be forcibly broken up this way. No cooldown, no mortgaged-property exemption — mortgage status doesn't affect eligibility (an intentional simplification, not an oversight: the buyer would still need to separately `UNMORTGAGE` after taking ownership if they want to build).
- **Server-authoritative shape**: `HOSTILE_BUYOUT` action, valid only in `POST_ACTIONS` with a non-null `pendingHostileBuyoutPropertyId`. Payment is a direct player-to-player `applyTransaction` (buyer → owner, type `hostile_acquisition`) — the Bank is not involved, same as Trade. See `WEBSOCKET_API.md` §1 for the wire contract and `GAME_STATE_MACHINE.md`/`turnMachine.js`'s `handleHostileBuyout` for the implementation.
- **Why the simpler shape**: the two-sided handshake this section originally proposed adds a whole mini-protocol (response timer, default-on-silence, a `[PROPOSED]`-only counter-fee amount) for a mechanic whose entire point is to punish an owner who's already vulnerable (just paid rent, i.e. already on someone else's tile). A same-turn, rent-triggered, unilateral window keeps that pressure without needing new timer infrastructure — implemented per an explicit, detailed brief that superseded this older sketch; not a unilateral simplification made without instruction.

### Comeback Mechanics — *proposed*

A deliberate counter-force against early snowballing, aimed at keeping mid-game players engaged rather than watching a leader's advantage compound uninterrupted.

- **Mechanic (candidate 1)**: scaling Pass-GO salary — a player whose balance is below some fraction of the current leader's net worth (**proposed** <50%) collects a boosted salary (**proposed** 1.5×) on their next GO pass.
- **Mechanic (candidate 2)**: a one-time "bailout" — the first time a player would go bankrupt, they instead survive with a small emergency balance and lose their weakest property to the bank, once per match.
- **Open questions**: which candidate (or both); risk of over-correcting and making the early game not matter — this needs actual playtesting more than it needs a spec decision right now, so treat any specific multiplier here as a starting point for tuning, not a target.

### Late-Game Escalation — *proposed*

Addresses the same problem `GAME_DESIGN_SPEC.md` §1/§17 flagged as an open win-condition question — a pure elimination objective can run long — without necessarily changing the win condition itself.

- **Mechanic**: past a turn threshold (**proposed** turn 20), a small set of effects phase in: ~~Hostile Acquisition (above) becomes available~~ (superseded — Hostile Acquisition shipped Phase 14 as always-available, no turn gate; this bullet's other two effects are unaffected and remain open), tax tile amounts scale up (**proposed** +10% per 5 turns past the threshold), and event-card effects skew toward larger swings.
- **Open questions**: exact threshold and scaling curve; whether this stacks with or replaces a hard turn-limit win condition — the win-condition side of this is resolved (`GAME_DESIGN_SPEC.md` §17's hybrid elimination/net-worth model, implemented in the Win Condition task), the escalation curve itself is still undesigned.

### Special Event Spaces — *proposed*

Distinct from the existing `CƠ HỘI`/`KHÍ VẬN` tiles (Part 1 — confirmed to exist on the physical board) — this proposes effects that hit the *whole table* at once, not just the player who landed.

- **Mechanic**: a subset of `CƠ HỘI`/`KHÍ VẬN` draws (**proposed** ~10–15% of each deck) are "Global Events" instead of personal ones — e.g. "Market Crash: all rent halved for the next 2 full rotations" or "Boom: all property prices +25% until someone next buys." Broadcast to every player immediately, visibly, not just logged for the drawer.
- **Server-authoritative shape**: same card-draw path as §13 of the Game Design Spec — the deck lives server-side, drawn card is server-selected, effect is server-applied to shared state, not client-computed.
- **Open questions**: exact event list and their numeric effects — genuinely new content, not sourced from the physical board's actual (mostly unread) card text.

### Why these serve "fast-paced multiplayer interactions"

The throughline across all six: **Flash Auction forces other players to act during someone else's turn**, and **Special Events change what everyone's holding at once** — the common failure mode in a straight port of classic Monopoly rules is that only the current-turn player is ever doing anything while five others watch a timer. Each proposed mechanic above was chosen specifically because it creates a moment where more than one player is actively deciding something, not because it's a bigger number or a flashier name. (Rent Risk Choice originally belonged in that first group too — its 2026-08-25 revision above deliberately removed that property: forcing the *payer* to wait on someone else's decision was exactly the part a real user report identified as wrong, not a feature worth preserving.)

---

## Open items requiring your decision

1. Higher-resolution or edge-by-edge photos, if full tile-level accuracy matters before implementation — Part 1's `UNKNOWN` cells are a resolution/angle limitation, not a design gap.
2. Property visual grouping (§15) — confirm whether this board even has color-coded groups, since none were visible here; if it doesn't, `GAME_DESIGN_SPEC.md`'s group-based monopoly-bonus rent (§11) needs a different trigger or needs to be dropped for this board.
3. Movement direction (§16) — quick physical check of the arrow icon.
4. Which comeback mechanic (or both), and roughly how aggressive the correction should be.
5. ~~Hostile Acquisition's silence-default~~ — **moot, resolved Phase 14**: the shipped mechanic has no response window at all (fully unilateral, no owner reply step), so there's no silence case to default.
6. Late-game escalation's relationship to the still-open win-condition choice from the Game Design Spec.
7. Special Event content — actual event list/effects need to be written, not inferred from the mostly-unread card tiles on this board.

Nothing in Part 2 has been implemented, and no database migration was created — this is proposal only, as requested.
