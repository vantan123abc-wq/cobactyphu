import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useGameStore } from '../../store/gameStore'
import { sendGameAction } from '../../network/socketClient'
import { getRoom } from '../../network/api'
import TradeOfferColumn from './TradeOfferColumn'
import styles from './TradeWindow.module.css'
import ActionNotice from './ActionNotice'

// Mirrors backend/src/domain/trade.js's own constant — no shared package
// between frontend/backend in this repo (same standing as every other
// mirrored backend constant this session — MAX_UPGRADE_LEVEL,
// HOUSE_SELLBACK_RATIO, ...).
const MAX_COUNTER_DEPTH = 5

// Verified against the real backend before writing any of this (P11-T10's
// own "do not guess proposerOffer/targetOffer" instruction) — read
// domain/trade.js, engine/trade.js, stateMachine/tradeMachine.js, AND
// infrastructure/websocket/socketServer.js's actual dispatch code, not just
// WEBSOCKET_API.md, since this task's payloads are security-sensitive
// (who's allowed to act as whom) in a way worth double-checking against the
// real wire-up rather than the doc alone:
//
// - `Trade` (domain/trade.js): { id, roomId, proposerId, targetId,
//   proposerOffer: { properties: string[], money }, targetOffer: { same },
//   status, createdAt, expiresAt, counterDepth, previousTradeId }.
//   proposerId/targetId/offer.properties[] are all PlayerGameState.id /
//   Property.id — the same id-spaces every other action this session
//   already established, not useAuth()'s user.id or board_tiles.id.
// - socketServer.js's actual dispatch (not just the doc) confirms: the
//   envelope's `playerId` is ALWAYS server-overwritten with the sender's
//   real resolved id before either transitionFn runs, for every action type
//   including trade — the client never needs to (and cannot usefully) send
//   it, same as every action already shipped this session. For
//   PROPOSE_TRADE/COUNTER_TRADE specifically, `tradeId`/`newTradeId` are
//   ALSO always server-overwritten with a fresh `crypto.randomUUID()` —
//   confirmed by reading socketServer.js's own action-construction code,
//   not inferred from the doc's "server generates a fresh id" prose alone.
//   The one id the client genuinely must supply is COUNTER_TRADE's
//   `tradeId` identifying *which* existing trade is being countered — that
//   field is not in socketServer.js's overwrite list.
// - COUNTER_TRADE flips proposer/target (engine/trade.js's counterTrade):
//   `newProposerId = existingTrade.targetId`. Since only the current
//   target may counter (tradeMachine.js's own NOT_TARGET check), *I* am
//   always that flipped proposer whenever I submit a counter — so "my
//   offer" always belongs in the new trade's `proposerOffer` slot and
//   "their offer" in `targetOffer`, identically to a fresh PROPOSE_TRADE.
//   One `submitDraft()` below handles both cases for exactly this reason.
// - Asset locking (`lockedPropertyIds`/`lockedMoneyFor` below) is a direct
//   mirror of engine/trade.js's own same-named helpers — every
//   property/money amount already offered on *either* side of *any other*
//   active trade in `gameState.pendingTrades` is unavailable, checked
//   against the same `excludeTradeId` convention (null for a fresh
//   proposal; the trade being countered, when countering, so its own
//   already-offered assets don't lock themselves out).
// - MAX_COUNTER_DEPTH check: the brief's own phrasing ("Fails if
//   counterDepth > 5") doesn't quite match the real guard
//   (`existingTrade.counterDepth >= MAX_COUNTER_DEPTH`, i.e. >= 5, not >
//   5) — a trade already at depth 5 can never be countered again; one at
//   depth 4 still can (producing depth 5). The "Mặc Cả" button below is
//   gated on the real `>=` condition, not the brief's phrasing.
//
// Trade-initiation entry point (this task's own "e.g." — a Trade button
// somewhere reasonable): added as a small opponent row in
// GameControls.jsx, not a new Lobby/roster component — no in-game player
// roster UI existed anywhere in this codebase yet, and building one from
// scratch was bigger scope than a "start a trade" entry point needed.
export default function TradeWindow() {
  const { user, session } = useAuth()
  const roomId = useGameStore((s) => s.roomState?.roomId)
  const gameState = useGameStore((s) => s.currentGameState)
  const staticBoard = useGameStore((s) => s.staticBoard)
  const lastError = useGameStore((s) => s.lastError)
  const tradeDraftTargetId = useGameStore((s) => s.tradeDraftTargetId)
  const setTradeDraftTargetId = useGameStore((s) => s.setTradeDraftTargetId)

  const [displayNames, setDisplayNames] = useState({})
  const [busy, setBusy] = useState(false)
  const [isCountering, setIsCountering] = useState(false)
  const [myOfferProperties, setMyOfferProperties] = useState([])
  const [myOfferMoney, setMyOfferMoney] = useState(0)
  const [theirOfferProperties, setTheirOfferProperties] = useState([])
  const [theirOfferMoney, setTheirOfferMoney] = useState(0)

  const me = gameState?.players.find((p) => p.playerId === user.id) ?? null
  const myTrade = (me && gameState?.pendingTrades.find((t) => t.proposerId === me.id || t.targetId === me.id)) || null

  useEffect(() => {
    if (!roomId) return
    getRoom(session.access_token, roomId)
      .then((room) => {
        const map = {}
        for (const p of room.players ?? []) map[p.playerId] = p.displayName
        setDisplayNames(map)
      })
      .catch(() => {}) // name-lookup failure is a UX nicety miss only, never blocks trading
  }, [roomId, session.access_token])

  useEffect(() => {
    setBusy(false)
  }, [gameState?.stateVersion, lastError])

  // A drafted proposal became a real trade — drop the draft flag so the
  // component falls into view mode below instead of re-showing a now-stale
  // empty editor for a target that already has a live trade.
  useEffect(() => {
    if (myTrade && tradeDraftTargetId) setTradeDraftTargetId(null)
  }, [myTrade, tradeDraftTargetId, setTradeDraftTargetId])

  // The trade this counter-draft was drafted against disappeared out from
  // under it (accepted/rejected/cancelled/expired), OR we successfully
  // submitted our counter (which creates a new trade where we are the proposer)
  // — drop back out of counter-edit mode.
  useEffect(() => {
    if (!myTrade || myTrade.targetId !== me?.id) setIsCountering(false)
  }, [myTrade, me])

  // A fresh draft target was just picked (GameControls.jsx's "Trade"
  // button) — start that draft from a clean slate, not whatever was left
  // over from an earlier aborted draft/counter.
  useEffect(() => {
    if (tradeDraftTargetId) {
      setMyOfferProperties([])
      setMyOfferMoney(0)
      setTheirOfferProperties([])
      setTheirOfferMoney(0)
    }
  }, [tradeDraftTargetId])

  if (!gameState || !staticBoard || !me) return null
  if (!myTrade && !tradeDraftTargetId) return null

  const isNewProposal = !myTrade
  const editMode = isNewProposal || isCountering

  const opponentId = myTrade ? (myTrade.proposerId === me.id ? myTrade.targetId : myTrade.proposerId) : tradeDraftTargetId
  const opponent = gameState.players.find((p) => p.id === opponentId)
  if (!opponent) return null // stale/invalid target id — nothing sane to show

  const iAmProposer = myTrade ? myTrade.proposerId === me.id : true
  const iAmTarget = myTrade ? myTrade.targetId === me.id : false

  const viewMyOffer = myTrade ? (iAmProposer ? myTrade.proposerOffer : myTrade.targetOffer) : null
  const viewTheirOffer = myTrade ? (iAmProposer ? myTrade.targetOffer : myTrade.proposerOffer) : null

  const excludeTradeId = isCountering && myTrade ? myTrade.id : null
  const locked = lockedPropertyIds(gameState.pendingTrades, excludeTradeId)
  const myAvailableMoney = me.currentBalance - lockedMoneyFor(gameState.pendingTrades, me.id, excludeTradeId)
  const theirAvailableMoney = opponent.currentBalance - lockedMoneyFor(gameState.pendingTrades, opponent.id, excludeTradeId)

  const myProperties = gameState.properties.filter((p) => p.ownerId === me.id)
  const theirProperties = gameState.properties.filter((p) => p.ownerId === opponent.id)

  const nameFor = (player) => displayNames[player?.playerId] ?? player?.playerId ?? '…'

  function toggleMyProperty(id) {
    setMyOfferProperties((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }
  function toggleTheirProperty(id) {
    setTheirOfferProperties((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  function submitDraft() {
    setBusy(true)
    const proposerOffer = { properties: myOfferProperties, money: myOfferMoney }
    const targetOffer = { properties: theirOfferProperties, money: theirOfferMoney }
    if (isNewProposal) {
      sendGameAction('PROPOSE_TRADE', { targetId: opponent.id, proposerOffer, targetOffer })
    } else {
      sendGameAction('COUNTER_TRADE', { tradeId: myTrade.id, proposerOffer, targetOffer })
    }
  }

  function startCountering() {
    // Pre-fill with the current offer, flipped to my new role, as a
    // starting point to tweak — an empty editor would make "counter" no
    // more convenient than starting an unrelated fresh proposal.
    const startingMine = iAmTarget ? myTrade.targetOffer : myTrade.proposerOffer
    const startingTheirs = iAmTarget ? myTrade.proposerOffer : myTrade.targetOffer
    setMyOfferProperties([...startingMine.properties])
    setMyOfferMoney(startingMine.money)
    setTheirOfferProperties([...startingTheirs.properties])
    setTheirOfferMoney(startingTheirs.money)
    setIsCountering(true)
  }

  function closeDraft() {
    if (isCountering) {
      setIsCountering(false)
    } else {
      setTradeDraftTargetId(null)
    }
  }

  function act(actionType) {
    setBusy(true)
    sendGameAction(actionType, { tradeId: myTrade.id })
  }

  return (
    <div className={styles.backdrop}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <div className={styles.headerText}>
            <h3 className={styles.title}>
              {editMode ? (isNewProposal ? 'Đề Xuất Giao Dịch' : 'Soạn Mặc Cả') : 'Giao Dịch'} — {nameFor(opponent)}
            </h3>
            {myTrade && (
              <span className={styles.roundBadge}>
                Vòng mặc cả: {myTrade.counterDepth}/{MAX_COUNTER_DEPTH}
              </span>
            )}
          </div>
          <button type="button" className={styles.closeButton} onClick={closeDraft} aria-label="Đóng">
            ✕
          </button>
        </div>

        <div className={styles.columns}>
          <TradeOfferColumn
            label="Đề nghị của bạn"
            playerName={nameFor(me)}
            playerBalance={me.currentBalance}
            ownedProperties={myProperties}
            staticBoard={staticBoard}
            editable={editMode}
            offeredPropertyIds={editMode ? myOfferProperties : viewMyOffer.properties}
            onToggleProperty={toggleMyProperty}
            lockedPropertyIds={locked}
            moneyValue={editMode ? myOfferMoney : viewMyOffer.money}
            onMoneyChange={setMyOfferMoney}
            maxMoney={myAvailableMoney}
          />
          <TradeOfferColumn
            label={`Yêu cầu từ ${nameFor(opponent)}`}
            playerName={nameFor(opponent)}
            playerBalance={opponent.currentBalance}
            ownedProperties={theirProperties}
            staticBoard={staticBoard}
            editable={editMode}
            offeredPropertyIds={editMode ? theirOfferProperties : viewTheirOffer.properties}
            onToggleProperty={toggleTheirProperty}
            lockedPropertyIds={locked}
            moneyValue={editMode ? theirOfferMoney : viewTheirOffer.money}
            onMoneyChange={setTheirOfferMoney}
            maxMoney={theirAvailableMoney}
          />
        </div>

        <div className={styles.actions}>
          {editMode && (
            <>
              <button type="button" className={styles.primaryButton} disabled={busy} onClick={submitDraft}>
                {isNewProposal ? 'Đề Xuất' : 'Gửi Mặc Cả'}
              </button>
              <button type="button" className={styles.secondaryButton} disabled={busy} onClick={closeDraft}>
                Hủy
              </button>
            </>
          )}

          {!editMode && iAmTarget && (
            <>
              <button type="button" className={styles.primaryButton} disabled={busy} onClick={() => act('ACCEPT_TRADE')}>
                Đồng Ý
              </button>
              {myTrade.counterDepth < MAX_COUNTER_DEPTH && (
                <button type="button" className={styles.secondaryButton} disabled={busy} onClick={startCountering}>
                  Mặc Cả
                </button>
              )}
              <button type="button" className={styles.dangerButton} disabled={busy} onClick={() => act('REJECT_TRADE')}>
                Từ Chối
              </button>
            </>
          )}

          {!editMode && iAmProposer && (
            <button type="button" className={styles.dangerButton} disabled={busy} onClick={() => act('CANCEL_TRADE')}>
              Hủy Đề Xuất
            </button>
          )}
        </div>

        {myTrade && <p className={styles.expiry}>Hết hạn lúc: {new Date(myTrade.expiresAt).toLocaleTimeString('vi-VN')}</p>}

        {lastError && (
          <ActionNotice error={lastError} />
        )}
      </div>
    </div>
  )
}

/** Mirrors engine/trade.js's own lockedPropertyIds exactly. */
function lockedPropertyIds(pendingTrades, excludeTradeId) {
  const locked = new Set()
  for (const trade of pendingTrades) {
    if (trade.id === excludeTradeId) continue
    for (const id of trade.proposerOffer.properties) locked.add(id)
    for (const id of trade.targetOffer.properties) locked.add(id)
  }
  return locked
}

/** Mirrors engine/trade.js's own lockedMoneyFor exactly. */
function lockedMoneyFor(pendingTrades, playerId, excludeTradeId) {
  let total = 0
  for (const trade of pendingTrades) {
    if (trade.id === excludeTradeId) continue
    if (trade.proposerId === playerId) total += trade.proposerOffer.money
    if (trade.targetId === playerId) total += trade.targetOffer.money
  }
  return total
}
