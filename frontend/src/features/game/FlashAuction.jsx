import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useGameStore } from '../../store/gameStore'
import { sendGameAction } from '../../network/socketClient'
import { getRoom } from '../../network/api'
import { GROUP_COLORS, CHANCE_FORTUNE_COLOR } from '../board/tileVisuals'
import TileIcon from '../board/TileIcon'
import ActionNotice from './ActionNotice'
import styles from './FlashAuction.module.css'

const BID_INCREMENTS = [10, 50]

// Verified against the real backend before writing this (P11-T08's own
// instruction) — the brief's guesses were wrong on two fronts:
//
// 1. Action names (turnMachine.js's VALID_ACTIONS_BY_PHASE.FLASH_AUCTION_ACTIVE,
//    WEBSOCKET_API.md §1): 'PLACE_BID' (payload `{ amount }`) was right, but
//    the fold action is 'FOLD_AUCTION' — neither of the brief's own guesses
//    ('FOLD'/'LEAVE_AUCTION') exist anywhere in this codebase. AUCTION_TIMEOUT
//    is the third legal actionType but is system-generated only (WEBSOCKET_API.md
//    §1: "A real client must never send this") — not wired to any button here.
//
// 2. AuctionState shape (engine/auction.js): currentBid/highestBidderId/
//    activeBidders/bids[] all exist as named, but there's no stored "folded"
//    list — foldBidder() just removes an id from activeBidders with no trace.
//    Folded participants are derived here as the complement of activeBidders
//    within the real (non-bank, non-bankrupt) player roster. highestBidderId
//    is looked up against that same full roster, not just activeBidders,
//    since foldBidder()'s own docstring confirms "the current highest bidder
//    may fold and still win" — a folded leader must still render as leading.
//
// activeBidders/highestBidderId/bids[].playerId are all PlayerGameState.id
// (game_players.id) — the SAME id-space GameControls.jsx/PropertyActionDrawer.jsx
// already established for turnOrder/currentPosition comparisons, NOT
// useAuth()'s user.id (profiles.id). `me.id`, not `user.id`, is what's
// compared against auction fields below.
//
// auction.propertyId is Property.id (the game-scoped ownership row), not a
// board_tiles id or position — unlike PropertyActionDrawer.jsx (which finds
// its tile via the player's own currentPosition), this needs the two-hop
// lookup properties.find(propertyId) -> boardTileId -> staticBoard.tiles.
export default function FlashAuction() {
  const { user, session } = useAuth()
  const roomId = useGameStore((s) => s.roomState?.roomId)
  const gameState = useGameStore((s) => s.currentGameState)
  const staticBoard = useGameStore((s) => s.staticBoard)
  const lastError = useGameStore((s) => s.lastError)

  const [displayNames, setDisplayNames] = useState({})
  const [busy, setBusy] = useState(false)
  const [confirmFold, setConfirmFold] = useState(false)

  useEffect(() => {
    if (!roomId) return
    getRoom(session.access_token, roomId)
      .then((room) => {
        const map = {}
        for (const p of room.players ?? []) map[p.playerId] = p.displayName
        setDisplayNames(map)
      })
      .catch(() => {}) // name-lookup failure is a UX nicety miss only, never blocks bidding
  }, [roomId, session.access_token])

  useEffect(() => {
    setBusy(false)
    // Disarm the fold confirmation too: any state change can have moved the
    // ground under it (someone outbid me, a rival folded and left me alone),
    // and a warning that describes the previous position is worse than none.
    setConfirmFold(false)
  }, [gameState?.stateVersion, lastError])

  if (!gameState || !staticBoard || gameState.phase !== 'FLASH_AUCTION_ACTIVE' || !gameState.pendingAuction) {
    return null
  }

  const auction = gameState.pendingAuction
  const me = gameState.players.find((p) => p.playerId === user.id)
  const property = gameState.properties.find((p) => p.id === auction.propertyId)
  const tile = property ? staticBoard.tiles.find((t) => t.id === property.boardTileId) : null

  // Eligibility at auction-start was "every real, non-bankrupt player"
  // (turnMachine.js's handleDeclinePurchase) and can't change mid-auction —
  // bankruptcy is only ever checked from PAYING_RENT/PAYING_TAX, neither
  // reachable while phase is FLASH_AUCTION_ACTIVE — so this roster is stable
  // for the auction's whole duration.
  const participants = gameState.players.filter((p) => !p.isBank && !p.bankrupt)
  const activeParticipants = participants.filter((p) => auction.activeBidders.includes(p.id))
  const foldedParticipants = participants.filter((p) => !auction.activeBidders.includes(p.id) && p.id !== auction.initiatorId)
  const initiator = participants.find((p) => p.id === auction.initiatorId)
  const highestBidder = participants.find((p) => p.id === auction.highestBidderId) ?? null

  const nameFor = (player) => displayNames[player?.playerId] ?? player?.playerId ?? 'Ẩn danh'
  const iAmActive = me != null && auction.activeBidders.includes(me.id)
  const iAmInitiator = me != null && auction.initiatorId === me.id
  const nextBidAmounts = BID_INCREMENTS.map((inc) => auction.currentBid + inc)

  // What folding would actually COST me right now, or null when it is the
  // harmless "I'm out, carry on" it looks like.
  //
  // Since 2026-09-01 foldBidder WITHDRAWS the folder's own bids and recomputes
  // the winner from the surviving ones, so folding while ahead throws away the
  // bid that was winning. The extreme case is real and, at a 2-player table,
  // routine: the V2 Broker rule bars the host from bidding, so the opponent is
  // the ONLY active bidder — folding there hands back a lot they had already
  // won and resolves the auction as FAILED, with nobody getting the property.
  // Measured 2026-09-02 (PROJECT_STATUS.md): 100% of settled 2-player auctions
  // are won at the minimum raise by that sole bidder, so this is the normal
  // shape of a heads-up auction, not a corner case.
  //
  // Deliberately a CONFIRM, not a disable: folding while ahead is a legal
  // action and disabling it would repeat the jail-fine bug fixed earlier the
  // same day, where the UI deleted a move the server allows.
  const iAmLeading = me != null && auction.highestBidderId === me.id
  const iAmSoleBidder = auction.activeBidders.length === 1 && iAmActive
  const foldCost = !iAmLeading
    ? null
    : iAmSoleBidder
      ? `Bạn đang là người trả giá DUY NHẤT và đang thắng ở $${auction.currentBid}. Bỏ cuộc sẽ rút lại giá đã đặt, phiên đấu giá thất bại và KHÔNG AI nhận được ô đất. Nếu muốn thắng, chỉ cần chờ hết giờ.`
      : `Bạn đang dẫn đầu ở $${auction.currentBid}. Bỏ cuộc sẽ RÚT LẠI giá bạn đã đặt — phiên vẫn tiếp tục, và quyền dẫn đầu chuyển sang mức giá cao nhất còn lại của người khác.`

  const groupColor = tile?.groupId ? GROUP_COLORS[tile.groupId] : undefined
  const headerColor = tile ? (CHANCE_FORTUNE_COLOR[tile.tileType] ?? groupColor) : undefined

  function bid(amount) {
    setBusy(true)
    sendGameAction('PLACE_BID', { amount })
  }

  function fold() {
    // One click arms the warning, the second commits — but only when folding
    // actually costs something (see foldCost). A plain fold stays one click.
    if (foldCost && !confirmFold) {
      setConfirmFold(true)
      return
    }
    setBusy(true)
    sendGameAction('FOLD_AUCTION')
  }

  return (
    <div className={styles.backdrop}>
      <div className={styles.modal}>
        <p className={styles.eyebrow}>⚡ Sàn Đấu Giá ⚡</p>
        
        {initiator && (
          <p className={styles.status} style={{ marginTop: '-8px', marginBottom: '16px', fontStyle: 'italic', color: 'var(--et-gold)' }}>
            Chủ sàn (Môi giới): {nameFor(initiator)}
          </p>
        )}

        {tile && (
          <div className={styles.propertyCard}>
            <div className={styles.propertyHeader} style={{ background: headerColor ?? 'var(--code-bg)' }}>
              <TileIcon type={tile.tileType} className={styles.icon} />
            </div>
            <h3 className={styles.propertyName}>{tile.name}</h3>
          </div>
        )}

        <div className={styles.bidInfo}>
          <span className={styles.bidLabel}>Giá cao nhất</span>
          {/* key={currentBid} remounts the node on every raise so the CSS
              animation replays each time, no JS animation-state tracking needed */}
          <span key={auction.currentBid} className={styles.bidAmount}>
            ${auction.currentBid}
          </span>
          <span className={styles.bidderName}>
            {highestBidder ? `do ${nameFor(highestBidder)} đặt` : '(chưa có ai đặt)'}
          </span>
        </div>

        <div className={styles.participants}>
          <div className={styles.participantGroup}>
            <span className={styles.participantLabel}>Đang tham gia ({activeParticipants.length})</span>
            <div className={styles.participantList}>
              {activeParticipants.map((p) => (
                <span
                  key={p.id}
                  className={
                    p.id === auction.highestBidderId
                      ? `${styles.chip} ${styles.chipLeading}`
                      : `${styles.chip}`
                  }
                >
                  {nameFor(p)}
                </span>
              ))}
            </div>
          </div>

          {foldedParticipants.length > 0 && (
            <div className={styles.participantGroup}>
              <span className={styles.participantLabel}>Đã bỏ cuộc ({foldedParticipants.length})</span>
              <div className={styles.participantList}>
                {foldedParticipants.map((p) => (
                  <span
                    key={p.id}
                    className={
                      p.id === auction.highestBidderId
                        ? `${styles.chip} ${styles.chipFolded} ${styles.chipLeading}`
                        : `${styles.chip} ${styles.chipFolded}`
                    }
                  >
                    {nameFor(p)}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {iAmActive ? (
          <div className={styles.actions}>
            {nextBidAmounts.map((amount, i) => (
              <button
                key={amount}
                type="button"
                className={styles.bidButton}
                disabled={busy || me.currentBalance < amount}
                onClick={() => bid(amount)}
              >
                +${BID_INCREMENTS[i]} (${amount})
              </button>
            ))}
            {confirmFold && foldCost && <p className={styles.foldWarning}>⚠ {foldCost}</p>}
            <button
              type="button"
              className={confirmFold && foldCost ? `${styles.foldButton} ${styles.foldButtonArmed}` : styles.foldButton}
              disabled={busy}
              onClick={fold}
            >
              {confirmFold && foldCost ? 'Vẫn bỏ cuộc — tôi hiểu' : 'Bỏ cuộc (Fold)'}
            </button>
          </div>
        ) : iAmInitiator ? (
          <p className={styles.status}>Sàn đấu giá của bạn đang diễn ra, hãy chờ kết quả.</p>
        ) : (
          <p className={styles.status}>Bạn đã bỏ cuộc — chờ kết quả đấu giá.</p>
        )}

        {/* compact: the auction modal is time-pressured and already dense —
            the title alone carries the meaning, and a full explanation would
            push the bid controls off the visible area. */}
        {lastError && <ActionNotice error={lastError} compact />}
      </div>
    </div>
  )
}
