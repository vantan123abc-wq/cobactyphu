/**
 * Từ điển các Thẻ Di Chuyển (Movement Deck).
 * Dùng cho chế độ Đột Phá (ASYMMETRIC) để thay thế xúc xắc.
 */
export const MOVEMENT_CARDS = {
  // Nền tảng - Giữ nhịp độ (x2 weight)
  'MOVE_5': { steps: 5, direction: 1, cost: 0, description: 'Đi 5 bước.' },
  'MOVE_6': { steps: 6, direction: 1, cost: 0, description: 'Đi 6 bước.' },
  'MOVE_7': { steps: 7, direction: 1, cost: 0, description: 'Đi 7 bước.' },
  'MOVE_8': { steps: 8, direction: 1, cost: 0, description: 'Đi 8 bước.' },
  'MOVE_9': { steps: 9, direction: 1, cost: 0, description: 'Đi 9 bước.' },

  // Độ chính xác phải mua
  'STEP_1': { steps: 1, direction: 1, cost: 50, description: 'Đi 1 bước (50$).' },
  'STEP_2': { steps: 2, direction: 1, cost: 50, description: 'Đi 2 bước (50$).' },
  'STEP_3': { steps: 3, direction: 1, cost: 50, description: 'Đi 3 bước (50$).' },

  // Bứt tốc
  'SPRINT_12': { steps: 12, direction: 1, cost: 100, description: 'Chạy bứt tốc 12 bước (100$).' },

  // Lùi
  'BACKUP_3': { steps: 3, direction: -1, cost: 0, description: 'Đi lùi 3 bước.' },

  // May rủi. `random` (not a `steps` sentinel) is what marks this card as
  // needing a server-generated roll — the same explicit-marker convention
  // eventDictionary.js uses for PROBABILITY options, and the reason
  // socketServer.js's serverGeneratedFields() can detect it without
  // hard-coding this card's id. A negative `steps` sentinel was the previous
  // shape and it silently resolved to 1 step forever (handlePlayMovementCard's
  // `steps > 0 ? steps : 1` mock), which is exactly the class of bug an
  // explicit flag prevents.
  'MOVE_RANDOM_2_12': { random: [2, 12], direction: 1, cost: 0, description: 'Đổ 2 viên xúc xắc ngẫu nhiên (2-12 bước).' },

  // Miễn nhiễm pass-through (trả giá bằng nhịp độ chậm)
  'JUMP_2': { steps: 2, direction: 1, cost: 0, ignorePassThrough: true, description: 'Nhảy cóc 2 bước (Miễn nhiễm hiệu ứng lướt).' },
  'JUMP_3': { steps: 3, direction: 1, cost: 0, ignorePassThrough: true, description: 'Nhảy cóc 3 bước (Miễn nhiễm hiệu ứng lướt).' },
};

// Mảng 18 lá rút có hoàn lại (đã áp dụng weight)
const DECK_ARRAY = [
  'MOVE_5', 'MOVE_5', 'MOVE_6', 'MOVE_6', 'MOVE_7', 'MOVE_7', 'MOVE_8', 'MOVE_8', 'MOVE_9', 'MOVE_9',
  'STEP_1', 'STEP_2', 'STEP_3',
  'SPRINT_12',
  'BACKUP_3',
  'MOVE_RANDOM_2_12',
  'JUMP_2', 'JUMP_3'
];

/**
 * Trả về N thẻ bài ngẫu nhiên để thêm vào tay người chơi (Rút có hoàn lại)
 * @param {number} count - Số lượng bài cần rút
 */
export function drawMovementHand(count = 1) {
  const hand = [];
  for (let i = 0; i < count; i++) {
    const randomKey = DECK_ARRAY[Math.floor(Math.random() * DECK_ARRAY.length)];
    hand.push(randomKey);
  }
  return hand;
}
