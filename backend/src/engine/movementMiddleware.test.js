import test from 'node:test';
import assert from 'node:assert';
import { resolveMovement } from './movementMiddleware.js';

test('resolveMovement in CLASSIC mode works normally', () => {
  const gameState = { 
    ruleset: 'CLASSIC', 
    players: [{ id: 'p1', currentPosition: 0 }] 
  };
  const { newPosition, passedGo } = resolveMovement(gameState, 'p1', 5, 1, 36);
  assert.strictEqual(newPosition, 5);
  assert.strictEqual(passedGo, false);
});

test('resolveMovement in ASYMMETRIC mode stops at ROADBLOCK', () => {
  const gameState = { 
    ruleset: 'ASYMMETRIC',
    players: [{ id: 'p1', currentPosition: 0 }],
    activeTraps: [
      { tileIndex: 3, type: 'ROADBLOCK', ownerId: 'p2' }
    ]
  };
  // Thử đi 5 bước, nhưng bị cản ở bước 3
  const { newPosition, stoppedByTrap } = resolveMovement(gameState, 'p1', 5, 1, 36);
  assert.strictEqual(newPosition, 3);
  assert.strictEqual(stoppedByTrap, true);
});

test('resolveMovement in ASYMMETRIC mode handles backwards movement', () => {
  const gameState = { 
    ruleset: 'ASYMMETRIC',
    players: [{ id: 'p1', currentPosition: 5 }],
    activeTraps: []
  };
  // Đi lùi 2 bước
  const { newPosition } = resolveMovement(gameState, 'p1', 2, -1, 36);
  assert.strictEqual(newPosition, 3);
});
