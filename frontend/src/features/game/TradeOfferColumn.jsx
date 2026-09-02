import { GROUP_COLORS, CHANCE_FORTUNE_COLOR } from '../board/tileVisuals'
import styles from './TradeOfferColumn.module.css'

/**
 * One side of TradeWindow.jsx's split view — reused for both parties, in
 * both edit mode (a fresh proposal or a counter draft: checkboxes + a money
 * input over the owner's *full* property list) and view mode (a real,
 * already-sent Trade's offer: a plain read-only list of just what's
 * actually offered). Kept as its own component/file per this task's own
 * "consider breaking it down" instruction — TradeWindow.jsx would otherwise
 * need this same rendering twice (or four times, counting edit vs. view)
 * inline.
 * @param {object} props
 * @param {string} props.label
 * @param {string} props.playerName
 * @param {number} props.playerBalance
 * @param {object[]} props.ownedProperties - every Property row this side's player owns (editable mode only needs this; view mode ignores it in favor of offeredPropertyIds)
 * @param {object} props.staticBoard
 * @param {boolean} props.editable
 * @param {string[]} props.offeredPropertyIds - selected/offered Property.id[] — the draft selection in edit mode, or the real offer.properties in view mode
 * @param {(propertyId: string) => void} [props.onToggleProperty] - edit mode only
 * @param {Set<string>} [props.lockedPropertyIds] - edit mode only — properties already committed to a *different* active trade, shown disabled
 * @param {number} props.moneyValue
 * @param {(value: number) => void} [props.onMoneyChange] - edit mode only
 * @param {number} [props.maxMoney] - edit mode only — the offering player's unlocked balance, caps the money input
 */
export default function TradeOfferColumn({
  label,
  playerName,
  playerBalance,
  ownedProperties,
  staticBoard,
  editable,
  offeredPropertyIds,
  onToggleProperty,
  lockedPropertyIds,
  moneyValue,
  onMoneyChange,
  maxMoney,
}) {
  const tileFor = (property) => staticBoard.tiles.find((t) => t.id === property.boardTileId)

  const rows = editable ? ownedProperties : ownedProperties.filter((p) => offeredPropertyIds.includes(p.id))

  function handleMoneyInput(e) {
    const raw = Number(e.target.value)
    const clamped = Number.isFinite(raw) ? Math.max(0, Math.min(maxMoney, Math.trunc(raw))) : 0
    onMoneyChange(clamped)
  }

  return (
    <div className={styles.column}>
      <div className={styles.header}>
        <span className={styles.label}>{label}</span>
        <span className={styles.playerName}>{playerName}</span>
        <span className={styles.balance}>Số dư: ${playerBalance}</span>
      </div>

      <div className={styles.propertyList}>
        {rows.length === 0 && <p className={styles.empty}>{editable ? 'Không có tài sản nào' : '(không có)'}</p>}
        {rows.map((property) => {
          const tile = tileFor(property)
          const isLocked = editable && lockedPropertyIds.has(property.id)
          const isChecked = offeredPropertyIds.includes(property.id)
          const groupColor = tile?.groupId ? GROUP_COLORS[tile.groupId] : undefined
          const swatchColor = tile ? (CHANCE_FORTUNE_COLOR[tile.tileType] ?? groupColor) : undefined

          return (
            <label
              key={property.id}
              className={`${styles.propertyRow} ${isLocked ? styles.propertyRowLocked : ''} ${!editable ? styles.propertyRowStatic : ''}`}
              title={isLocked ? 'Đang bị khoá bởi một giao dịch khác' : undefined}
            >
              {editable && (
                <input
                  type="checkbox"
                  checked={isChecked}
                  disabled={isLocked}
                  onChange={() => onToggleProperty(property.id)}
                />
              )}
              <span className={styles.swatch} style={{ background: swatchColor ?? 'var(--code-bg)' }} />
              <span className={styles.propertyName}>{tile?.name ?? property.id}</span>
              {property.upgradeLevel > 0 && <span className={styles.upgradeBadge}>{property.upgradeLevel === 5 ? '🏨' : `🏠${property.upgradeLevel}`}</span>}
              {property.mortgaged && <span className={styles.mortgagedBadge}>Cầm cố</span>}
              {isLocked && <span className={styles.lockedBadge}>🔒 Đã khoá</span>}
            </label>
          )
        })}
      </div>

      <div className={styles.moneyRow}>
        <span className={styles.moneyLabel}>Tiền mặt</span>
        {editable ? (
          <input type="number" className={styles.moneyInput} min={0} max={maxMoney} step={1} value={moneyValue} onChange={handleMoneyInput} />
        ) : (
          <span className={styles.moneyValue}>${moneyValue}</span>
        )}
      </div>
    </div>
  )
}
