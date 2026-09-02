# CoBacTyPhu — Adaptive Board Design

Proposal only — nothing in this document has been implemented, and no board config or migration has been written. Builds on the confirmed structural findings in `BOARD_SPECIFICATION.md` (4 corners, the `CƠ HỘI`/`KHÍ VẬN` deck pair, and the tile-type taxonomy) and supersedes the single-board assumption in `GAME_DESIGN_SPEC.md` §7.

**Status: all five open items from the previous version of this document are now decided.** See the decisions log at the end for exactly what was approved. What follows is the updated design reflecting those decisions — no more open tile-count or selection-logic questions remain in this document.

---

## Why not just scale the Small Board

Stretching the same tile layout to fill more screen space for 6 players would change nothing structurally — same odds of landing on any tile type, same number of properties to compete over, same pacing. The actual problems a bigger player count creates are: more players contesting the same fixed set of properties (scarcity goes up, not down, if tile count doesn't grow with player count), and more players waiting through each others' turns before the loop comes back around. A visual scale fixes neither — only a genuinely longer loop with deliberately different category proportions does. That's the basis for treating Small and Large as two separately-authored configurations rather than one board at two zoom levels.

## Shared tile system (identical on both boards)

- Tile schema — the `Property`/`Tile` field shapes from `GAME_DESIGN_SPEC.md` §7–§9 (`tileIndex`, `type`, `groupId`, `price`, `rentTable`, etc.)
- Tile-type taxonomy — `property | transport | utility | chance (CƠ HỘI) | fortune (KHÍ VẬN) | tax | jail | free_parking | go_to_jail | go`
- Corner functions and their relative positions (GO, Jail/Visiting, Free Parking, Go-to-Jail), per `BOARD_SPECIFICATION.md`
- Visual identity — art style, mascot, the `CƠ HỘI` (red)/`KHÍ VẬN` (yellow) deck names and colors
- All gameplay rules from `GAME_DESIGN_SPEC.md` — rent formulas, upgrade rules, jail rules, bankruptcy — apply identically regardless of which board is active. Board size changes *layout and content*, never *rules*.

What's independently authored per board: tile count, per-category composition, and the actual sequence of tiles around the loop.

## Small Board (2–4 players) — **CONFIRMED**

**36 tiles**: 4 corners + 8 tiles per edge (symmetric). Locked — not to be increased for the initial version.

| Category | Count | Share of edge tiles |
|---|---|---|
| Corners | 4 | — |
| Property | 22 | 68.8% — dominant, as directed |
| Chance (`CƠ HỘI`) | 2 | 6.25% |
| Fortune (`KHÍ VẬN`) | 2 | 6.25% |
| Tax | 2 | 6.25% — limited |
| Transport | 2 | 6.25% — limited |
| Utility | 2 | 6.25% — classic constant pair |
| **Total** | **36** | 4 + 32 edge tiles, 8/edge |

## Large Board (5–6 players) — **CONFIRMED**

**44 tiles**: 4 corners + 10 tiles per edge (symmetric). Locked at 44 — the Rest Stop tile idea is **not** adopted for the MVP, so this composition stands as final for now, not a placeholder pending a 4-tile deduction.

| Category | Small (36) | Large (44) | Δ | Reasoning |
|---|---|---|---|---|
| Corners | 4 | 4 | 0 | structural, fixed regardless of size |
| Property | 22 | 28 | +6 | dominant category on both boards; absorbs all of Large's extra room so more players have more to compete over |
| Chance (`CƠ HỘI`) | 2 | 2 | 0 | held flat — same count over a longer loop means more distance between individual event tiles |
| Fortune (`KHÍ VẬN`) | 2 | 2 | 0 | same reasoning as Chance |
| Tax | 2 | 3 | +1 | stays limited, as directed — a token increase, not a scaled one |
| Transport | 2 | 3 | +1 | same treatment as Tax |
| Utility | 2 | 2 | 0 | classic constant pair, not a scaling category |
| **Total** | **36** | **44** | +8 | 4 + 40 edge tiles, 10/edge |

**On "preserve existing ratios unless there's a strong reason to adjust":** no adjustment was needed. The category *deltas* proposed before this approval (+6 property, +0/+0 chance/fortune, +1/+1 tax/transport, +0 utility = +8 total) apply cleanly to the newly-locked 36/44 totals with no forcing — Property's share of edge tiles moves from 68.8% (Small) to 70% (Large), a slight increase consistent with "dominant," and Event/Tax/Transport all stay in the same limited/moderate band on both boards. Nothing here was adjusted for architectural convenience; the original reasoning simply carried over.

**Rest Stop tile**: rejected for the MVP per your decision. Not present in either composition above. If revisited post-MVP, it would need its own rebalanced table — not a simple addition on top of the 44 locked here.

## Board-size selection — **CONFIRMED**

Automatic, server-side, at `start_game` (`GAME_DESIGN_SPEC.md` §4), by final player count: 2–4 → Small (36 tiles), 5–6 → Large (44 tiles). No host override in the MVP — this is not a room setting; there is nothing for the lobby UI to expose here.

## Large Board rendering strategy — **CONFIRMED**

Resolves the tile-sizing question from the previous version. The direction: **the board doesn't shrink to fit the screen — the viewport moves over the board instead.**

- Tile dimensions stay readable and reasonably consistent between Small and Large — a Large-board tile is not allowed to become illegibly small purely to force all 44 tiles into one unzoomed view.
- The board renders inside its own pan/zoom viewport. On Large specifically, the full board will typically exceed a single unzoomed screen — that's expected, not a bug to design around by shrinking tiles.
- Gameplay-critical UI — balances, dice, turn/phase indicator, action controls (buy/build/trade/end-turn, etc.) — lives in a **fixed layout region outside the pan/zoom viewport**, so it's always visible and operable no matter how the board itself is panned or zoomed. The board viewport is for spatial context; it is never the only place a required control lives.
- This applies to both boards for consistency, even though Small is more likely to fit unzoomed most of the time — the same component structure (fixed HUD region + separate pan/zoom board viewport) serves both rather than branching the layout by board size.

---

## Decisions log

**2026-08-16 — all five open items from the initial Adaptive Board Design proposal, approved as follows:**

1. Tile counts locked at 36 (Small) / 44 (Large) — the top of each previously-proposed range, not the low end. Not to be increased for the initial version.
2. Category composition: existing proposed ratios preserved and re-based onto the new totals (see reasoning above) — Property dominant, Event/Special moderate, Transport and Tax/Penalty limited.
3. Board selection is strictly automatic by player count. No host override in the MVP.
4. Rest Stop tile: not adopted for the MVP. Large stays at 44 tiles as designed above.
5. Large board rendering: consistent, readable tile size — no forced shrink-to-fit. Pan/zoom viewport for the board; gameplay-critical UI stays outside that viewport, always accessible.

No open design decisions remain in this document. Remaining unknowns are content, not architecture — see `BOARD_SPECIFICATION.md`'s open items (exact property names/prices, tile sequencing) and `GAME_DESIGN_SPEC.md`'s own open items (win condition, cross-match wallet, etc.), which this document doesn't resolve.
