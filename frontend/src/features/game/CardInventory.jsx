import { useState, useEffect } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useGameStore } from '../../store/gameStore'
import { sendGameAction } from '../../network/socketClient'
import { suggestCards } from './cardSuggestions'
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
  const { user } = useAuth()
  const gameState = useGameStore((s) => s.currentGameState)
  const staticBoard = useGameStore((s) => s.staticBoard)
  const lastError = useGameStore((s) => s.lastError)
  // Card dictionary from the store (2026-09-03) — one shared fetch in
  // socketClient.js instead of a local one here, which auto-retries on the
  // next broadcast. Previously a local `.catch(() => {})` swallowed the error
  // AND `openCard` was looked up in the empty map, so a single blip on mount
  // silently turned this panel into a read-only list that did nothing when
  // clicked — the reported "I can see the cards but can't use them".
  const cardsData = useGameStore((s) => s.eventCards)
  const dictLoaded = Object.keys(cardsData).length > 0

  const [openCardId, setOpenCardId] = useState(null)
  const [busy, setBusy] = useState(false)

  // Same click-guard reset every other action component uses.
  useEffect(() => {
    setBusy(false)
  }, [gameState?.stateVersion, lastError])

  const [isExpanded, setIsExpanded] = useState(true)
  // A collapsed panel must not be able to hide an urgent suggestion — but the
  // player must still be able to dismiss one. Recording WHICH card was
  // dismissed (rather than a plain boolean) keeps the panel closed for that
  // suggestion while still opening for the next, genuinely different one.
  // Derived during render rather than pushed through an effect: no setState
  // during render, and no frame where the panel is wrongly closed.
  const [dismissedUrgentFor, setDismissedUrgentFor] = useState(null)

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

  // "You are holding something that helps right now" (2026-09-03, user
  // request). A keepable card does nothing until played, and nothing in the
  // game pointed at the moment to play it — see cardSuggestions.js for the
  // jail case that motivated this.
  const suggestions = suggestCards({ gameState, me, cards: cardsData })
  const urgentSuggestion = suggestions.find((s) => s.urgent) ?? null
  const urgentActive = urgentSuggestion != null && dismissedUrgentFor !== urgentSuggestion.cardId
  const bodyVisible = isExpanded || urgentActive

  function toggleExpanded() {
    // Collapsing while an urgent suggestion is up counts as dismissing that
    // suggestion — otherwise the panel would spring straight back open and
    // the collapse control would look broken.
    if (bodyVisible && urgentActive) setDismissedUrgentFor(urgentSuggestion.cardId)
    setIsExpanded(!bodyVisible)
  }

  return (
    <div className={styles.panel}>
      <button
        type="button"
        className={styles.headerBtn}
        onClick={toggleExpanded}
        title={bodyVisible ? 'Thu gọn kho thẻ' : 'Mở rộng kho thẻ'}
      >
        <h2 className={styles.heading}>Thẻ Sự Kiện</h2>
        <span className={styles.count}>{inventory.length}</span>
        <span className={styles.toggleIcon}>{bodyVisible ? '▼' : '▶'}</span>
      </button>

      {bodyVisible && (
        <div className={styles.body}>
          {/* The hand rendered as plain icon+text rows with no affordance, so it
              read as a read-only list — the reported "I don't see any way to
              use these" (2026-09-03). The play controls only ever appeared
              after clicking, in a panel further down a scrollable rail. */}
          {inventory.length > 0 && dictLoaded && suggestions.length === 0 && (
            <p className={styles.hintLine}>Chạm vào một thẻ để dùng nó.</p>
          )}

          {/* The system proposing a card, rather than waiting to be asked
              (2026-09-03 request). Opens the card straight away so the play
              buttons are one click from the prompt — the whole point is that
              the player should not have to go looking. */}
          {suggestions.map((s) => (
            <div key={s.cardId} className={s.urgent ? `${styles.suggestion} ${styles.suggestionUrgent}` : styles.suggestion}>
              <p className={styles.suggestionWhy}>
                {s.urgent ? '⚠ ' : '💡 '}
                {s.why}
              </p>
              <button
                type="button"
                className={styles.suggestionBtn}
                disabled={busy}
                onClick={() => setOpenCardId(s.cardId)}
              >
                Mở thẻ này
              </button>
            </div>
          ))}

          {inventory.length > 0 && !dictLoaded && (
            <p className={styles.noneLine}>
              Đang tải nội dung thẻ… nếu chờ lâu, thử tải lại trang. Bạn vẫn giữ nguyên các thẻ này.
            </p>
          )}

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
                    {/* Visible affordance — without it the row is indistinguishable
                        from the read-only chips in the panels above it. */}
                    {suggestions.some((s) => s.cardId === cardId) && (
                      <span className={styles.cardFlag} title="Thẻ này đang hữu ích">★</span>
                    )}
                    <span className={styles.cardCue} aria-hidden="true">{isOpen ? '▾' : 'Dùng ▸'}</span>
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
