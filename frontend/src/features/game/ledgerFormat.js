// Ledger feed formatting (GameView redesign, 2026-08-22) — pure mapping from
// a stored transactionLog entry (gameStore.js's transactionLog, built by
// network/socketClient.js at the moment each S2C_STATE_UPDATE arrives) to
// display text. Mirrors backend/src/economy/applyTransaction.js's own
// TRANSACTION_TYPES exactly (no shared package between frontend/backend in
// this repo, same standing as every other mirrored backend constant/enum in
// this app — JAIL_FINE in GameControls.jsx, MAX_UPGRADE_LEVEL in
// PropertyManager.jsx, etc.).
//
// A stored entry only ever carries { id, transactionType, amount,
// fromPlayerId, toPlayerId, tileName, atStateVersion } — fromPlayerId/
// toPlayerId are either a real PlayerGameState.playerId or the literal
// string BANK_ID (resolved once, at insertion time, in socketClient.js —
// see that file's own header for why resolving late instead would risk a
// stale/wrong tileName once a player moves again in a later turn).
//
// tileName is only ever non-null for 'rent'/'purchase' — a raw Transaction
// record (applyTransaction.js) carries no property/tile reference at all,
// and for every other type there's no reliable way to recover which tile
// was involved from the data actually available. Deliberately not guessed
// for the rest — matches this project's own established "don't fabricate
// content you can't actually derive" standard (PROJECT_STATUS.md's repeated
// precedent, e.g. the honest INSTANT-event-card toast).
export const BANK_ID = 'BANK'

const CATEGORY = {
  rent: 'debit',
  tax: 'debit',
  jail_fine: 'debit',
  rent_gamble: 'debit',
  hostile_acquisition: 'debit',
  bankruptcy_transfer: 'debit',
  purchase: 'credit',
  build: 'credit',
  sell_house: 'credit',
  unmortgage: 'credit',
  pass_go_salary: 'credit',
  free_parking_jackpot: 'credit',
  event_card: 'event',
  flash_auction: 'event',
  trade: 'event',
  mortgage: 'event',
}

const LABEL = {
  rent: 'Trả Tiền Thuê',
  purchase: 'Mua Bất Động Sản',
  pass_go_salary: 'Qua Ô Bắt Đầu',
  tax: 'Đóng Thuế',
  event_card: 'Cơ Hội / Khí Vận',
  jail_fine: 'Nộp Phạt Tù',
  build: 'Xây Nhà',
  sell_house: 'Bán Nhà',
  mortgage: 'Cầm Cố',
  unmortgage: 'Chuộc Đất',
  trade: 'Giao Dịch',
  flash_auction: 'Đấu Giá Chớp Nhoáng',
  hostile_acquisition: 'Cưỡng Đoạt',
  rent_gamble: 'Cược Tiền Thuê',
  bankruptcy_transfer: 'Phá Sản',
  free_parking_jackpot: 'Jackpot Bãi Đỗ Xe',
}

const ICON = {
  rent: '💰',
  purchase: '🏠',
  pass_go_salary: '🚩',
  tax: '🧾',
  event_card: '🍀',
  jail_fine: '🚔',
  build: '🏗️',
  sell_house: '🏚️',
  mortgage: '🔒',
  unmortgage: '🔓',
  trade: '🤝',
  flash_auction: '🔨',
  hostile_acquisition: '⚔️',
  rent_gamble: '🎲',
  bankruptcy_transfer: '💔',
  free_parking_jackpot: '🅿️',
}

// Re-exported 2026-08-25 so PlayersPanel.jsx's floating money-change
// indicator labels a balance movement with the same icon the Ledger uses for
// it — a tax deduction and a rent payment then read identically in both
// places, instead of the panel inventing a second icon vocabulary.
export const TRANSACTION_ICON = ICON

/**
 * @param {object} entry - a stored transactionLog entry
 * @param {(playerId: string) => string} nameFor - resolves a playerId (or BANK_ID) to display text
 * @returns {{ label: string, icon: string, category: 'debit'|'credit'|'event', description: string }}
 */
export function formatLedgerEntry(entry, nameFor) {
  const { transactionType, amount, fromPlayerId, toPlayerId, tileName } = entry
  const from = nameFor(fromPlayerId)
  const to = nameFor(toPlayerId)
  const fromIsBank = fromPlayerId === BANK_ID
  const toIsBank = toPlayerId === BANK_ID

  let description
  switch (transactionType) {
    case 'rent':
      description = tileName
        ? `${from} trả $${amount} tiền thuê cho ${to} tại ${tileName}.`
        : `${from} trả $${amount} tiền thuê cho ${to}.`
      break
    case 'purchase':
      description = tileName
        ? `${from} mua ${tileName} với giá $${amount}.`
        : `${from} mua một bất động sản với giá $${amount}.`
      break
    case 'pass_go_salary':
      description = `${to} đi qua ô Bắt Đầu và nhận $${amount}.`
      break
    case 'tax':
      description = `${from} đóng thuế $${amount}.`
      break
    case 'event_card':
      description = toIsBank
        ? `${from} rút thẻ Cơ Hội/Khí Vận và mất $${amount}.`
        : `${to} rút thẻ Cơ Hội/Khí Vận và nhận $${amount}.`
      break
    case 'jail_fine':
      description = `${from} nộp phạt tù $${amount}.`
      break
    case 'build':
      description = `${from} xây nhà (chi $${amount}).`
      break
    case 'sell_house':
      description = `${to} bán nhà, nhận lại $${amount}.`
      break
    case 'mortgage':
      description = `${to} cầm cố tài sản, nhận $${amount}.`
      break
    case 'unmortgage':
      description = `${from} chuộc đất, trả $${amount}.`
      break
    case 'trade':
      description = `${from} chuyển $${amount} cho ${to} trong một giao dịch.`
      break
    case 'flash_auction':
      description = fromIsBank ? `${to} nhận $${amount} từ đấu giá.` : `${from} thắng đấu giá, trả $${amount}.`
      break
    case 'hostile_acquisition':
      description = `${from} cưỡng đoạt tài sản từ ${to}, trả $${amount}.`
      break
    case 'rent_gamble':
      description = fromIsBank
        ? `${to} thắng cược tiền thuê, ${from} trả thêm $${amount}.`
        : `${from} thua cược tiền thuê, mất $${amount} cho ${to}.`
      break
    case 'bankruptcy_transfer':
      description = `${from} phá sản, chuyển $${amount} cho ${to}.`
      break
    case 'free_parking_jackpot':
      description = `${to} nhận Jackpot Bãi Đỗ Xe $${amount}.`
      break
    default:
      description = `${from} → ${to}: $${amount}.`
  }

  return {
    label: LABEL[transactionType] ?? transactionType,
    icon: ICON[transactionType] ?? '•',
    category: CATEGORY[transactionType] ?? 'event',
    description,
  }
}
