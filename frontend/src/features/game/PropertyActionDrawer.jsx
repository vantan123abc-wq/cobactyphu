import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useGameStore } from '../../store/gameStore'
import { sendGameAction } from '../../network/socketClient'
import { GROUP_COLORS, CHANCE_FORTUNE_COLOR } from '../board/tileVisuals'
import TileIcon from '../board/TileIcon'
import { buildBlockReason, effectiveBuildCost, nextBuildLabel, MAX_UPGRADE_LEVEL } from './buildRules'
import { buyoutBlockReason } from './buyoutRules'
import styles from './PropertyActionDrawer.module.css'

// Same gameState.currentTurn correction as GameControls.jsx — no such
// field exists; the real, flat fields are `phase` (a GAME_PHASES string —
// 'AWAITING_PURCHASE', not 'BUY_PROPERTY'/'SKIP_BUY'/'START_AUCTION', none
// of which are real actionType or phase values anywhere in this codebase)
// and `currentTurnIndex`.
//
// Both actions here have an EMPTY payload, confirmed against
// WEBSOCKET_API.md's real table (not guessed, per this task's own
// instruction): `BUY_PROPERTY | AWAITING_PURCHASE | {}` — "Tile is the
// sender's current position, not client-supplied" — turnMachine.js's
// handleBuyProperty derives the target tile from the current player's own
// currentPosition server-side; a client-supplied propertyId is never read,
// so none is sent. `DECLINE_PURCHASE | AWAITING_PURCHASE | {}` is the real
// name for "pass" — there is no separate SKIP_BUY/START_AUCTION action;
// whether declining actually starts a Flash Auction is a server-side
// decision (based on whether the declining player can afford
// calculateAuctionFee), not a client choice between two different actions.
//
// Property/tile details (name, color, price) come from staticBoard.tiles
// (an array on the `{ boardId, tiles }` object GameBoard.jsx already reads
// the same way — "staticBoard array" in this task's own brief undersells
// its real shape slightly), matched by the local player's own
// currentPosition — GameState carries no propertyId/tileIndex field to
// "extract" for this; AWAITING_PURCHASE's own existence as the current
// phase already guarantees the player is standing on a fresh, unowned,
// buyable tile (resolveTile.js only ever transitions here for exactly that
// case), so no extra ownership cross-check is needed client-side either.
export default function PropertyActionDrawer() {
  const { user } = useAuth()
  const gameState = useGameStore((s) => s.currentGameState)
  const staticBoard = useGameStore((s) => s.staticBoard)
  const lastError = useGameStore((s) => s.lastError)

  const [busy, setBusy] = useState(false)
  // 2026-08-25, user request: buying a property (AWAITING_PURCHASE ->
  // BUY_PROPERTY) lands the game in POST_ACTIONS directly — resolveTile.js
  // only routes a landing through AWAITING_UPGRADE, never a purchase — so a
  // freshly-bought, freshly-buildable property previously got no build
  // prompt at all until a later turn's real return-landing triggered
  // AWAITING_UPGRADE for real. Monopoly hasn't been required to build since
  // the same day's earlier revision (buildRules.js), so there's no rules
  // reason left to make the player wait that long. Purely a local dismiss —
  // POST_ACTIONS itself isn't blocked on this the way AWAITING_UPGRADE is,
  // so there's no DECLINE_UPGRADE-style server action to send, only a UI
  // nudge to hide. Keyed by property id so it re-arms the instant the
  // player is ever standing on a *different* buildable property of their
  // own, but a real AWAITING_UPGRADE return-landing later on the same
  // property is untouched by this (separate phase, separate boolean below).
  const [dismissedBuildPropertyId, setDismissedBuildPropertyId] = useState(null)

  const me = gameState?.players?.find((p) => p.playerId === user?.id)
  const isMyTurn = me != null && me.turnOrder === gameState?.currentTurnIndex
  const tile = staticBoard?.tiles?.find((t) => t.position === me?.currentPosition)
  
  // 2026-09-02: User requested setting the starting price for FORCE_AUCTION.
  // Defaults to the tile's printed price — the same opening the server uses
  // when no basePrice is sent — so the field starts on the old behaviour and
  // the discount is something the player opts into.
  const [basePrice, setBasePrice] = useState(0)
  const tilePrice = tile?.price
  useEffect(() => {
    if (tilePrice && gameState?.phase === 'AWAITING_PURCHASE') {
      setBasePrice(tilePrice)
    }
  }, [tilePrice, gameState?.phase])

  useEffect(() => {
    setBusy(false)
  }, [gameState?.stateVersion, lastError])

  const property = gameState?.properties?.find((p) => p.boardTileId === tile?.id)

  const isAwaitingPurchase = gameState?.phase === 'AWAITING_PURCHASE'
  const isAwaitingUpgrade = gameState?.phase === 'AWAITING_UPGRADE'
  // The ownership half is load-bearing (2026-08-25, found by fuzzing the
  // backend): trades are phase-independent, so the buyer can acquire the
  // pending target by trade between paying rent and clicking buyout — the
  // server now rejects that with ALREADY_OWNED, and this stops offering the
  // button for a property you already own in the first place.
  const isAwaitingAcquisition =
    gameState?.phase === 'POST_ACTIONS' &&
    gameState?.pendingHostileBuyoutPropertyId === property?.id &&
    property?.ownerId != null &&
    property?.ownerId !== me?.id
  const canOfferFreshBuild =
    gameState?.phase === 'POST_ACTIONS' &&
    tile?.tileType === 'property' &&
    property?.ownerId === me?.id &&
    (property?.upgradeLevel ?? 0) < MAX_UPGRADE_LEVEL &&
    dismissedBuildPropertyId !== property?.id
  const showBuildOffer = isAwaitingUpgrade || canOfferFreshBuild

  if (!gameState || !staticBoard || !isMyTurn || !tile || (!isAwaitingPurchase && !showBuildOffer && !isAwaitingAcquisition)) {
    return null
  }

  const groupColor = tile.groupId ? GROUP_COLORS[tile.groupId] : undefined
  const headerColor = CHANCE_FORTUNE_COLOR[tile.tileType] ?? groupColor

  function act(actionType) {
    setBusy(true)
    sendGameAction(actionType, property ? { propertyId: property.id } : {})
  }

  // The band handleForceAuction enforces, applied here too so the button can
  // only ever send a value the server will accept.
  function clampOpeningPrice(value) {
    const n = Math.round(Number(value))
    if (!Number.isFinite(n)) return printedPrice
    return Math.min(printedPrice, Math.max(minOpeningPrice, n))
  }

  function forceAuction(openingPrice) {
    setBusy(true)
    sendGameAction('FORCE_AUCTION', {
      ...(property ? { propertyId: property.id } : {}),
      basePrice: openingPrice,
    })
  }

  const rentRows =
    tile.tileType === 'property' && tile.rentTable
      ? tile.rentTable.map((rent, i) => ({ level: i + 1, rent }))
      : []

  const hostileBuyoutCost = (tile.price + (property?.upgradeLevel || 0) * (tile.houseCost || 0)) * 2
  // Full server-side precondition set, shared with GameControls so the two
  // surfaces cannot disagree about what will actually be accepted — see
  // buyoutRules.js for why this had to be extracted.
  const buyoutBlocked = isAwaitingAcquisition ? buyoutBlockReason(gameState, staticBoard, me) : null

  // Mirrors handleBuyProperty's own `player.currentBalance < amount` check.
  const cannotAffordBuy = typeof tile.price === 'number' && me.currentBalance < tile.price

  // FORCE_AUCTION economics, mirrored from handleForceAuction (2026-09-03).
  // `currentAuctionFee`/`cannotAffordAuction` were being READ by the JSX below
  // without ever being declared — a live ReferenceError that crashed this
  // drawer on every AWAITING_PURCHASE, i.e. every time anyone landed on an
  // unowned tile. Defined here, and kept in one place so the three uses below
  // cannot drift from each other.
  //
  // The fee tracks calculateAuctionFee(tile.price) byte-for-byte, and is
  // computed from the PRINTED price on purpose: the server charges it that way
  // so that discounting the opening bid never discounts the host's own cost.
  const printedPrice = typeof tile.price === 'number' ? tile.price : 0
  const currentAuctionFee = Math.ceil(Math.max(20, Math.min(80, printedPrice * 0.05)))
  const cannotAffordAuction = me.currentBalance < currentAuctionFee
  // Allowed opening-price band, mirroring MIN_AUCTION_OPEN_RATIO (0.5) and the
  // "never above the printed price" rule in handleForceAuction.
  const minOpeningPrice = Math.ceil(printedPrice * 0.5)

  // Real BUILD_HOUSE preconditions, mirrored from the server (buildRules.js)
  // — only meaningful while a build is actually being offered (AWAITING_UPGRADE,
  // or the fresh-purchase POST_ACTIONS case below), but computed unconditionally
  // here since it's cheap and keeps the JSX below free of nested guards.
  const buildBlocked = showBuildOffer ? buildBlockReason({ gameState, staticBoard, tile, property, player: me }) : null
  const buildCost = effectiveBuildCost(tile, gameState, me)
  const buildLabel = nextBuildLabel(property)

  return (
    <div className={styles.drawer}>
      <div className={styles.card}>
        <div className={styles.cardHeader} style={{ background: headerColor ?? 'var(--code-bg)' }}>
          <TileIcon type={tile.tileType} className={styles.icon} />
        </div>
        <div className={styles.cardBody}>
          <h3 className={styles.name}>{tile.name}</h3>
          
          <div className={styles.costsRow}>
            {typeof tile.price === 'number' && <p className={styles.price}>Giá gốc: <strong>${tile.price}</strong></p>}
            {typeof tile.mortgageValue === 'number' && <p className={styles.price}>Cầm cố: <strong>${tile.mortgageValue}</strong></p>}
            {typeof tile.houseCost === 'number' && <p className={styles.price}>Xây nhà: <strong>${tile.houseCost}</strong></p>}
          </div>

          {tile.tileType === 'property' && typeof tile.baseRent === 'number' && (
            <div className={styles.rentBox}>
              <p className={styles.rentHeadline}>TIỀN THUÊ ${tile.baseRent}</p>
              {rentRows.length > 0 && (
                <div className={styles.rentTable}>
                  {rentRows.map(({ level, rent }) => (
                    <div key={level} className={styles.rentRow}>
                      <span className={styles.rentRowLabel}>{level < MAX_UPGRADE_LEVEL ? `Với ${level} nhà` : 'Với khách sạn'}</span>
                      <span className={styles.rentRowValue}>${rent}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tile.tileType === 'transport' && typeof tile.baseRent === 'number' && (
            <div className={styles.rentBox}>
              <p className={styles.rentHeadline}>TIỀN THUÊ KHI CÙNG SỞ HỮU</p>
              <div className={styles.rentTable}>
                <div className={styles.rentRow}><span className={styles.rentRowLabel}>1 bến xe</span><span className={styles.rentRowValue}>${tile.baseRent}</span></div>
                <div className={styles.rentRow}><span className={styles.rentRowLabel}>2 bến xe</span><span className={styles.rentRowValue}>${tile.baseRent * 2}</span></div>
                <div className={styles.rentRow}><span className={styles.rentRowLabel}>3 bến xe</span><span className={styles.rentRowValue}>${tile.baseRent * 4}</span></div>
                <div className={styles.rentRow}><span className={styles.rentRowLabel}>4 bến xe</span><span className={styles.rentRowValue}>${tile.baseRent * 8}</span></div>
              </div>
            </div>
          )}

          {tile.tileType === 'utility' && (
            <div className={styles.rentBox}>
              <p className={styles.rentHeadline}>THUÊ BẰNG SỐ XÚC XẮC NHÂN LÊN</p>
              <div className={styles.rentTable}>
                <div className={styles.rentRow}><span className={styles.rentRowLabel}>1 công ty</span><span className={styles.rentRowValue}>4 x Xúc xắc</span></div>
                <div className={styles.rentRow}><span className={styles.rentRowLabel}>2 công ty</span><span className={styles.rentRowValue}>10 x Xúc xắc</span></div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className={styles.actions}>
        {isAwaitingPurchase && (
          <>
            <button
              type="button"
              className={styles.buyButton}
              disabled={busy || cannotAffordBuy}
              title={cannotAffordBuy ? `Không đủ tiền — bạn có $${me.currentBalance}, giá $${tile.price}` : undefined}
              onClick={() => act('BUY_PROPERTY')}
            >
              Mua đứt (${tile.price})
            </button>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '12px', color: '#888' }}>
                <span>Giá khởi điểm (${minOpeningPrice}–${printedPrice}):</span>
                <span>Phí mở: ${currentAuctionFee}</span>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input
                  type="number"
                  min={minOpeningPrice}
                  max={printedPrice}
                  step={1}
                  value={basePrice}
                  onChange={(e) => setBasePrice(parseInt(e.target.value, 10) || 0)}
                  // Clamped on blur rather than on every keystroke: clamping as
                  // you type makes the field impossible to edit (deleting a
                  // digit snaps it straight back to the floor).
                  onBlur={() => setBasePrice(clampOpeningPrice(basePrice))}
                  style={{ flex: 1, padding: '8px', borderRadius: '4px', border: '1px solid #444', background: '#222', color: '#fff' }}
                />
                <button
                  type="button"
                  className={styles.declineButton}
                  disabled={busy || cannotAffordAuction}
                  title={cannotAffordAuction ? `Không đủ tiền trả phí — bạn có $${me.currentBalance}` : `Mở sàn ở $${clampOpeningPrice(basePrice)}. Trả phí để nhận 20% hoa hồng nếu đấu giá thành công. Lưu ý: bạn là chủ sàn nên KHÔNG được đặt giá trong phiên này.`}
                  // Send the clamped value, never the raw field: the server
                  // rejects anything outside [minOpeningPrice, printedPrice]
                  // with INVALID_BASE_PRICE, and a half-typed number must not
                  // turn into a rejected action.
                  onClick={() => forceAuction(clampOpeningPrice(basePrice))}
                  style={{ flex: 1, margin: 0 }}
                >
                  Mở sàn
                </button>
              </div>
            </div>
            <button type="button" className={styles.declineButton} style={{ background: 'transparent', color: '#ccc', border: '1px solid #444', marginTop: '8px' }} disabled={busy} onClick={() => act('SKIP_PURCHASE')}>
              Bỏ qua (Miễn phí)
            </button>
          </>
        )}
        {showBuildOffer && (
          <>
            {/* 2026-08-23: this button used to check only `tileType ===
                'property'`, so it offered builds the server then rejected
                outright — a real user report (`INCOMPLETE_GROUP` shown raw
                on screen after clicking it). Now gated on the same real
                preconditions handleBuildHouse enforces (buildRules.js), with
                the specific blocking reason surfaced instead of a rejection
                after the fact. */}
            <button
              type="button"
              className={styles.buyButton}
              disabled={busy || !!buildBlocked}
              title={buildBlocked ?? undefined}
              onClick={() => act('BUILD_HOUSE')}
            >
              {buildBlocked ? 'Chưa xây được' : `${buildLabel.label} ($${buildCost})`}
            </button>
            {/* Only a real AWAITING_UPGRADE decision needs DECLINE_UPGRADE
                sent to the server — that phase blocks everything else until
                resolved. The fresh-purchase POST_ACTIONS case blocks
                nothing (mortgage/trade/end-turn all still work), so
                dismissing it is purely local — see canOfferFreshBuild's own
                comment above. */}
            <button
              type="button"
              className={styles.declineButton}
              disabled={busy}
              onClick={() => (isAwaitingUpgrade ? act('DECLINE_UPGRADE') : setDismissedBuildPropertyId(property.id))}
            >
              Bỏ qua
            </button>
            {buildBlocked && <p className={styles.blockedReason}>{buildBlocked}</p>}
          </>
        )}
        {isAwaitingAcquisition && (
          <>
            {/* Preconditions now come from the SHARED buyoutRules mirror
                (2026-09-02). This button previously checked only
                `upgradeLevel > 0` (HOUSE_PROTECTED) and knew nothing about
                MONOPOLY_PROTECTED, so it rendered fully enabled on a
                monopoly-protected lot and the click came back as a raw server
                rejection the player then saw on screen. GameControls had the
                complete check all along — exactly the two-copies-drift problem
                buildRules.js was created to stop, repeated. */}
            <button
              type="button"
              className={styles.buyButton}
              disabled={busy || !!buyoutBlocked}
              title={buyoutBlocked ?? undefined}
              style={{ background: buyoutBlocked ? '#4b5563' : 'linear-gradient(180deg, #f43f5e, #be123c)' }}
              onClick={() => act('HOSTILE_BUYOUT')}
            >
              Cưỡng đoạt (${hostileBuyoutCost})
            </button>
            {buyoutBlocked && <p className={styles.blockedReason}>{buyoutBlocked}</p>}
            <button type="button" className={styles.declineButton} disabled={busy} onClick={() => act('DECLINE_HOSTILE_BUYOUT')}>
              Bỏ qua
            </button>
          </>
        )}
      </div>
    </div>
  )
}
