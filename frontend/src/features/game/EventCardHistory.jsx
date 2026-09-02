import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useGameStore } from '../../store/gameStore'
import { getEventCards, getRoom } from '../../network/api'
import styles from './EventCardHistory.module.css'

// "Thẻ đã rút" — re-read a Cơ Hội / Khí Vận card after its modal has gone
// (2026-08-25, user request: "đôi khi vào ô cơ hội và khí vận quên đọc đã ấn
// đóng mất rồi, thì làm sao để đọc lại").
//
// There was genuinely no way back before this. EventCardModal shows a draw
// exactly once — dismissed by its own button or, for an INSTANT card, by a
// 5s auto-dismiss — and the Ledger records only the money that moved ("Cơ
// Hội / Khí Vận, -$25"), never the card's text. GameState itself keeps only
// the single most recent draw, so anything older existed nowhere at all
// until gameStore's eventCardLog started accumulating them.
//
// Deliberately a separate component rather than a mode inside
// EventCardModal: that component owns a live, time-sensitive, sometimes
// turn-blocking moment (flip animation, choice buttons, auto-dismiss), and
// threading a second "but read-only, and for an older card" state through it
// would put the two very different jobs in one place. This one is pure
// history — no timers, no actions, nothing that can affect play.
//
// Shows every draw at the table, not just the local player's: the deck has
// cards that charge or pay everyone, and knowing what a rival drew is real,
// legitimately-public information — the modal itself already reveals every
// draw to all players (see its own header).
export default function EventCardHistory() {
  const { user, session } = useAuth()
  const roomId = useGameStore((s) => s.roomState?.roomId)
  const log = useGameStore((s) => s.eventCardLog)

  const [cards, setCards] = useState({})
  const [displayNames, setDisplayNames] = useState({})
  const [open, setOpen] = useState(false)
  const [expandedSeq, setExpandedSeq] = useState(null)

  useEffect(() => {
    getEventCards(session.access_token)
      .then((data) => setCards(data.cards ?? {}))
      .catch(() => {}) // same posture as EventCardModal: a fetch failure just means text is unavailable, never a crash
  }, [session.access_token])

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

  // Nothing drawn yet this match — an empty "0 thẻ" button would be noise.
  if (log.length === 0) return null

  const nameFor = (playerId) =>
    playerId === user.id ? 'Bạn' : (displayNames[playerId] ?? 'Người chơi khác')

  return (
    <>
      <button type="button" className={styles.trigger} onClick={() => setOpen(true)} title="Xem lại các thẻ Cơ Hội / Khí Vận đã rút">
        🎴 Thẻ đã rút <span className={styles.count}>{log.length}</span>
      </button>

      {open && (
        <div className={styles.backdrop} onClick={() => setOpen(false)}>
          <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
            <div className={styles.header}>
              <h3 className={styles.title}>🎴 Thẻ đã rút</h3>
              <button type="button" className={styles.closeButton} onClick={() => setOpen(false)} aria-label="Đóng">
                ✕
              </button>
            </div>

            <p className={styles.hint}>Mới nhất ở trên. Bấm vào một thẻ để xem đầy đủ nội dung.</p>

            <ol className={styles.list}>
              {log.map((entry) => {
                const card = cards[entry.cardId]
                const isExpanded = expandedSeq === entry.seq
                return (
                  <li key={entry.seq} className={styles.item}>
                    <button
                      type="button"
                      className={styles.itemButton}
                      onClick={() => setExpandedSeq(isExpanded ? null : entry.seq)}
                    >
                      <span className={styles.drawer}>{nameFor(entry.drawerPlayerId)}</span>
                      <span className={styles.preview}>
                        {card ? card.text : `(không có nội dung cho thẻ ${entry.cardId})`}
                      </span>
                      <span className={styles.chevron}>{isExpanded ? '▾' : '▸'}</span>
                    </button>

                    {isExpanded && card && (
                      <div className={styles.detail}>
                        <p className={styles.detailText}>{card.text}</p>
                        {/* A CHOICE card's options are the part most worth
                            re-reading — which one was taken is not recorded
                            anywhere, so they are listed as what was offered,
                            never as what happened. */}
                        {card.options?.length > 0 && (
                          <>
                            <p className={styles.optionsLabel}>Các lựa chọn của thẻ này:</p>
                            <ul className={styles.options}>
                              {card.options.map((o) => (
                                <li key={o.id} className={styles.option}>
                                  {o.text}
                                </li>
                              ))}
                            </ul>
                          </>
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
            </ol>
          </div>
        </div>
      )}
    </>
  )
}
