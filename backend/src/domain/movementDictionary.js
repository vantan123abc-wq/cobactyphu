/**
 * Từ điển các Thẻ Di Chuyển (Movement Deck).
 * Dùng cho chế độ Đột Phá (ASYMMETRIC) để thay thế xúc xắc.
 */
export const MOVEMENT_CARDS = {
  'MOVE_1': { steps: 1, direction: 1, cost: 0, description: 'Đi 1 bước chậm rãi.' },
  'MOVE_2': { steps: 2, direction: 1, cost: 0, description: 'Đi 2 bước.' },
  'MOVE_3': { steps: 3, direction: 1, cost: 0, description: 'Đi 3 bước cơ bản.' },
  'MOVE_4': { steps: 4, direction: 1, cost: 0, description: 'Đi 4 bước.' },
  'MOVE_5': { steps: 5, direction: 1, cost: 0, description: 'Đi 5 bước.' },
  'MOVE_6': { steps: 6, direction: 1, cost: 0, description: 'Đi 6 bước xa.' },

  // [CÂN BẰNG]: Thẻ đi xa nhưng mất tiền
  'SPRINT_6': { steps: 6, direction: 1, cost: 50, description: 'Chạy nước rút 6 bước, tốn 50$ lộ phí.' },
  'SPRINT_8': { steps: 8, direction: 1, cost: 100, description: 'Chạy nước rút 8 bước, tốn 100$ lộ phí.' },

  // [CÂN BẰNG]: Thẻ đi lùi (có thể dùng để né mìn phía trước)
  'BACKUP_1': { steps: 1, direction: -1, cost: 0, description: 'Lùi lại 1 bước.' },
  'BACKUP_2': { steps: 2, direction: -1, cost: 0, description: 'Lùi lại 2 bước.' },
  'BACKUP_3': { steps: 3, direction: -1, cost: 0, description: 'Lùi lại 3 bước.' },

  // [CÂN BẰNG]: Thẻ xổ số (cho ai thích may rủi)
  'MOVE_RANDOM_1_6': { steps: -1, direction: 1, cost: 0, description: 'Đổ 1 viên xúc xắc ngẫu nhiên (1-6 bước).' },
  'MOVE_RANDOM_2_12': { steps: -2, direction: 1, cost: 0, description: 'Đổ 2 viên xúc xắc ngẫu nhiên (2-12 bước).' },
};

/**
 * Trả về 3 thẻ bài ngẫu nhiên để thêm vào tay người chơi
 */
export function drawMovementHand() {
  const keys = Object.keys(MOVEMENT_CARDS);
  const hand = [];
  for (let i = 0; i < 3; i++) {
    const randomKey = keys[Math.floor(Math.random() * keys.length)];
    hand.push(randomKey);
  }
  return hand;
}
