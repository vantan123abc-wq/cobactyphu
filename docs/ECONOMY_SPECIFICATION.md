# CoBacTyPhu — Economy Specification

Design only — no source code, no database schema, no new Socket.IO events. Source of truth for money; `GAME_DESIGN_SPEC.md`, `BOARD_SPECIFICATION.md`, and `GAME_STATE_MACHINE.md` are the only gameplay inputs used. Same tagging convention: **[CONFIRMED]**, **[PROPOSED]**, **[OPEN DESIGN DECISION]**. Every numeric value here is **BALANCE TBD** unless stated otherwise — see §8.

## The one decision everything else depends on

**[PROPOSED — supersedes `GAME_DESIGN_SPEC.md` §20]** "No arbitrary coin generation" and a real before/after invariant are only possible if the Bank is a **finite, tracked ledger participant**, not the "unlimited money source/sink" §20 originally described. An infinite bank can't be conserved against — conservation requires every party in the system to have a real, bounded number. So:

- The Bank has a starting balance (`BANK_RESERVE_INITIAL`, §8), exactly like a player.
- The Bank's balance is **allowed to go negative**, and that's not an error — it has no bankruptcy consequence of its own (only players go bankrupt, `GAME_DESIGN_SPEC.md` §16, unchanged). This is what avoids inventing a new "the bank is broke, salary can't be paid" special case: nothing here changes because of it.
- The Bank's balance is **not new stored state** — it's derived from existing ledger entries (`GAME_DESIGN_SPEC.md` §21) where `counterpartyId = BANK`: `bankBalance = BANK_RESERVE_INITIAL − Σ(entries where the bank is debited) + Σ(entries where the bank is credited)`. No schema change, per your instruction — this is a computed view over data that already exists.

This one change is what makes §4's invariant exact rather than aspirational.

---

## 1. Starting Economy

| Concept | Definition | Status |
|---|---|---|
| Starting balance | Each player begins with `STARTING_BALANCE` (`GAME_DESIGN_SPEC.md` §0) | **[CONFIRMED]** concept, value **BALANCE TBD** |
| Bank / reserve | Finite ledger participant, starts at `BANK_RESERVE_INITIAL`, can go negative, no bankruptcy of its own | **[PROPOSED]** — see above |
| Match pool | `MATCH_POOL = BANK_RESERVE_INITIAL` — the Bank starts the match holding the entire pool; instantiated once, at `STARTING` (`GAME_STATE_MACHINE.md` §1), and constant for the rest of the match | **[PROPOSED]** — new concept, defines the invariant's fixed total |
| Player balance | A player's current cash — the same field already defined in `GAME_DESIGN_SPEC.md` §2 (`GameState.players[].balance`) | **[CONFIRMED]**, restated here as one term of the pool |

The very first ledger entries of a match (crediting each player `STARTING_BALANCE`, type `initial_balance`, `GAME_DESIGN_SPEC.md` §4 `start_game`) are simply the **first set of transfers out of `BANK_RESERVE_INITIAL`** — the Bank's balance drops from `BANK_RESERVE_INITIAL` to `BANK_RESERVE_INITIAL − (playerCount × STARTING_BALANCE)` the instant dealing completes. No coins are created at this step; they were already sitting in the Bank's opening balance. This is also why `BANK_RESERVE_INITIAL` has to comfortably exceed `playerCount × STARTING_BALANCE` — it needs enough to deal from *and* have something left over as an actual operating reserve (§8).

## 2. Property Economy

Mostly cross-references — this document doesn't re-derive values already covered, it confirms how they behave under the invariant.

| Concept | Behavior | Status |
|---|---|---|
| Purchase price | Player → Bank, per `GAME_DESIGN_SPEC.md` §10 | **[CONFIRMED]** mechanic, price per property **BALANCE TBD** (`BOARD_SPECIFICATION.md` — content not yet sourced) |
| Base rent | Owner ← Visitor, per §11 | **[CONFIRMED]** mechanic, amounts **BALANCE TBD** |
| Property groups | Same open item as `BOARD_SPECIFICATION.md` §15 — visual grouping wasn't confirmed from the reference photo | **[OPEN]**, unchanged — this doc doesn't resolve it |
| Monopoly/group bonus | **[CONFIRMED, REVISED 2026-09-02]** Rent doubles when the owner holds every property in the group and none are mortgaged — now at **every development level**, not only before houses are built. The classic unimproved-only rule was inherited from a game where building is gated behind owning the group; this project removed that gate on 2026-08-25, which left the bonus and building mutually exclusive and the bonus worth almost nothing. Measured over 250 matches before the change: building one house per lot out-earned the unimproved bonus by 2.2-2.6x in every group, and only **0.3%** of all rent paid was attributable to the bonus. After: **~10.2%**. A monopoly now multiplies a developed group instead of competing with developing it | **[CONFIRMED]** |
| Upgrade cost | Player → Bank, `houseCost`, per §12 | **[CONFIRMED]** mechanic, amounts **BALANCE TBD** |
| Upgrade limits | Even-build rule + optional `HOUSE_SUPPLY_TOTAL`/`HOTEL_SUPPLY_TOTAL` scarcity — §12's own open item (enforce scarcity or not) is unchanged by this document | **[OPEN]**, unchanged |
| Sale behavior | Two distinct paths, not one: (a) **mortgage** — Bank → Player, `mortgageValue`, the only bank-directed sale (§12); (b) **player-to-player sale** is not a separate mechanic — it's a specific case of Trade (an offer of "property for coins"), not a new one. Clarifying this now since "property sale" was asked about directly and wasn't previously disambiguated from mortgage vs. trade | **[PROPOSED]** clarification |

## 3. Money Flows

Every source and sink currently defined by the approved documents. All of `BOARD_SPECIFICATION.md` Part 2's originally-`[if adopted]` mechanics are now shipped: Hostile Acquisition (row 17) and the Free Parking jackpot (row 22) as of Phase 14 (2026-08-19), Rent Risk Choice (rows 18-19) as of 2026-08-21 — none still carry that tag. Flash Auction (row 16) still does, since its wiring status wasn't reconfirmed in this pass. Rows 18-19 were revised 2026-08-25 (`BOARD_SPECIFICATION.md`'s own Rent Risk Choice section has the full "why") — the gamble is now Bank-funded, not payer-funded; row 3 (ordinary rent) already covers the payer's now-unconditional, always-exactly-1x liability, so it isn't touched by this revision at all.

| # | Event | Source | Amount | Destination | Reason |
|---|---|---|---|---|---|
| 1 | Match start | Bank | `STARTING_BALANCE` × each player | Each player | `initial_balance` |
| 2 | Property purchase | Player | `price` | Bank | `purchase` |
| 3 | Rent | Visiting player | computed (base or group/upgrade table) | Owning player | `rent` — **never touches the Bank** |
| 4 | Pass GO | Bank | `PASS_GO_SALARY` | Player | `pass_go_salary` |
| 5 | Tax tile | Player | fixed per tile | Bank | `tax` |
| 6 | Event card — pay | Player | per card | Bank | `event_card` |
| 7 | Event card — receive | Bank | per card | Player | `event_card` |
| 8 | Event card — pay each player | Player | n × (playerCount − 1) | Every other player, n each | `event_card` — player-to-player, **no Bank involvement** |
| 9 | Event card — receive from each | Every other player, n each | n × (playerCount − 1) | Player | `event_card` — player-to-player |
| 10 | Jail fine | Player | `JAIL_FINE` | Bank | `jail_fine` |
| 11 | Build house/hotel | Player | `houseCost` | Bank | `build` |
| 12 | Sell house/hotel | Bank | `houseCost × HOUSE_SELLBACK_RATIO` | Player | `sell_house` — new parameter, §8 |
| 13 | Mortgage | Bank | `mortgageValue` | Player | `mortgage` |
| 14 | Unmortgage | Player | `mortgageValue × 1.1` | Bank | `unmortgage` |
| 15 | Trade (incl. property-for-coins) | Player | negotiated | Player | `trade` — player-to-player |
| 16 | Flash Auction `[if adopted]` | Winning bidder | winning bid | Bank | `flash_auction` — same direction as an ordinary purchase, price discovered differently |
| 17 | Hostile Acquisition — **[CONFIRMED, shipped Phase 14]** | Acquiring player | `HOSTILE_BUYOUT_MULTIPLIER (2.0) × (price + upgradeLevel × houseCost)` | Dispossessed (target) player | `hostile_acquisition` — **player-to-player**, not the Bank, since it's a forced purchase *from* another player |
| 18 | Rent Risk Choice, win — **[CONFIRMED, revised 2026-08-25]** | Bank | `amount` (the rent already collected via row 3) | Owning player | `rent_gamble` — the owner's total take for this rent event becomes `2 × rent` (`rent` from row 3 plus this row), the payer is not a party to it |
| 19 | Rent Risk Choice, lose — **[CONFIRMED, revised 2026-08-25]** | Owning player | `amount` (the rent already collected via row 3) | Bank | `rent_gamble` — nets the owner back to `0` for this rent event (row 3's `rent` in, this row's `rent` back out), the payer is not a party to it and keeps the standard 1× liability from row 3 regardless of this outcome |
| 20 | Bankruptcy settlement | Bankrupt player's remaining cash + liquidated assets | up to the owed debt | Creditor (player or Bank, whichever was owed) | `bankruptcy_transfer` |
| 21 | Final settlement | — | 0 | — | no coin movement — see §6 |
| 22 | Free Parking jackpot payout — **[CONFIRMED, shipped Phase 14]** | Bank | `GameState.freeParkingJackpot` (accumulated) | Landing player | `free_parking_jackpot` — the payout leg only; the feeding tax/jail-fine payments stay typed `tax`/`jail_fine`, unchanged (see §4) |

## 4. Closed Economy Invariant

**Formal statement**: at every point after `MATCH_POOL` is instantiated,

```
Σ(player.balance for all players) + bank.balance  =  MATCH_POOL
```

This must hold **before and after every single transaction** in §3, not just at match boundaries. Each row in §3 is either a direct two-party transfer (conserves trivially) or a fan-out of several two-party transfers (rows 8–9 — each individual leg conserves, so the sum does too).

**Legitimate exceptions: none identified.** Every flow in §3 is a transfer between existing ledger participants — nothing in the currently-defined ruleset creates or destroys a coin. This is a direct consequence of making the Bank finite (the section above) — under the old "infinite bank" model from `GAME_DESIGN_SPEC.md` §20, rows 1, 4, 7, 9, and 12 would all have been genuine exceptions (money appearing from an unbounded source); reconceiving the Bank as finite turns every one of them into an ordinary transfer instead. If a future mechanic needs to violate this (e.g., a "jackpot" that isn't funded by anyone), it would need to be funded by a real source — most naturally, by an accumulating pool of Tax/Fine payments the Bank already collected, still zero-sum, rather than a true exception.

**[CONFIRMED, shipped Phase 14 (2026-08-19)]** `GAME_DESIGN_SPEC.md` §14's Free Parking jackpot variant was adopted, and built exactly this way — the guidance above turned out to be the right call, not just a hedge. `GameState.freeParkingJackpot` is a running counter, incremented by the amount of every `tax`/`jail_fine` payment (still charged to the Bank exactly as before, unchanged `applyTransaction` call — the counter update is a second bookkeeping step alongside it, not a redirection). Landing on Free Parking pays the full accumulated counter to the landing player via its own real `applyTransaction` (Bank → player, §3 row 22) and resets the counter to 0. The invariant holds throughout: every coin in the jackpot was already debited from a real player via a real, already-conserving transaction; the payout is just a second real transaction crediting it onward, same as the "no true exception" reasoning above predicted. Rent does not feed the jackpot (already a real player-to-player transfer with its own destination).

## 5. Bankruptcy

Restates `GAME_DESIGN_SPEC.md` §16 through the money lens specifically:

- **Occurs when**: cash on hand + full liquidation value (mortgage value of unmortgaged properties + house/hotel sell-back value) is less than the amount owed.
- **Properties**: transfer to whoever was owed the debt — the creditor player if it was a player-to-player debt (rent, hostile acquisition), or back to the Bank (unowned, purchasable again) if it was a Bank debt (tax, jail fine, unmortgage).
- **Outstanding (partial) rent**: **[PROPOSED]**, not previously stated explicitly — if liquidation still leaves a shortfall, the creditor receives everything the bankrupt player had (cash + liquidated value), **not** the full sticker rent amount. The shortfall is simply written off — there is no third party to make up the difference, and this doesn't violate §4's invariant, because the amount debited from the bankrupt player and the amount credited to the creditor are the same (smaller) number; the "debt" figure was never itself a stored quantity of coins, only a comparison threshold.
- **Pending transactions**: none can exist in a race sense (`GAME_STATE_MACHINE.md` §5's synchronous per-room mutation), but explicitly: while a player's bankruptcy is resolving (`LIQUIDATION_REQUIRED`/`LIQUIDATING`), no other transaction can be initiated by or against that player — those states are exclusive for them until resolved.
- **Remaining balance**: set to exactly 0 after settlement — every coin they had moved to the creditor/Bank as part of discharging the debt; nothing carries forward, no negative balance persists.

## 6. End of Match

- **Winner**: per `GAME_DESIGN_SPEC.md` §17 — last solvent player, or (if the still-open alternative is chosen instead) highest net worth at a turn/time limit.
- **Final balances**: frozen as-is, recorded into `game_results.standings` (§22).
- **Property handling**: ownership stops mattering the instant the match ends — no further rent/upgrades are possible. If the net-worth win condition is adopted, a valuation formula is needed for ranking: **[PROPOSED]** `netWorth = cash + Σ(property.price for owned, unmortgaged) + Σ(property.mortgageValue for owned, mortgaged) + Σ(houseCost × upgradeLevel)`. Not needed at all under the elimination win condition, since ranking there is by bankruptcy order (already defined), not net worth.
- **Match result / settlement**: no coin movement (§3 row 21) — the match simply stops advancing, and a result is recorded. **Sanity check worth stating explicitly**: the invariant from §4 still holds at the exact instant the match ends — `Σ(balances) + bank.balance` is still `MATCH_POOL`, unchanged from the first transaction to the last. Nothing about ending the match is itself a transaction.

## 7. Economy Abuse Cases

| Case | Risk to the invariant | Mitigation |
|---|---|---|
| Negative balance | A **player** balance must never go negative — the asymmetry with the Bank (§0) is deliberate: any transaction that would take a player negative redirects to bankruptcy (§5) instead of completing as a normal debit (`GAME_DESIGN_SPEC.md` §21, unchanged). A negative *player* balance surviving past a transaction would be a critical bug, not a designed state | Solvency check before every debit, no exceptions |
| Duplicate transaction | Double-applying the same debit+credit pair would move the same coins twice, breaking §4 | `clientActionId` dedup, `GAME_STATE_MACHINE.md` §6 |
| Race condition | Two concurrent debits against the same balance, each validated against a stale pre-debit figure, could jointly overdraft | Synchronous per-room mutation, `GAME_STATE_MACHINE.md` §5 — the second action is always validated against the first one's already-applied result |
| Client-side balance manipulation | A modified client claiming a different balance than the server's | Client never has write access to any balance; every amount in §3 is server-computed, never accepted from a client payload (`GAME_DESIGN_SPEC.md` §27) |
| Overflow | Virtual-coin totals stay far inside safe integer range for any realistic match; the real exposure is a malicious client submitting an absurd bid/offer (Flash Auction, trade, Hostile Acquisition) | **[PROPOSED]** reject any single transaction amount exceeding a sanity ceiling — e.g., a bid/offer larger than the entire current `MATCH_POOL` is definitionally impossible to honor and should be rejected before it reaches any balance math |
| Stale transaction | Acting on out-of-date target state (e.g., bidding on an auction that already settled) | `stateVersion` staleness check, `GAME_STATE_MACHINE.md` §6 |
| Disconnected player during transaction | None — by design, a "transaction" here is an instant, atomic, server-computed ledger write with no client round-trip in the middle (`GAME_STATE_MACHINE.md` §5); there's no window in which a disconnect could land mid-transaction |

## 8. Balance Model

All **BALANCE TBD** — nothing below is final. Extends `GAME_DESIGN_SPEC.md` §0.

| Name | Proposed value/range | Status |
|---|---|---|
| `STARTING_BALANCE` | 1500 | BALANCE TBD (unchanged from `GAME_DESIGN_SPEC.md` §0) |
| `BANK_RESERVE_INITIAL` | proposed starting point: 20,000, flat regardless of player count — must exceed `playerCount × STARTING_BALANCE` (the initial deal) with room to spare as an operating reserve | BALANCE TBD — its exact size matters less than it might seem, since the Bank is allowed to go negative (§0); it mainly sets the nominal `MATCH_POOL` total used for the overflow sanity ceiling (§7) |
| `HOUSE_SELLBACK_RATIO` | 0.5 (classic half-price) | BALANCE TBD |
| `PASS_GO_SALARY`, `JAIL_FINE`, `MAX_JAIL_TURNS`, mortgage interest (1.1×) | see `GAME_DESIGN_SPEC.md` §0 | BALANCE TBD, unchanged |
| Overflow sanity ceiling | proposed: reject any single transaction amount `> MATCH_POOL` (current, live value — this shrinks/grows as coins move, but never exceeds the fixed total) | BALANCE TBD (as a rule; the ceiling itself is always derived, never a fixed number) |

## 9. Economy Audit Table

Worked examples using the placeholder values from §8, purely to demonstrate the invariant holds — not proposed as real match data. 4-player match, `MATCH_POOL = BANK_RESERVE_INITIAL = 20,000`. "Coins before/after" is always the global total (`Σ players + bank`) — it never moves; what moves is how that fixed total is distributed between the Bank and the players, shown in the Source/Destination/Amount columns instead.

| # | Event | Coins before | Coins after | Source | Amount | Destination | Zero-sum? |
|---|---|---|---|---|---|---|---|
| 1 | Match start — deal `1500` × 4 | 20,000 | 20,000 | Bank (20,000 → 14,000) | 1500 each | 4 players (0 → 1500 each) | ✅ |
| 2 | Player buys property | 20,000 | 20,000 | Player | 220 | Bank | ✅ |
| 3 | Rent paid | 20,000 | 20,000 | Visiting player | 40 | Owning player | ✅ |
| 4 | Passes GO | 20,000 | 20,000 | Bank | 200 | Player | ✅ |
| 5 | Pays tax | 20,000 | 20,000 | Player | 100 | Bank | ✅ |
| 6 | Mortgages property | 20,000 | 20,000 | Bank | 110 | Player | ✅ |
| 7 | Bankruptcy — owes 300, has only 150 | 20,000 | 20,000 | Bankrupt player | 150 (not 300) | Creditor | ✅ — shortfall written off, not a violation (§5); the *same* 150 leaves one side and lands on the other |
| 8 | Match ends | 20,000 | 20,000 | — | 0 | — | ✅ — no transaction occurs |

Row 1 is the one genuinely special case worth double-checking by hand: Bank goes from 20,000 to 14,000 (−6,000), the four players collectively go from 0 to 6,000 (+6,000). Total stays at 20,000 throughout — including at the exact midpoint of dealing to the 2nd or 3rd player, if you check it player-by-player instead of all at once.

---

## Decisions requiring your approval

1. **The core reframing itself** — Bank as finite/negative-capable rather than infinite. Everything else in this document depends on it; if you want the Bank to stay conceptually infinite (matching classic Monopoly), the invariant in §4 can't be exact and this document would need a different foundation.
2. `BANK_RESERVE_INITIAL` and the overflow sanity ceiling derived from it (§8).
3. `HOUSE_SELLBACK_RATIO` (0.5 proposed).
4. Bankruptcy shortfall handling (§5) — creditor gets "whatever's left," not the full owed amount. Confirming this as the default rather than, say, the Bank covering the gap (which would break the closed economy the moment it happened).
5. Net-worth valuation formula (§6) — only relevant if the alternative win condition from `GAME_DESIGN_SPEC.md` §17 is ever chosen; otherwise moot.
