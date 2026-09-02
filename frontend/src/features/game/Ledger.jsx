import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useGameStore } from '../../store/gameStore'
import { getRoom } from '../../network/api'
import { formatLedgerEntry, BANK_ID } from './ledgerFormat'
import styles from './Ledger.module.css'

// Event history feed (GameView redesign, 2026-08-22) — new feature, right
// column, upper part. Reads gameStore's transactionLog (accumulated by
// network/socketClient.js — see that file's own header for how/why); this
// component only formats and renders, never touches the socket layer.
// Same independent GET /api/v1/rooms/:id display-name fetch pattern every
// sibling game component already uses on its own.
export default function Ledger() {
  const { user, session } = useAuth()
  const roomId = useGameStore((s) => s.roomState?.roomId)
  const log = useGameStore((s) => s.transactionLog)

  const [displayNames, setDisplayNames] = useState({})
  const [isExpanded, setIsExpanded] = useState(false)

  useEffect(() => {
    if (!roomId) return
    getRoom(session.access_token, roomId)
      .then((room) => {
        const map = {}
        for (const p of room.players ?? []) map[p.playerId] = p.displayName
        setDisplayNames(map)
      })
      .catch(() => {})
  }, [roomId, session.access_token])

  // Same "Bạn" special-case PlayersPanel.jsx's own nameFor already uses —
  // found missing here live (2026-08-22): without it, a ledger entry
  // involving the local player showed their raw auth id instead, since
  // this is the one place in this file that resolves identity, unlike
  // PlayersPanel's own per-row check.
  const nameFor = (playerId) => {
    if (playerId === BANK_ID) return 'Ngân Hàng'
    if (playerId === user.id) return 'Bạn'
    return displayNames[playerId] ?? playerId ?? '…'
  }

  return (
    <div className={`${styles.panel} ${isExpanded ? styles.expanded : styles.collapsed}`}>
      <button 
        type="button" 
        className={styles.headerBtn}
        onClick={() => setIsExpanded(!isExpanded)}
        title={isExpanded ? 'Thu gọn nhật ký' : 'Mở rộng nhật ký'}
      >
        <h2 className={styles.heading}>Nhật Ký</h2>
        <span className={styles.toggleIcon}>{isExpanded ? '▼' : '▶'}</span>
      </button>
      
      {isExpanded && (
        <div className={styles.list}>
          {log.length === 0 && <p className={styles.empty}>Chưa có sự kiện nào.</p>}
          {log.map((entry) => {
            const { label, icon, category, description } = formatLedgerEntry(entry, nameFor)
            return (
              <div key={entry.id} className={`${styles.entry} ${styles[category]}`}>
                <p className={styles.entryLabel}>
                  <span className={styles.entryIcon}>{icon}</span>
                  {label}
                </p>
                <p className={styles.entryDescription}>{description}</p>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

