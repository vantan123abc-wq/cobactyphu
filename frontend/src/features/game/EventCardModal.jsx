import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useGameStore } from '../../store/gameStore'
import { sendGameAction } from '../../network/socketClient'
import { getEventCards, getRoom } from '../../network/api'
import { CHANCE_FORTUNE_COLOR, GROUP_COLORS } from '../board/tileVisuals'
import TileIcon from '../board/TileIcon'
import styles from './EventCardModal.module.css'
import ActionNotice from './ActionNotice'

// Verified against the real backend before writing this (P11-T11's own
// instruction) — and this verification pass turned up a real architecture
// gap the brief's own questions didn't anticipate, not just wrong
// names/paths:
//
// - There is no DRAW_CARD or ACKNOWLEDGE_EVENT action anywhere in this
//   codebase — turnMachine.js's DRAWING_CARD phase is never something a
//   client ever actually observes. Landing on a chance/fortune tile draws
//   and resolves the card synchronously, inside whatever action caused the
//   landing (ROLL_DICE, or a jail-escape ATTEMPT_JAIL_ROLL) — by the time a
//   client sees the resulting S2C_STATE_UPDATE, an INSTANT card's effect
//   has already fully happened and the phase has already moved on to
//   POST_ACTIONS. VALID_ACTIONS_BY_PHASE (turnMachine.js) has no
//   'DRAWING_CARD' entry at all, confirming nothing ever waits there.
// - `MAKE_EVENT_CHOICE`'s `optionId`/`payload` shape (WEBSOCKET_API.md §1)
//   was correct as documented. Its `probabilityRoll` field is documented as
//   "server-generated in production, never client-supplied" — true again as
//   of finding #27's resolution (docs/PROJECT_STATUS.md, 2026-08-19):
//   socketServer.js now injects a real one itself whenever the chosen
//   option actually has a PROBABILITY intent, so chooseOption() below only
//   ever sends optionId. Same is true of `dieFaceRoll` as of 2026-08-22
//   (C05/C11's own die-face reward tables).
//
// Real card content, wired 2026-08-21: fetched here via getEventCards()
// rather than a hand-maintained frontend mirror (the deleted
// `eventCardDictionary.js`, whose own header flagged the exact drift risk
// this replaces). `gameState.lastDrawnEventCardId` (set for INSTANT draws
// too, not just pendingEventCardId's CHOICE-only case — see turnMachine.js's
// resolveDrawingCard) is what lets an instant card show real text at all.
//
// Reveal-to-everyone rework (2026-08-22, user request): both
// gameState.pendingEventCardId and .lastDrawnEventCardId already reach
// EVERY connected client via the normal S2C_STATE_UPDATE broadcast — the
// old `isMyTurn`/`myEventTransactions`-only visibility gates were purely a
// frontend display choice, not a real data-availability limit, so widening
// them needed no backend/protocol change. The drawing player is always the
// current-turn player (see this file's own note above). The *choice
// buttons* stay restricted to the real acting player — only visibility was
// widened, never who can act.
//
// Big centre-screen card rework (2026-08-23, user request: "hiển thị mở thẻ
// động to ngay giữa màn hình cho người chơi cũng như người chơi khác thấy
// được là bốc trúng thẻ gì"):
//   - Both the CHOICE modal (was a 380px bottom-docked panel) and the
//     INSTANT notice (was a small top-corner toast) are now the same large,
//     dead-centre playing card. This deliberately reverses the bottom-dock
//     part of the 2026-08-22 "don't hide the board" pass for THIS component
//     only — the user has now explicitly asked for the opposite here. The
//     backdrop stays translucent + blurred rather than opaque, so the board
//     is still legible around the card; the other three modals that pass
//     changed (FlashAuction/TradeWindow/RentRiskChoice) are untouched.
//   - The flip is now a genuine two-sided card: a real printed card *back*
//     rotates away to reveal the face, replacing that pass's own
//     deliberately-simplified one-sided `rotateY` + backface-visibility
//     reveal (flagged as a simplification at the time; this closes it).
//   - An INSTANT card blocks nothing (its effect already resolved and the
//     acting player still needs to reach End Turn), so its backdrop is
//     click-through and it auto-dismisses. A CHOICE card genuinely does
//     block — the turn is waiting on it — so that one keeps a real modal
//     backdrop and no timer.
const INSTANT_CARD_VISIBLE_MS = 5000

// Cơ Hội vs Khí Vận is a real distinction to a player but NOT a field on
// the card: backend/src/domain/eventDictionary.js has one shared EVENT_CARDS
// map and turnMachine.js draws from one shared `gameState.eventDeck` for
// both tile types (the deck-membership split is a known, separately-flagged
// backend gap — docs/PROJECT_STATUS.md). Derived here from the tile the
// drawer is actually standing on, which is real and correct at draw time.
//
// KNOWN LIMIT, flagged rather than papered over: a card that MOVES the
// drawer (C01 Lối Tắt / C02 Chuyến Đi May Mắn) has already changed their
// position by the time the post-resolution notice renders, so the deck can
// no longer be derived and falls back to the neutral "Thẻ Sự Kiện" label
// below — never to a guessed one.
const DECK_LABEL = { chance: 'Cơ Hội', fortune: 'Khí Vận' }

export default function EventCardModal() {
  const { user, session } = useAuth()
  const roomId = useGameStore((s) => s.roomState?.roomId)
  const gameState = useGameStore((s) => s.currentGameState)
  const staticBoard = useGameStore((s) => s.staticBoard)
  const transactions = useGameStore((s) => s.transactions)
  const lastError = useGameStore((s) => s.lastError)

  const [busy, setBusy] = useState(false)
  const [dismissedDrawKey, setDismissedDrawKey] = useState(null)
  const [cards, setCards] = useState({})
  const [displayNames, setDisplayNames] = useState({})

  useEffect(() => {
    getEventCards(session.access_token)
      .then((data) => setCards(data.cards ?? {}))
      .catch(() => {}) // a fetch failure just means real card text stays unavailable — the fallback copy below still works
  }, [session.access_token])

  useEffect(() => {
    if (!roomId) return
    getRoom(session.access_token, roomId)
      .then((room) => {
        const map = {}
        for (const p of room.players ?? []) map[p.playerId] = p.displayName
        setDisplayNames(map)
      })
      .catch(() => {}) // a name-lookup failure is a UX nicety miss only, never blocks the card's own real content
  }, [roomId, session.access_token])

  useEffect(() => {
    setBusy(false)
  }, [gameState?.stateVersion, lastError])

  // Computed with optional chaining ahead of the `!gameState` early return
  // below, because the auto-dismiss effect that follows is a hook and hooks
  // can't sit after a conditional return (React's rules-of-hooks — a real
  // violation of exactly this shape was found by lint in GameBoard.jsx and
  // LobbyDiagnostic.jsx on 2026-08-22, so it's a live hazard in this repo,
  // not a theoretical one).
  const isChoicePending = gameState?.phase === 'AWAITING_EVENT_CHOICE' && !!gameState?.pendingEventCardId
  const hasInstantCard = gameState != null && !isChoicePending && gameState.lastDrawnEventCardId != null

  // Bug fix 2026-08-23 (real user report: after a Cơ Hội/Khí Vận draw, the
  // card kept popping back up over and over for the rest of the match).
  // This used to key dismissal off gameState.stateVersion, but stateVersion
  // bumps on EVERY action anyone takes (idempotency.js), not just draws,
  // while lastDrawnEventCardId is a sticky "last known" field that's never
  // cleared (domain/gameState.js) — so any later unrelated action made the
  // same already-dismissed draw look "new" again. lastDrawnEventCardSeq
  // only increments inside resolveDrawingCard() on an actual draw (even a
  // repeat of the same card id), so it's the real "new draw" signal.
  // pendingEventCardId itself is a fine key for the CHOICE case — it's
  // already a real pending flag, cleared the instant the choice resolves.
  const drawKey = isChoicePending
    ? `choice:${gameState.pendingEventCardId}`
    : hasInstantCard
      ? `instant:${gameState.lastDrawnEventCardSeq}`
      : null
  const showInstantCard = hasInstantCard && dismissedDrawKey !== drawKey

  useEffect(() => {
    if (!showInstantCard || drawKey == null) return
    const timer = setTimeout(() => setDismissedDrawKey(drawKey), INSTANT_CARD_VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [showInstantCard, drawKey])

  // Safety net for the flip-reveal animation below (2026-08-23, real user
  // report — a screenshot showing the card frozen mid-flip, on its own
  // BACK face, indefinitely). `.flipper`'s own `cardDealAndFlip` keyframes
  // are a decorative CSS animation with no JS involvement once started —
  // if the tab was backgrounded when the draw happened (browsers routinely
  // pause/throttle animations in hidden tabs), or the animation is
  // otherwise interrupted, nothing ever drives it forward again on its
  // own, and it can sit stuck on an intermediate frame forever. That's a
  // cosmetic annoyance for an INSTANT card's toast, but a genuine game-
  // blocking bug for a CHOICE card: the option buttons live inside `.face`,
  // and a stuck `.back` frame leaves them permanently unreachable — nobody
  // else can act until this exact player's choice resolves.
  //
  // This timer runs on real wall-clock time (setTimeout), independent of
  // whether the CSS animation itself is actually progressing, and forces
  // `.flipper` to its own guaranteed-correct end state (`.settled` below)
  // shortly after the animation's own declared 1s duration — so even a
  // fully stuck animation resolves to a normal, interactive card within
  // about a second, never indefinitely. Keyed by drawKey (not stateVersion
  // — see its own comment above) so a genuinely new draw/choice resets it
  // and the flip gets to play again, but an unrelated action elsewhere in
  // the match doesn't restart the flip on an already-settled card that's
  // still on screen.
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    setSettled(false)
    if (drawKey == null) return
    const timer = setTimeout(() => setSettled(true), 1100)
    return () => clearTimeout(timer)
  }, [drawKey])

  if (!gameState) return null
  if (!isChoicePending && !showInstantCard) return null

  const me = gameState.players.find((p) => p.playerId === user.id)
  const isMyTurn = me != null && me.turnOrder === gameState.currentTurnIndex
  const drawer = gameState.players.find((p) => !p.isBank && p.turnOrder === gameState.currentTurnIndex)
  const nameFor = (player) => displayNames[player?.playerId] ?? player?.playerId ?? '…'
  const drawerLabel = isMyTurn ? 'Bạn' : nameFor(drawer)

  const drawerTile = staticBoard?.tiles?.find((t) => t.position === drawer?.currentPosition)
  const deck = drawerTile?.tileType === 'chance' || drawerTile?.tileType === 'fortune' ? drawerTile.tileType : null
  const deckLabel = DECK_LABEL[deck] ?? 'Thẻ Sự Kiện'
  const deckColor = CHANCE_FORTUNE_COLOR[deck] ?? '#b8912f' // the Trống Đồng bronze (CenterBoardArea.module.css) — a neutral that still belongs to this board's palette

  // `transactions` is the store's own one-shot "what this broadcast just
  // caused" batch (gameStore.js's setGameState replaces it every update,
  // never accumulates) — no id/player filter needed to avoid stale entries
  // from a prior action leaking in here.
  const eventTransactions = transactions.filter((t) => t.transactionType === 'event_card')

  // Destination preview for a MOVE_RELATIVE option (2026-08-23, user
  // report: C01 "Lối Tắt" offered "Tiến 1/2/3 ô" with no way to know what
  // any of those tiles actually WERE — an uninformed choice by design flaw,
  // not by the card's own intent). `option.intents` is already present on
  // the real card data GET /api/v1/event-cards returns (the same object
  // resolveChoice() itself reads server-side) — no new endpoint/field
  // needed, just reading what was already on the wire but never surfaced.
  // `staticBoard.tiles.length` is this board's real size (36/44,
  // movement.js's own two locked sizes) — the same wraparound
  // movePlayer()/moveByStepsAndResolve() (turnMachine.js) use for real.
  function moveDestinationTile(option) {
    if (!staticBoard?.tiles?.length || drawer == null) return null
    const moveIntent = option.intents?.find((i) => i.action === 'MOVE_RELATIVE')
    if (!moveIntent) return null
    const destPosition = (drawer.currentPosition + moveIntent.steps) % staticBoard.tiles.length
    return staticBoard.tiles.find((t) => t.position === destPosition) ?? null
  }

  // Deliberately NOT the exact rent/tax the drawer would pay if they land
  // there — PropertyManager.jsx's own rent-table comment already
  // establishes why this app never recomputes a real financial amount on
  // the frontend for display only (risk of silently drifting from the real
  // server-computed figure): ownership status + the tile's own printed
  // price/tax are real, static facts; an exact rent owed would need
  // calculateRent.js's full group-bonus/upgrade-level logic duplicated
  // here just to preview it.
  function tilePreviewLabel(tile) {
    if (tile.tileType === 'property' || tile.tileType === 'transport' || tile.tileType === 'utility') {
      const property = gameState.properties.find((p) => p.boardTileId === tile.id)
      const owner = property?.ownerId ? gameState.players.find((p) => p.id === property.ownerId) : null
      if (owner) return `${tile.name} — chủ: ${owner.id === drawer?.id ? 'bạn' : nameFor(owner)}`
      return typeof tile.price === 'number' ? `${tile.name} — trống, giá $${tile.price}` : `${tile.name} — trống`
    }
    if (tile.tileType === 'tax') return `${tile.name} — nộp $${tile.taxAmount}`
    if (tile.tileType === 'chance') return `${tile.name} — rút thêm thẻ Cơ Hội`
    if (tile.tileType === 'fortune') return `${tile.name} — rút thêm thẻ Khí Vận`
    if (tile.tileType === 'go') return `${tile.name} — nhận $200`
    if (tile.tileType === 'go_to_jail') return `${tile.name} — bị bắt vào tù!`
    return tile.name
  }

  // Finding #27 (docs/PROJECT_STATUS.md), resolved 2026-08-19: probabilityRoll
  // (and dieFaceRoll, 2026-08-22) are server-generated — socketServer.js's
  // serverGeneratedFields() looks up the real card/option itself and injects
  // them whenever they're actually needed, so a client-computed value here
  // would just be discarded. This only ever sends optionId.
  // C08 "Bảo Vệ Tài Sản" (2026-08-25) is the one card whose real decision
  // isn't the option itself but WHICH property it applies to, so it's the one
  // case that adds a payload field here. Still no client-computed randomness —
  // propertyId is a genuine player choice, and the server re-validates that
  // the named property is really theirs and really unimproved.
  function chooseOption(option, propertyId) {
    setBusy(true)
    sendGameAction('MAKE_EVENT_CHOICE', { optionId: option.id, ...(propertyId ? { propertyId } : {}) })
  }

  // Mirrors turnMachine.js's own protectablePropertiesFor(): owned by me and
  // still unimproved. Improved ones are excluded because they're already
  // permanently immune to a hostile buyout, so protecting one does nothing.
  function protectableProperties() {
    return (gameState.properties ?? [])
      .filter((p) => p.ownerId === me?.id && p.upgradeLevel === 0)
      .map((p) => ({ property: p, tile: staticBoard?.tiles?.find((t) => t.id === p.boardTileId) }))
      .filter((x) => x.tile != null)
  }

  const card = cards[isChoicePending ? gameState.pendingEventCardId : gameState.lastDrawnEventCardId]

  // The card itself: a real two-sided object. `.back` is what's showing
  // when it flies in; the flip animation (EventCardModal.module.css) turns
  // it over to `.face`. Keyed by drawKey at the call site below so a
  // genuinely new draw/choice remounts this and the flip replays — the same
  // key-to-replay-an-animation technique DiceRoll.jsx already uses.
  const cardBody = (
    <div className={styles.scene} style={{ '--deck-color': deckColor }}>
      <div className={`${styles.flipper} ${settled ? styles.settled : ''}`}>
        <div className={styles.back} aria-hidden="true">
          <div className={styles.backFrame}>
            <span className={styles.backIcon}>{deck ? <TileIcon type={deck} /> : '🎴'}</span>
            <span className={styles.backWordmark}>Cờ Tỷ Phú</span>
          </div>
        </div>

        <div className={styles.face}>
          <div className={styles.faceHeader}>
            <span className={styles.faceIcon}>{deck ? <TileIcon type={deck} /> : '🎴'}</span>
            <span className={styles.deckName}>{deckLabel}</span>
          </div>

          <p className={styles.drawnBy}>{drawerLabel} vừa rút được</p>

          <div className={styles.faceBody}>
            {card ? (
              <>
                <p className={styles.cardText}>{card.text}</p>
                {!isChoicePending && card.type === 'CHOICE' && gameState?.lastRoll && card.options?.some(o => o.intents?.some(i => i.action === 'DIE_FACE_REWARD')) && (
                  <div style={{ marginTop: '16px', padding: '12px', background: 'rgba(0,0,0,0.2)', borderRadius: '8px', textAlign: 'center' }}>
                    <div style={{ fontWeight: 'bold', fontSize: '1.2em', marginBottom: '8px' }}>
                      Kết quả tung xúc xắc: {gameState.lastRoll.total}
                    </div>
                    {(() => {
                      const gained = eventTransactions.filter(t => t.toPlayerId === me?.id).reduce((sum, t) => sum + t.amount, 0);
                      const lost = eventTransactions.filter(t => t.fromPlayerId === me?.id).reduce((sum, t) => sum + t.amount, 0);
                      const net = gained - lost;
                      if (net > 0) return <div style={{ color: '#4ade80', fontWeight: 'bold' }}>Bạn nhận được: ${net}</div>;
                      if (net < 0) return <div style={{ color: '#f87171', fontWeight: 'bold' }}>Bạn bị trừ: ${-net}</div>;
                      return <div style={{ color: '#9ca3af' }}>Không nhận được thêm tiền!</div>;
                    })()}
                  </div>
                )}
              </>
            ) : Object.keys(cards).length === 0 ? (
              <p className={styles.unknownCard}>Đang tải nội dung lá bài…</p>
            ) : (
              <p className={styles.unknownCard}>
                Không có dữ liệu hiển thị cho lá bài này (id:{' '}
                {isChoicePending ? gameState.pendingEventCardId : gameState.lastDrawnEventCardId}).
              </p>
            )}

            {/* A `keepable` card (Card Inventory system) did NOT take effect
                on this draw — it went into the drawer's hand to be played
                later via USE_INVENTORY_CARD. Without this line the notice
                showed only the card's own text ("Lần xây dựng tiếp theo của
                bạn được giảm $50"), which reads as a done deal and is simply
                false at this moment — a real user-reported confusion,
                2026-09-01. `keepable` is already on the wire from
                GET /api/v1/event-cards (the endpoint returns EVENT_CARDS
                verbatim), so this needs no new field. */}
            {!isChoicePending && card?.keepable && (
              <p className={styles.keptLine}>
                🎴 Thẻ đã được cất vào <strong>Kho Thẻ</strong> của {drawerLabel.toLowerCase() === 'bạn' ? 'bạn' : drawerLabel} — chưa
                có hiệu lực, dùng khi cần.
              </p>
            )}

            {/* Money actually moved by this draw — only meaningful once the
                card has resolved, so never on a still-pending CHOICE. */}
            {!isChoicePending && eventTransactions.length > 0 && (
              <div className={styles.amounts}>
                {eventTransactions.map((t) => (
                  <span key={t.idempotencyKey} className={t.toGamePlayerId === drawer?.id ? styles.gain : styles.loss}>
                    {t.toGamePlayerId === drawer?.id ? '+' : '−'}${t.amount}
                  </span>
                ))}
              </div>
            )}
          </div>

          {isChoicePending && card?.options && (
            isMyTurn ? (
              <div className={styles.options}>
                {card.options.flatMap((option) => {
                  // C08: expand the single "protect a property" option into
                  // one button per eligible property — the property IS the
                  // choice, and the static options array can't enumerate a
                  // player's live holdings.
                  if ((option.intents ?? []).some((i) => i.action === 'GRANT_PROPERTY_PROTECTION')) {
                    return protectableProperties().map(({ property, tile }) => {
                      const color = GROUP_COLORS[tile.groupId] ?? CHANCE_FORTUNE_COLOR[tile.tileType]
                      return (
                        <button
                          key={property.id}
                          type="button"
                          className={styles.optionButton}
                          disabled={busy}
                          onClick={() => chooseOption(option, property.id)}
                        >
                          <span className={styles.optionText}>Bảo vệ {tile.name}</span>
                          <span className={styles.optionPreview} style={color ? { '--preview-color': color } : undefined}>
                            <TileIcon type={tile.tileType} className={styles.optionPreviewIcon} />
                            {/* The name is already in the label above — this chip carries
                                the one extra fact worth knowing when choosing: how much
                                a rival would have to pay to seize it (2× its price). */}
                            {typeof tile.price === 'number' ? `Cưỡng đoạt tốn $${tile.price * 2}` : 'Chưa xây nhà'}
                          </span>
                        </button>
                      )
                    })
                  }

                  const insufficientBalance = option.validation != null && me.currentBalance < option.validation.amount
                  const destTile = moveDestinationTile(option)
                  const previewColor = destTile ? (GROUP_COLORS[destTile.groupId] ?? CHANCE_FORTUNE_COLOR[destTile.tileType]) : null
                  return (
                    <button
                      key={option.id}
                      type="button"
                      className={styles.optionButton}
                      disabled={busy || insufficientBalance}
                      title={insufficientBalance ? 'Không đủ tiền' : undefined}
                      onClick={() => chooseOption(option)}
                    >
                      <span className={styles.optionText}>{option.text}</span>
                      {destTile && (
                        <span className={styles.optionPreview} style={previewColor ? { '--preview-color': previewColor } : undefined}>
                          <TileIcon type={destTile.tileType} className={styles.optionPreviewIcon} />
                          {tilePreviewLabel(destTile)}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            ) : (
              <p className={styles.waitingLine}>Đang chờ {drawerLabel} chọn…</p>
            )
          )}

          {isChoicePending && isMyTurn && lastError && (
            <ActionNotice error={lastError} />
          )}

          {!isChoicePending && (
            <button
              type="button"
              className={styles.closeButton}
              onClick={() => setDismissedDrawKey(drawKey)}
            >
              Đóng
            </button>
          )}
        </div>
      </div>
    </div>
  )

  // A pending CHOICE genuinely halts the turn for everyone, so it gets a
  // real (still translucent) modal backdrop. A resolved INSTANT card halts
  // nothing — its backdrop is click-through so it can never sit between the
  // acting player and their own End Turn button.
  return (
    <div className={isChoicePending ? styles.backdrop : styles.backdropGhost}>
      <div key={drawKey}>{cardBody}</div>
    </div>
  )
}


