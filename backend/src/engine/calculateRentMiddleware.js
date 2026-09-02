import { calculateRent } from './calculateRent.js';

export function calculateFinalRent(
  gameState,
  payerId,
  ownerId,
  targetTile,
  targetProperty,
  ownerHoldings,
  groupTiles,
  diceRoll
) {
  let baseRent = calculateRent({
    targetTile,
    targetProperty,
    ownerHoldings,
    groupTiles,
    diceRoll,
    ruleset: gameState.ruleset,
  });

  if (gameState.ruleset === 'CLASSIC') {
    return baseRent;
  }

  let finalRent = baseRent;
  const owner = gameState.players.find((p) => p.id === ownerId);
  const payer = gameState.players.find((p) => p.id === payerId);

  if (!owner || !payer) return baseRent;

  if (owner.activePerks && owner.activePerks.includes('BUFF_RENT_BLUE') && targetTile.color === 'BLUE') {
    finalRent *= 2;
  }

  if (payer.activePerks && payer.activePerks.includes('SHIELD_50')) {
    finalRent *= 0.5;
  }

  return Math.floor(finalRent);
}
