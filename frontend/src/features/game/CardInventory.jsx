import { useState, useEffect } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useGameStore } from '../../store/gameStore'
import { sendGameAction } from '../../network/socketClient'
import { getEventCards } from '../../network/api'
import TileIcon from '../board/TileIcon'
import styles from './CardInventory.module.css'

// Card Inventory hand (2026-08-27) — keepable event cards go into
// PlayerGameState.inventory on draw instead of resolving, and are played
// later via USE_INVENTORY_CARD.
//
// Rewritten 2026-09-01 after a bug sweep found this component was entirely
// non-functional. Three real defects, all fixed here:
//
//  1. Every one of the four call sites used `sendGameAction(roomId, {type,
//     payload})`. The real signature is `sendGameAction(actionType, payload)`
//     — two positional arguments, and the roomId is read from the store by
//     socketClient.js itself. So the server received actionType = a room
//     UUID and rejected every single click. Every other component in this
//     codebase already called it correctly; this file was the only one.
//  2. CHOICE cards were dispatched from a hardcoded `if (card.id === 'C12…')
//     else if (card.id === 'C08…')` ladder, and any other CHOICE card fell
//     through to a bare `return` — a permanently dead button. The card's own
//     `options` array (already on the wire from GET /api/v1/event-cards, the
//     same object resolveChoice() reads server-side) is what drives this now,
//     so a fifth keepable card needs no change here at all.
//  3. `window.prompt`/`alert` for option picking, including asking the player
//     to type a raw array index against a list of database property IDs.
//     Replaced with a real inline expansion, mirroring EventCardModal.jsx's
//     own option UI — the established pattern for exactly this decision.
//
// Server authority is unchanged: `playerId` is overwritten server-side with
// the real sender's identity (socketServer.js), and probabilityRoll/
// dieFaceRoll are injected by serverGeneratedFields() — nothing random is
// computed here, same as EventCardModal.jsx.
export default function CardInventory() {
  const { user, session } = useAuth()
  const gameState = useGameStore((s) => s.currentGameState)
  const staticBoard = useGameStore((s) => s.staticBoard)
  const lastError = useGameStore((s) => s.lastError)

  const [cardsData, setCardsData] = useState({})
  const [openCardId, setOpenCardId] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    getEventCards(session.access_token)
      .then((data) => setCardsData(data.cards ?? {}))
      .catch(() => {}) // real card text stays unavailable; the id-based fallback below still renders
  }, [session.access_token])

  // Same click-guard reset every other action component uses.
  useEffect(() => {
    setBusy(false)
  }, [gameState?.stateVersion, lastError])

  const [isExpanded, setIsExpanded] = useState(true)

  if (!gameState) return null
  const me = gameState.players.find((p) => p.playerId === user.id)
  // A bankrupt player holds no cards (applyBankruptcy clears `inventory` as
  // of 2026-09-01) — the explicit check also covers a pre-fix snapshot that
  // still carries a stale hand.
  if (!me || me.bankrupt) return null
  const inventory = me.inventory ?? [] // `?? []` — a match started before 2026-08-27 has no such field at all

  function play(cardId, extra) {
    setBusy(true)
    setOpenCardId(null)
    sendGameAction('USE_INVENTORY_CARD', { cardId, ...extra })
  }

  // Mirrors turnMachine.js's protectablePropertiesFor(): mine and unimproved.
  function protectableProperties() {
    return (gameState.properties ?? [])
      .filter((p) => p.ownerId === me.id && p.upgradeLevel === 0)
      .map((p) => ({ property: p, tile: staticBoard?.tiles?.find((t) => t.id === p.boardTileId) }))
      .filter((x) => x.tile != null)
  }

  const openCard = openCardId ? cardsData[openCardId] : null

  return (
    <div className={styles.panel}>
      <button
        type="button"
        className={styles.headerBtn}
        onClick={() => setIsExpanded(!isExpanded)}
        title={isExpanded ? 'Thu gọn kho thẻ' : 'Mở rộng kho thẻ'}
      >
        <h2 className={styles.heading}>Thẻ Sự Kiện</h2>
        <span className={styles.count}>{inventory.length}</span>
        <span className={styles.toggleIcon}>{isExpanded ? '▼' : '▶'}</span>
      </button>

      {isExpanded && (
        <div className={styles.body}>
          <div className={styles.hand}>
            {inventory.length === 0 ? (
              <p className={styles.noneLine}>Bạn chưa có thẻ nào.</p>
            ) : (
              inventory.map((cardId, index) => {
                const c = cardsData[cardId]
                const isOpen = openCardId === cardId
                return (
                  <button
                    key={`${cardId}-${index}`}
                    type="button"
                    className={`${styles.card} ${isOpen ? styles.cardOpen : ''}`}
                    disabled={busy}
                    title={c?.text ?? cardId}
                    onClick={() => setOpenCardId(isOpen ? null : cardId)}
                  >
                    <TileIcon type="chance" className={styles.cardIcon} />
                    <span className={styles.cardName}>{c?.text ?? cardId}</span>
                  </button>
                )
              })
            )}
          </div>

          {openCard && (
            <div className={styles.detail}>
              <p className={styles.detailText}>{openCard.text}</p>

              {openCard.type === 'CHOICE' ? (
                <div className={styles.options}>
                  {(openCard.options ?? []).flatMap((option) => {
                    if ((option.intents ?? []).some((i) => i.action === 'GRANT_PROPERTY_PROTECTION')) {
                      const eligible = protectableProperties()
                      if (eligible.length === 0) {
                        return [
                          <p key="none" className={styles.noneLine}>
                            Bạn không có đất nào chưa xây nhà để bảo vệ.
                          </p>,
                        ]
                      }
                      return eligible.map(({ property, tile }) => (
                        <button
                          key={property.id}
                          type="button"
                          className={styles.optionButton}
                          disabled={busy}
                          onClick={() => play(openCardId, { optionId: option.id, propertyId: property.id })}
                        >
                          Bảo vệ {tile.name}
                        </button>
                      ))
                    }

                    const cannotAfford = option.validation != null && me.currentBalance < option.validation.amount
                    return [
                      <button
                        key={option.id}
                        type="button"
                        className={styles.optionButton}
                        disabled={busy || cannotAfford}
                        title={cannotAfford ? 'Không đủ tiền' : undefined}
                        onClick={() => play(openCardId, { optionId: option.id })}
                      >
                        {option.text}
                      </button>,
                    ]
                  })}
                </div>
              ) : (
                <button type="button" className={styles.optionButton} disabled={busy} onClick={() => play(openCardId, {})}>
                  Sử dụng thẻ
                </button>
              )}

              <button type="button" className={styles.cancelButton} onClick={() => setOpenCardId(null)}>
                Để sau
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
