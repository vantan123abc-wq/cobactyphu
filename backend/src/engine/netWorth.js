// Net worth calculation — Win Condition design (2026-08-19). Pure
// function: no I/O, no database driver, no Express, no Socket.IO.
//
// Deliberately NOT the same valuation bankruptcy.js's checkSolvency() uses
// for land. That function asks "how much cash can this player raise RIGHT
// NOW, under duress" — an unmortgaged property's own contribution there is
// its bare mortgageValue (the only way to convert land to cash), which
// meaningfully undervalues a freely-held asset relative to what the player
// actually paid for it and legitimately still owns. Net worth asks a
// different question — "what is this player's total standing wealth" — so
// an unmortgaged property counts at its full price here: the player owns
// it outright, and mortgaging is a reversible loan against it, not a forced
// sale, so there's no reason to discount it the way a genuine liquidation
// would.
//
// This revises ECONOMY_SPECIFICATION.md §6's own [PROPOSED] sketch, which
// valued every mortgaged property at bare mortgageValue and every building
// at full houseCost. Two problems with that version, found by cross-
// checking it against the rest of the economy rather than accepting it:
// full houseCost double-counts against the one place this game already
// prices a building conversion (SELL_HOUSE, always houseCost ×
// HOUSE_SELLBACK_RATIO — the same hotel would be worth two different
// amounts depending which code path asked); and bare mortgageValue for a
// mortgaged property ignores that the player still owns the underlying
// land, only owing its payoff cost against it.
//
// Buildings, by contrast, DO reuse bankruptcy.js's own math exactly
// (houseSellBackValue) — unlike land, a building has no "mortgage and
// reclaim" option at all; SELL_HOUSE is the only conversion mechanic that
// exists for it, always at half price, with no way to buy it back. Its
// real, only-available cash value really is the sell-back figure, for
// bankruptcy purposes and for net worth alike — there's no second, higher
// number to disagree about the way there is for land.

import { houseSellBackValue } from './bankruptcy.js';

/**
 * A single owned property's contribution to its owner's net worth — land
 * (full price, minus the real cost to clear a mortgage if one exists) plus
 * buildings (bankruptcy.js's own sell-back math, reused verbatim so the
 * same asset is never worth two different amounts depending who's asking).
 *
 * The payoff cost is computed as `ceil((mortgageValue * 11) / 10)`, NOT
 * `ceil(mortgageValue * 1.1)` — the latter is finding #26
 * (docs/PROJECT_STATUS.md): IEEE-754 floating point makes `100 * 1.1`
 * evaluate to `110.00000000000001` in JavaScript, one tick over the whole
 * number, which `Math.ceil` then rounds up to 111 instead of 110. Caught
 * here by this file's own test suite reproducing the exact same class of
 * bug finding #26 already fixed once in economy/propertyEconomy.js's
 * calculateUnmortgage — must stay numerically identical to that function's
 * real UNMORTGAGE cost, not just conceptually similar, since this is
 * previewing the same real number a player would actually be charged.
 * @param {import('../domain/tile.js').Tile} tile
 * @param {import('../domain/property.js').Property} property
 * @returns {number}
 */
export function propertyNetWorth(tile, property) {
  const landValue = property.mortgaged
    ? Math.max(0, tile.price - Math.ceil((tile.mortgageValue * 11) / 10))
    : tile.price;

  return landValue + houseSellBackValue(tile, property);
}

/**
 * Total net worth for one player: cash on hand plus every owned property's
 * propertyNetWorth() above. Server-authoritative by construction — reads
 * only live GameState fields (currentBalance, properties[].{ownerId,
 * upgradeLevel, mortgaged}), never anything a client supplies. Locked
 * trade/auction funds need no special handling: money offered in a pending
 * trade is still sitting in currentBalance until ACCEPT_TRADE actually
 * moves it, and an offered property is still owned by whoever holds it —
 * both already correctly picked up by the plain scans below, as long as
 * any pending trades/auction are voided before this is called (Win
 * Condition design §J.5 — gameEndMachine.js's job, not this function's).
 * @param {import('../domain/gameState.js').GameState} gameState
 * @param {import('../domain/tile.js').Tile[]} boardTiles
 * @param {string} playerId - PlayerGameState.id
 * @returns {number}
 */
export function netWorth(gameState, boardTiles, playerId) {
  const player = gameState.players.find((p) => p.id === playerId);
  const ownedProperties = gameState.properties.filter((p) => p.ownerId === playerId);

  const propertyTotal = ownedProperties.reduce((sum, property) => {
    const tile = boardTiles.find((t) => t.id === property.boardTileId);
    return sum + propertyNetWorth(tile, property);
  }, 0);

  return player.currentBalance + propertyTotal;
}
