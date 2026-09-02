import { movePlayer as classicMovePlayer } from './movement.js';

/**
 * Middleware để di chuyển người chơi.
 * Hỗ trợ chế độ CLASSIC (tiến bình thường) và ASYMMETRIC (có bẫy cản đường).
 */
export function resolveMovement(gameState, playerId, steps, direction = 1, boardTileCount) {
  const player = gameState.players.find((p) => p.id === playerId);
  if (!player) throw new Error('Player not found');

  if (gameState.ruleset === 'CLASSIC') {
    return classicMovePlayer(player.currentPosition, steps, boardTileCount);
  }

  // Chế độ ASYMMETRIC (Có bẫy)
  let currentPos = player.currentPosition;
  let stepsRemaining = steps;
  let passedGo = false;
  let stoppedByTrap = false;

  while (stepsRemaining > 0) {
    // direction = 1 (tiến), -1 (lùi)
    let rawPosition = currentPos + direction;
    if (rawPosition >= boardTileCount) {
        passedGo = true;
    }
    currentPos = (rawPosition + boardTileCount) % boardTileCount;
    
    // Kiểm tra Bẫy (nếu có) trên ô này
    const traps = gameState.activeTraps || [];
    const trap = traps.find((t) => t.tileIndex === currentPos);
    
    if (trap) {
      if (trap.type === 'ROADBLOCK') {
        stoppedByTrap = true;
        break;
      }
      // TODO: Xử lý TOLL_BOOTH (cần đẩy action ra ngoài để trừ tiền, hoặc trả về danh sách các bẫy đã dẫm)
    }
    stepsRemaining--;
  }

  return { newPosition: currentPos, passedGo, stoppedByTrap };
}
