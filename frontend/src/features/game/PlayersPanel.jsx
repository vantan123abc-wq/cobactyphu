import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useGameStore } from '../../store/gameStore'
import { getRoom } from '../../network/api'
import { playerColor, playerInitial, GROUP_COLORS } from '../board/tileVisuals'
import { zodiacEmoji } from '../board/zodiac'
import TileIcon from '../board/TileIcon'
import { playerNetWorth } from './netWorthMirror'
import { TRANSACTION_ICON } from './ledgerFormat'
import { MOVEMENT_CARDS, cardLabel, HIDDEN_CARD } from './movementCards'
import styles from './PlayersPanel.module.css'

// How long a floating money-change indicator stays on screen. Deliberately
// slow (2.4s) — the request was for it to rise "chầm chậm" so every player,
// not just the one whose balance moved, has time to register what happened.
const MONEY_FLOAT_MS = 2400

// Left sidebar player list (GameView redesign, 2026-08-22) — supersedes
// PlayerHud.jsx's split "my corner card" / "opponent rail" fixed overlays
// with one unified vertical list, matching the reference mockup's layout.
// Same independent GET /api/v1/rooms/:id display-name fetch pattern
// GameControls.jsx/FlashAuction.jsx/PropertyManager.jsx already each use on
// their own (gameState.players carries no displayName field at all — see
// any of those files' own header for the full reasoning).
export default function PlayersPanel() {
  const { user, session } = useAuth()
  const roomId = useGameStore((s) => s.roomState?.roomId)
  const gameState = useGameStore((s) => s.currentGameState)
  const offlinePlayerIds = useGameStore((s) => s.offlinePlayerIds)
  const staticBoard = useGameStore((s) => s.staticBoard)

  const transactions = useGameStore((s) => s.transactions)
  const stateVersion = useGameStore((s) => s.stateVersion)

  const [displayNames, setDisplayNames] = useState({})

  useEffect(() => {
    if (!roomId) return
    getRoom(session.access_token, roomId)
      .then((room) => {
        const map = {}
        for (const p of room.players ?? []) map[p.playerId] = p.displayName
        setDisplayNames(map)
      })
      .catch(() => {}) // a name-lookup failure is a UX nicety miss only, never blocks gameplay — same posture every sibling component's own identical fetch already takes
  }, [roomId, session.access_token])

  // Floating money-change indicators (2026-08-25, user request: "khi bị trừ
  // tiền hoặc gì thì hiển thị chầm chậm biểu tượng trừ tiền để người chơi
  // cũng như người chơi khác biết"). This also answers the tax half of the
  // same request — landing on a tax tile now visibly shows the amount taken,
  // instead of the balance silently dropping with only the collapsed Ledger
  // recording why.
  //
  // Driven by the store's raw `transactions` batch, which is exactly "what
  // this one broadcast just caused" and uses `fromGamePlayerId`/
  // `toGamePlayerId` — already PlayerGameState.id, the same id space these
  // cards key on, so no translation is needed (the id-space trap finding #36
  // was made of). Every client receives the same batch, so a deduction is
  // visible to the whole table, not just to the player who paid.
  //
  // Netted per player rather than one indicator per transaction: a single
  // action can produce several movements involving the same player (a trade
  // paying both ways, an auction settlement plus Near-Miss rewards), and
  // three overlapping bubbles on one card would be unreadable.
  const [moneyFloats, setMoneyFloats] = useState([])
  const seenVersionRef = useRef(null)

  useEffect(() => {
    if (stateVersion == null || seenVersionRef.current === stateVersion) return
    seenVersionRef.current = stateVersion
    if (!transactions?.length) return

    const born = Date.now()
    const fresh = []
    
    // We do NOT net transactions anymore based on user feedback.
    // They want ALL transactions from ALL sources to be clearly displayed.
    // Since .moneyFloatLayer is a flex column, multiple bubbles will stack neatly.
    let index = 0
    for (const t of transactions) {
      if (t.transactionType === 'initial_balance') continue
      
      if (t.fromGamePlayerId) {
        fresh.push({
          id: `${stateVersion}:${t.fromGamePlayerId}:loss:${index}`,
          playerId: t.fromGamePlayerId,
          amount: -t.amount,
          type: t.transactionType,
          born
        })
      }
      
      if (t.toGamePlayerId) {
        fresh.push({
          id: `${stateVersion}:${t.toGamePlayerId}:gain:${index}`,
          playerId: t.toGamePlayerId,
          amount: t.amount,
          type: t.transactionType,
          born
        })
      }
      index++
    }

    if (fresh.length) setMoneyFloats((current) => [...current, ...fresh])
  }, [stateVersion, transactions])

  // Prunes by age rather than by a per-item timer. A per-item timeout
  // registered inside the effect above would be cancelled by that effect's
  // own cleanup on the very next broadcast, leaving those bubbles on screen
  // forever; re-arming a single sweep here on every change to the list, and
  // filtering on real elapsed time, is correct regardless of how fast
  // broadcasts arrive. Ends naturally: an empty list schedules nothing.
  useEffect(() => {
    if (moneyFloats.length === 0) return
    const timer = setTimeout(
      () => setMoneyFloats((current) => current.filter((f) => Date.now() - f.born < MONEY_FLOAT_MS)),
      MONEY_FLOAT_MS
    )
    return () => clearTimeout(timer)
  }, [moneyFloats])

  if (!gameState) return null

  const realPlayers = gameState.players.filter((p) => !p.isBank)
  const nameFor = (p) => (p.playerId === user.id ? 'Bạn' : (displayNames[p.playerId] ?? p.playerId ?? '…'))

  // Live standings (2026-08-25, user request: "dựa vào số tiền hiện tại để
  // xếp ai ở vị trí cao nhất, ai nhiều tiền + tính giá trị bất động sản và
  // nhà cao nhất thì xếp hạng cao nhất"). Total wealth, not cash alone —
  // netWorthMirror.js reproduces engine/netWorth.js exactly, which is also
  // what gameEndMachine.js's rankPlayers() uses to decide the real winner,
  // so this board and the final result can never disagree about who is
  // ahead.
  //
  // Bankrupt players are forced to the bottom regardless of the number: a
  // knocked-out player sitting at 0 must never outrank a live player who
  // also happens to be at 0.
  const standings = realPlayers
    .map((p) => ({ player: p, worth: playerNetWorth(gameState, staticBoard, p) }))
    .sort((a, b) => {
      if (a.player.bankrupt !== b.player.bankrupt) return a.player.bankrupt ? 1 : -1
      return b.worth - a.worth
    })

  const tileFor = (p) => staticBoard?.tiles?.find((t) => t.position === p.currentPosition) ?? null

  // Per-player held card effects (2026-08-23, user request: "thẻ được cá
  // nhân nắm giữ hiển thị ở ô cá nhân cho bản thân người giữ thấy và người
  // khác cũng thấy"). Built for EVERY player's card below, not just the
  // local one — that visible-to-opponents part is the point: a rival
  // holding a Get-Out-Of-Jail card or a pending discount is real
  // information the table should be able to play around.
  //
  // Straight off PlayerGameState — every field here is already broadcast to
  // all clients inside the normal S2C_STATE_UPDATE gameState, so this
  // needed no backend change. See domain/gameState.js for each field's own
  // lifetime; all three are held indefinitely until consumed (they are NOT
  // round-scoped, unlike RoundEffectsBar's global modifiers), so "một lần"
  // below means one use, not one round.
  const heldEffects = (p) => {
    const held = []
    if (p.jailFreeCards > 0) {
      held.push({
        key: 'jail',
        icon: '🎫',
        text: p.jailFreeCards > 1 ? `Ra tù ×${p.jailFreeCards}` : 'Ra tù',
        title: `Thẻ Ra Tù Miễn Phí — dùng được ${p.jailFreeCards} lần`,
      })
    }
    if (p.nextBuildDiscount > 0) {
      held.push({
        key: 'build',
        icon: '🧱',
        text: `-$${p.nextBuildDiscount} xây`,
        title: `Giảm $${p.nextBuildDiscount} cho lần xây nhà tiếp theo (dùng một lần)`,
      })
    }
    if (p.nextRentDiscount) {
      held.push({
        key: 'rent',
        icon: '🏠',
        text: `-${p.nextRentDiscount.percent}% thuê`,
        title: `Giảm ${p.nextRentDiscount.percent}% tiền thuê phải trả lần tới, tối đa $${p.nextRentDiscount.max} (dùng một lần)`,
      })
    }
    return held
  }

  // ASYMMETRIC's own hand row (2026-09-03) — same "every player's card here,
  // visible to the whole table" reasoning heldEffects() just above already
  // established for jailFreeCards/nextBuildDiscount/nextRentDiscount, but for
  // movementHand specifically the CONTENT is usually secret: an opponent's
  // array already arrives pre-redacted by the server (engine/
  // stateRedaction.js's maskGameState — real cardIds for MY OWN hand, or for
  // anyone DENIAL has revealed to ME; HIDDEN_CARD sentinels otherwise), so
  // this only ever renders what this client was actually sent — there is no
  // separate "is this revealed to me" check needed here, the array's own
  // per-slot values already say so directly. Array LENGTH is never redacted
  // either way (movementHand.length still reads correctly for a face-down
  // hand), which is exactly what lets a face-down row still show the right
  // number of card backs.
  const handChips = (p) => {
    const hand = p.movementHand ?? []
    const isMine = p.playerId === user.id
    return hand.map((cardId, i) => {
      const isHidden = cardId === HIDDEN_CARD
      return {
        key: `${p.id}-hand-${i}`,
        hidden: isHidden,
        // A real cardId on someone else's row can ONLY mean DENIAL revealed
        // it to me (backend never sends my own opponent's real hand any
        // other way) — flagged distinctly so it reads as "camera Thượng
        // Lưu", not confused with a normal own-hand display.
        revealedByDenial: !isMine && !isHidden,
        label: isHidden ? '🂠' : cardLabel(cardId),
        title: isHidden ? 'Thẻ di chuyển (úp)' : (MOVEMENT_CARDS[cardId]?.description ?? cardId),
      }
    })
  }

  return (
    <div className={styles.panel}>
      <h2 className={styles.heading}>Người Chơi</h2>
      <div className={styles.list}>
        {standings.map(({ player: p, worth }, index) => {
          const isTurn = p.turnOrder === gameState.currentTurnIndex
          const ownedProps = gameState.properties.filter((prop) => prop.ownerId === p.id)
          const held = heldEffects(p)
          const standingTile = tileFor(p)
          const floats = moneyFloats.filter((f) => f.playerId === p.id)

          // Map to static board tiles to get colors and names
          const ownedTiles = ownedProps
            .map((prop) => staticBoard?.tiles?.find((t) => t.id === prop.boardTileId))
            .filter(Boolean)
            // Sort by groupId so properties of the same color are together
            .sort((a, b) => (a.groupId || '').localeCompare(b.groupId || ''))

          return (
            <div key={p.id} className={`${styles.card} ${isTurn ? styles.active : ''}`} style={{ borderLeftColor: playerColor(p) }}>
              {/* Floating money-change bubbles. Absolutely positioned over
                  the card by .moneyFloatLayer, so they never reflow the
                  row while animating. */}
              {floats.length > 0 && (
                <div className={styles.moneyFloatLayer} aria-hidden="true">
                  {floats.map((f) => (
                    <span key={f.id} className={f.amount > 0 ? styles.moneyFloatGain : styles.moneyFloatLoss}>
                      {f.type && TRANSACTION_ICON[f.type] ? `${TRANSACTION_ICON[f.type]} ` : ''}
                      {f.amount > 0 ? '+' : '−'}${Math.abs(f.amount)}
                    </span>
                  ))}
                </div>
              )}

              <div className={styles.cardHeader}>
                {isTurn && <span className={styles.turnBadge}>Lượt Này</span>}
                {/* Live standing by total wealth — #1 gets the crown. */}
                <span
                  className={`${styles.rankBadge} ${index === 0 && !p.bankrupt ? styles.rankLeader : ''}`}
                  title={`Hạng ${index + 1} — tổng tài sản $${worth} (tiền mặt + đất + nhà)`}
                >
                  {index === 0 && !p.bankrupt ? '👑' : `#${index + 1}`}
                </span>
                <span className={styles.avatar} style={{ background: playerColor(p) }}>
                  {zodiacEmoji(p.zodiac) ?? playerInitial(p)}
                </span>
                <div className={styles.info}>
                  <span className={styles.name}>
                    {nameFor(p)}
                    {offlinePlayerIds.includes(p.playerId) && (
                      <span className={styles.offlineDot} title="Mất kết nối">
                        ●
                      </span>
                    )}
                  </span>
                  <span className={styles.stats}>
                    <span className={styles.propsCount}>Tài sản: {ownedProps.length}</span>
                    {p.inventory?.length > 0 && <span className={styles.cardsCount} title="Thẻ đang giữ">🎴 {p.inventory.length}</span>}
                    <span className={styles.balance}>${p.currentBalance}</span>
                  </span>
                  {/* Total wealth is what the ranking above is actually
                      sorted on, so it is shown rather than left implicit in
                      a tooltip — cash alone would make the order look wrong
                      to anyone holding a lot of property. */}
                  <span className={styles.netWorthLine} title="Tiền mặt + giá trị đất + nhà đã xây">
                    Tổng tài sản: <strong>${worth}</strong>
                  </span>
                </div>
              </div>

              {/* Where this player is standing right now. */}
              <div className={styles.currentTile}>
                {p.inJail ? (
                  <>
                    <span className={styles.currentTileIcon}>🚔</span>
                    <span className={styles.currentTileName}>Đang ngồi tù ({p.jailTurns}/3)</span>
                  </>
                ) : standingTile ? (
                  <>
                    <TileIcon type={standingTile.tileType} className={styles.currentTileIcon} />
                    <span className={styles.currentTileName}>{standingTile.name}</span>
                  </>
                ) : (
                  <span className={styles.currentTileName}>—</span>
                )}
              </div>

              {held.length > 0 && (
                <div className={styles.heldEffects}>
                  {held.map((h) => (
                    <span key={h.key} className={styles.heldChip} title={h.title}>
                      <span className={styles.heldIcon}>{h.icon}</span>
                      {h.text}
                    </span>
                  ))}
                </div>
              )}

              {gameState.ruleset === 'ASYMMETRIC' && p.movementHand?.length > 0 && (
                <div className={styles.handRow}>
                  {handChips(p).map((c) => (
                    <span
                      key={c.key}
                      className={c.revealedByDenial ? `${styles.handChip} ${styles.handChipRevealed}` : styles.handChip}
                      title={c.revealedByDenial ? `${c.title} — bị lộ do Thượng Lưu` : c.title}
                    >
                      {c.revealedByDenial && '🔍 '}
                      {c.label}
                    </span>
                  ))}
                </div>
              )}

              {ownedTiles.length > 0 && (
                <div className={styles.ownedProperties}>
                  {ownedTiles.map((t) => {
                    const bg = GROUP_COLORS[t.groupId]
                    const isTransport = t.tileType === 'transport'
                    const isUtility = t.tileType === 'utility'
                    
                    let cls = styles.propertyDot
                    if (isTransport) cls += ` ${styles.transport}`
                    if (isUtility) cls += ` ${styles.utility}`

                    return (
                      <div 
                        key={t.id} 
                        className={cls}
                        style={bg ? { background: bg } : undefined}
                        title={t.name}
                      >
                        {isTransport ? '🚂' : isUtility ? '💡' : ''}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
