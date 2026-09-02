// Client-side mirror of backend/src/engine/netWorth.js — extracted
// 2026-08-25, when PlayersPanel.jsx needed a live standings order ("dựa vào
// số tiền hiện tại để xếp ai ở vị trí cao nhất, ai nhiều tiền + tính giá trị
// bất động sản và nhà cao nhất thì xếp hạng cao nhất") and MyPortfolio.jsx
// already carried a private copy of exactly this maths. A third copy was the
// alternative; one shared module is the same standing decision buildRules.js
// was extracted under.
//
// This must stay numerically identical to the server's own figure, not
// merely close: the same ranking is what gameEndMachine.js's rankPlayers()
// computes for real at game end, so a live standings board that disagreed
// with the final result would read as the game changing its mind about who
// was winning.
//
// Two details carried over verbatim from the server, both load-bearing:
//
//   - `ceil((mortgageValue * 11) / 10)`, never `ceil(mortgageValue * 1.1)`.
//     That is finding #26 (docs/PROJECT_STATUS.md): IEEE-754 makes
//     `100 * 1.1` evaluate to 110.00000000000001, which Math.ceil then
//     rounds up to 111. The integer form is exact.
//   - buildings are worth their SELL-BACK value (half of houseCost), not
//     what was paid for them, and are worth 0 on a mortgaged property —
//     byte-for-byte engine/bankruptcy.js's houseSellBackValue, which
//     netWorth.js itself reuses rather than restating.
//
// Land, by contrast, counts at full price when unmortgaged (the player owns
// it outright) and at price-minus-payoff when mortgaged — deliberately NOT
// the "what could you raise under duress" valuation checkSolvency() uses.
// See netWorth.js's own file header for why those two questions differ.

const HOUSE_SELLBACK_RATIO = 0.5 // mirrors backend/src/engine/bankruptcy.js

/**
 * One owned property's contribution to its owner's net worth.
 * @param {object} tile - a staticBoard tile
 * @param {object} property - the game-scoped ownership row
 * @returns {number}
 */
export function propertyValue(tile, property) {
  const land = property.mortgaged
    ? Math.max(0, tile.price - Math.ceil((tile.mortgageValue * 11) / 10))
    : tile.price

  const buildings =
    !property.mortgaged && tile.houseCost != null && property.upgradeLevel > 0
      ? Math.floor(property.upgradeLevel * tile.houseCost * HOUSE_SELLBACK_RATIO)
      : 0

  return land + buildings
}

/**
 * Cash on hand plus every owned property's propertyValue() above — the same
 * total engine/netWorth.js's netWorth() produces server-side.
 *
 * Tiles missing from staticBoard are skipped rather than counted as 0 with a
 * crash risk: staticBoard is fetched asynchronously and can legitimately be
 * absent for the first broadcast of a session (socketClient.js's own
 * ensureStaticBoardLoaded is fire-and-forget), which would otherwise throw
 * on `tile.price` here.
 * @param {object} gameState
 * @param {object|null} staticBoard
 * @param {object} player - a PlayerGameState
 * @returns {number}
 */
export function playerNetWorth(gameState, staticBoard, player) {
  const owned = gameState.properties.filter((p) => p.ownerId === player.id)

  const propertyTotal = owned.reduce((sum, property) => {
    const tile = staticBoard?.tiles?.find((t) => t.id === property.boardTileId)
    return tile ? sum + propertyValue(tile, property) : sum
  }, 0)

  return player.currentBalance + propertyTotal
}
