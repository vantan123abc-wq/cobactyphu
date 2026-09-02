import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useGameStore } from '../../store/gameStore'
import { sendGameAction } from '../../network/socketClient'
import { getRoom } from '../../network/api'
import { FINAL_PHASE_DURATION_ROUNDS } from './winConditionConstants'
import { suggestCards } from './cardSuggestions'
import styles from './GameControls.module.css'
import ActionNotice from './ActionNotice'

// Mirrors backend/src/engine/jail.js's own constant — no shared package
// between frontend/backend in this repo, same standing as every other
// mirrored backend constant this session.
const JAIL_FINE = 50

// The flat Unicode die glyphs (⚀-⚅) that used to render here were replaced
// 2026-08-22 by real tumbling 3D dice on the board itself
// (features/board/DiceRoll.jsx). Deleted rather than kept alongside them —
// two separate renderings of the same gameState.lastRoll could visibly
// disagree mid-animation, and the board is where a rolled die belongs.

// Phases with real controls of their own (this component's own, or another
// mounted component's — AWAITING_PURCHASE/PropertyActionDrawer.jsx,
// AWAITING_EVENT_CHOICE/EventCardModal.jsx) — excluded from the generic
// "not supported yet" fallback below so it never shows a stale second
// message next to a real, working control.
const HANDLED_PHASES = [
  'TURN_START',
  'ROLLING',
  'POST_ACTIONS',
  'AWAITING_PURCHASE',
  'JAIL_DECISION',
  'AWAITING_EVENT_CHOICE',
  'LIQUIDATION_REQUIRED', // Win Condition design (2026-08-19) — see the status line below; the real Sell/Mortgage buttons live in PropertyManager.jsx, reused verbatim, not duplicated here
  // Both added 2026-08-23 — each HAS had a real, working UI for a long
  // time (AWAITING_UPGRADE → PropertyActionDrawer.jsx's own build/skip
  // branch; FLASH_AUCTION_ACTIVE → FlashAuction.jsx, mounted in
  // GameView.jsx), they were simply never listed here, so this component's
  // "chưa có giao diện điều khiển" fallback printed a stale, flatly untrue
  // second message directly under the working controls. Caught from a user
  // screenshot showing exactly that during AWAITING_UPGRADE.
  'AWAITING_UPGRADE',
  'FLASH_AUCTION_ACTIVE',
]

// P11-T10: a small always-visible "start a trade" row, added here rather
// than a new Lobby/roster component — no in-game player-roster UI existed
// anywhere in this codebase yet (this task's brief itself offered either as
// "e.g."), and trading is explicitly phase-independent
// (stateMachine/tradeMachine.js's own file header: "either player, at any
// point in the match, regardless of whose turn it is or what phase the
// game is in") — unlike every button above, which is gated on
// isMyTurn/gameState.phase, this row is not. Hidden while the local player
// already has a trade pending (as either proposerId or targetId) — this
// task's own brief frames trade lookup as finding *an* active trade
// (singular), so the UI keeps to one relevant trade at a time rather than
// a multi-trade queue; TradeWindow.jsx (mounted separately in
// GameView.jsx) is what actually renders once one exists.

// gameState.currentTurn does not exist — domain/gameState.js's GameState is
// flat: `phase` (a GAME_PHASES string — 'ROLLING'/'POST_ACTIONS'/etc, NOT
// 'ROLL_DICE'; that's the actionType sent to trigger a roll, not a phase
// name) and `currentTurnIndex` (a turnOrder *number*, not a playerId) both
// sit directly on gameState. "Is it my turn" needs the same id-space
// resolution Phase 09's real bug was about (PROJECT_STATUS.md finding #19):
// the locally authenticated user's id (useAuth()'s `user.id`, the JWT/
// profiles id) only ever matches PlayerGameState.playerId, never
// PlayerGameState.id (what turnOrder/currentTurnIndex comparisons use
// elsewhere in this codebase) — so it's `me.turnOrder ===
// gameState.currentTurnIndex`, not a direct playerId/currentTurn comparison.
//
// Originally scoped to just the core loop (no buy/build/trade UI yet):
// TURN_START (the match's very first move only — every subsequent turn's
// phase already lands past this automatically, see turnMachine.js's
// advanceTurn), ROLLING, POST_ACTIONS. AWAITING_PURCHASE (P11-T07) is
// deliberately excluded from the generic fallback line below —
// PropertyActionDrawer.jsx (mounted alongside this component in
// GameView.jsx) owns that phase's real UI now; showing this component's own
// "not supported yet" message at the same time would just be a stale,
// contradictory second message next to a fully working drawer.
// JAIL_DECISION (P11-T11) is now also excluded, for the same reason — its
// own buttons are below, in this same component (unlike AWAITING_PURCHASE/
// FLASH_AUCTION_ACTIVE/trade, which each got a separate file, jail's action
// set is small and turn-scoped the exact same way TURN_START/ROLLING/
// POST_ACTIONS already are, so it fits this component's own existing
// pattern directly rather than needing its own overlay). Event cards
// (DRAWING_CARD/AWAITING_EVENT_CHOICE) are handled by EventCardModal.jsx,
// mounted separately — see that file's own header for why DRAWING_CARD
// itself is never something this component (or any component) can render
// against, and AWAITING_EVENT_CHOICE is excluded below the same way.
//
// ROLL_DICE/ATTEMPT_JAIL_ROLL send no payload at all (see rollDiceAction/
// attemptJailRoll below) — finding #27 (docs/PROJECT_STATUS.md), RESOLVED
// 2026-08-19: dice are now genuinely server-generated
// (infrastructure/websocket/socketServer.js's serverGeneratedFields()
// overwrites action.payload after the client's own payload is spread in,
// the same way playerId/tradeId already are), so a client-computed value
// here would just be silently discarded. P11-T11's own stopgap
// (`clientDice.js`, a byte-for-byte mirror of the real backend algorithm,
// shipped on explicit instruction — AskUserQuestion, 2026-08-19 — while
// this gap was still open) has been deleted now that the real fix landed.
//
// Player display names aren't on GameState.players at all (only
// playerId/turnOrder/currentBalance/... — no displayName field exists
// there) — resolved here via the same GET /api/v1/rooms/:id REST call
// Lobby.jsx already uses for the same reason, fetched once on mount (unlike
// Lobby's 3s poll — display names don't change mid-match, no freshness
// concern here).
export default function GameControls() {
  const { user, session } = useAuth()
  const roomId = useGameStore((s) => s.roomState?.roomId)
  const gameState = useGameStore((s) => s.currentGameState)
  const staticBoard = useGameStore((s) => s.staticBoard)
  const lastError = useGameStore((s) => s.lastError)
  const eventCards = useGameStore((s) => s.eventCards)
  const setTradeDraftTargetId = useGameStore((s) => s.setTradeDraftTargetId)

  const [displayNames, setDisplayNames] = useState({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!roomId) return
    getRoom(session.access_token, roomId)
      .then((room) => {
        const map = {}
        for (const p of room.players ?? []) map[p.playerId] = p.displayName
        setDisplayNames(map)
      })
      .catch(() => {}) // a name-lookup failure is a UX nicety miss only, never blocks gameplay
  }, [roomId, session.access_token])

  // Reset the click-guard on any real server response — success (a new
  // stateVersion) or rejection (a new lastError) — rather than a guessed
  // timeout, so a genuinely rejected action doesn't leave the button stuck
  // disabled.
  useEffect(() => {
    setBusy(false)
  }, [gameState?.stateVersion, lastError])

  if (!gameState) return null

  const me = gameState.players.find((p) => p.playerId === user.id)
  const activePlayer = gameState.players.find((p) => !p.isBank && p.turnOrder === gameState.currentTurnIndex)
  const isMyTurn = me != null && me.turnOrder === gameState.currentTurnIndex
  const nameFor = (player) => displayNames[player?.playerId] ?? player?.playerId ?? '…'

  const myTrade = me && gameState.pendingTrades.find((t) => t.proposerId === me.id || t.targetId === me.id)
  const opponents = me ? gameState.players.filter((p) => !p.isBank && p.id !== me.id) : []

  // Why PAY_JAIL_FINE isn't offered, or null when it is.
  //
  // 2026-09-02 bug fix: this button used to be hard-disabled whenever
  // `currentBalance < JAIL_FINE`, which removed a legal move. The server does
  // NOT reject a cash-short fine — payJailFineOrLiquidate() routes it through
  // checkSolvency and drops the player into LIQUIDATION_REQUIRED so they can
  // sell/mortgage their way to the $50. Refusing the click forced a jailed
  // player with plenty of property but little cash to keep rolling for
  // doubles instead of buying their way out, which is exactly the choice the
  // jail design is built around.
  //
  // Deliberately NOT a copy of checkSolvency's arithmetic (mortgage values +
  // house sell-back) — that would be a fourth rule mirror to drift. The only
  // thing gated here is the genuinely hopeless case: no cash AND nothing left
  // to liquidate, where the server's third branch is immediate bankruptcy and
  // a stray click shouldn't be able to trigger it.
  const jailFineBlocked = (() => {
    if (!me || me.currentBalance >= JAIL_FINE) return null
    const hasLiquidatableAsset = gameState.properties.some(
      (p) => p.ownerId === me.id && (!p.mortgaged || p.upgradeLevel > 0)
    )
    return hasLiquidatableAsset ? null : 'Không đủ tiền và không còn tài sản nào để thanh lý'
  })()

  // 2026-09-03, user request: a kept card that would free the player must be
  // usable FROM the jail dialog, not only from the Card Inventory panel in the
  // side rail. `VE_SO_TRUNG_AN_UI` grants a Get-Out-of-Jail card only once
  // played from the hand — a jailed player holding it otherwise has to find a
  // different panel, play it there, then come back here.
  //
  // suggestCards() already identifies exactly this situation ("in jail, 0 jail
  // cards, holding a GRANT_JAIL_CARD card"), and matches on the card's intents
  // rather than its id — so this stays correct if another jail card is added.
  // We only want that specific suggestion here, keyed by its card actually
  // being a jail-granting one.
  const grantsJailCard = (cardId) => {
    const card = eventCards[cardId]
    if (!card) return false
    const all = [...(card.intents ?? []), ...(card.options ?? []).flatMap((o) => o.intents ?? [])]
    return all.some((i) => i.action === 'GRANT_JAIL_CARD')
  }
  const jailCardInHand =
    suggestCards({ gameState, me, cards: eventCards }).find((s) => grantsJailCard(s.cardId))?.cardId ?? null

  // Win Condition design (2026-08-19) — persistent countdown badge, distinct
  // from FinalPhaseBanner.jsx's one-shot announcement (that one is dismissed
  // after a single read; this one stays up for the rest of the match so
  // nobody has to remember how much time is left). gameState.status is
  // checked explicitly per the approved design's own wording, not inferred
  // from phase — nothing currently unmounts GameView on game-end, so without
  // this check the badge would freeze on "0 vòng" instead of disappearing.
  const roundsLeft =
    gameState.finalPhaseStartedAtRound != null && gameState.status === 'in_progress'
      ? gameState.finalPhaseStartedAtRound + FINAL_PHASE_DURATION_ROUNDS - gameState.roundNumber
      : null

  // Phase 14 (2026-08-19) — HOSTILE_BUYOUT preview. Legal only in
  // POST_ACTIONS with a non-null pendingHostileBuyoutPropertyId, set
  // server-side the instant this same turn's rent payment on another
  // player's property resolves, and cleared unconditionally at the next
  // turn advance (turnMachine.js's advanceTurn) — so this can only ever be
  // true during the paying player's own current turn. Payload is genuinely
  // `{}` (WEBSOCKET_API.md §1) — the target is implicit server-side, never
  // client-chosen, so nothing here is sent to the server, this block only
  // computes a preview. Cost/monopoly-protection math mirrors
  // turnMachine.js's handleHostileBuyout exactly, reproduced here rather
  // than imported (no shared package between frontend/backend, same
  // standing as every other mirrored backend constant in this file).
  const hostileBuyoutTargetId = gameState.pendingHostileBuyoutPropertyId
  const hostileBuyoutProperty = hostileBuyoutTargetId
    ? gameState.properties.find((p) => p.id === hostileBuyoutTargetId)
    : null
  const hostileBuyoutTile =
    hostileBuyoutProperty && staticBoard ? staticBoard.tiles.find((t) => t.id === hostileBuyoutProperty.boardTileId) : null
  const hostileBuyoutCost = hostileBuyoutTile
    ? 2 * (hostileBuyoutTile.price + hostileBuyoutProperty.upgradeLevel * (hostileBuyoutTile.houseCost ?? 0))
    : null
  const hostileBuyoutGroupTiles =
    hostileBuyoutTile?.groupId && staticBoard ? staticBoard.tiles.filter((t) => t.groupId === hostileBuyoutTile.groupId) : []
  const hostileBuyoutMonopolyProtected =
    hostileBuyoutGroupTiles.length > 0 &&
    hostileBuyoutGroupTiles.every(
      (t) => gameState.properties.find((p) => p.boardTileId === t.id)?.ownerId === hostileBuyoutProperty?.ownerId
    )
  // HOUSE_PROTECTED, mirrored 2026-08-25 — handleHostileBuyout has rejected
  // any property with buildings for a while ("properties with ANY houses
  // cannot be taken over"), but this preview never checked it, so the button
  // rendered fully enabled and the click came back as a raw server rejection.
  // Placed AFTER the monopoly branch on purpose: handleHostileBuyout tests
  // MONOPOLY_PROTECTED first, so when a target is both fully-setted and
  // built up, that is the reason the server would actually give.
  const hostileBuyoutHasHouses = (hostileBuyoutProperty?.upgradeLevel ?? 0) > 0
  const hostileBuyoutReason = hostileBuyoutMonopolyProtected
    ? 'Ô này thuộc nhóm độc quyền, không thể cưỡng đoạt'
    : hostileBuyoutHasHouses
      ? 'Ô này đã xây nhà, không thể cưỡng đoạt'
      : hostileBuyoutCost != null && (me?.currentBalance ?? 0) < hostileBuyoutCost
        ? 'Không đủ tiền'
        : null

  function act(actionType) {
    setBusy(true)
    sendGameAction(actionType)
  }

  // USE_INVENTORY_CARD for the option-less keepable cards (VE_SO_TRUNG_AN_UI
  // here). Same shape CardInventory.jsx sends; `playerId` is overwritten
  // server-side, nothing random is computed client-side.
  function playInventoryCard(cardId) {
    setBusy(true)
    sendGameAction('USE_INVENTORY_CARD', { cardId })
  }

  // Finding #27 (docs/PROJECT_STATUS.md), resolved 2026-08-19: the dice
  // are now genuinely server-generated (socketServer.js's
  // serverGeneratedFields() overwrites whatever payload.die*/total/etc.
  // arrives here anyway) — these two actions send no payload at all,
  // rather than a client-computed one that would just be discarded.
  function rollDiceAction() {
    setBusy(true)
    sendGameAction('ROLL_DICE')
  }

  function attemptJailRoll() {
    setBusy(true)
    sendGameAction('ATTEMPT_JAIL_ROLL')
  }

  return (
    <section className={styles.controls}>
      {roundsLeft != null && (
        <p className={styles.finalPhaseBadge}>🔥 Giai đoạn cuối — còn {Math.max(0, roundsLeft)} vòng</p>
      )}

      {/* The Free Parking jackpot badge moved to MarketInfo on the shared
          status rail (2026-09-02, design brief §16) — it is table-wide
          information, not a control, and showing it in both places meant two
          sources for one number. */}

      {opponents.length > 0 && (
        <div className={styles.tradeRow}>
          {myTrade ? (
            <span className={styles.tradeHint}>Bạn đang có 1 giao dịch đang chờ xử lý.</span>
          ) : (
            <>
              <span className={styles.tradeLabel}>Giao dịch:</span>
              {opponents.map((p) => (
                <button key={p.id} type="button" className={styles.tradeButton} onClick={() => setTradeDraftTargetId(p.id)}>
                  {nameFor(p)}
                </button>
              ))}
            </>
          )}
        </div>
      )}

      {!isMyTurn && <p className={styles.status}>Đang chờ lượt của {nameFor(activePlayer)}…</p>}

      {isMyTurn && gameState.phase === 'TURN_START' && (
        <button type="button" className={styles.actionButton} disabled={busy} onClick={() => act('START_TURN')}>
          Bắt đầu lượt
        </button>
      )}

      {isMyTurn && gameState.phase === 'ROLLING' && (
        <button type="button" className={styles.rollButton} disabled={busy} onClick={rollDiceAction}>
          🎲 Đổ Xúc Xắc
        </button>
      )}

      {isMyTurn && gameState.phase === 'JAIL_DECISION' && me.inJail && (
        <div className={styles.jailRow}>
          <p className={styles.status}>Đang ngồi tù (lượt thứ {me.jailTurns}/3)</p>
          <div className={styles.jailButtons}>
            <button
              type="button"
              className={styles.actionButton}
              disabled={busy || !!jailFineBlocked}
              title={jailFineBlocked ?? (me.currentBalance < JAIL_FINE ? 'Không đủ tiền mặt — bạn sẽ phải thanh lý tài sản để trả khoản này' : undefined)}
              onClick={() => act('PAY_JAIL_FINE')}
            >
              Nộp Phạt (${JAIL_FINE})
            </button>
            <button
              type="button"
              className={styles.actionButton}
              disabled={busy || !(me.jailFreeCards > 0)}
              title={
                me.jailFreeCards > 0
                  ? undefined
                  : jailCardInHand
                    ? 'Bạn chưa có Thẻ Ra Tù dùng ngay — nhưng có một thẻ trong Kho Thẻ cho bạn một thẻ. Bấm "Dùng thẻ trong kho" bên dưới.'
                    : 'Bạn không có Thẻ Ra Tù nào — nhận được khi rút lá Cơ Hội/Khí Vận may mắn, hoặc từ một thẻ giữ trong Kho Thẻ.'
              }
              onClick={() => act('USE_JAIL_CARD')}
            >
              Dùng Thẻ Miễn Phí{me.jailFreeCards > 0 ? ` (${me.jailFreeCards})` : ''}
            </button>
            {me.jailFreeCards === 0 && jailCardInHand && (
              <button
                type="button"
                className={styles.actionButton}
                disabled={busy}
                title="Dùng thẻ trong Kho Thẻ để nhận một Thẻ Ra Tù, rồi bấm “Dùng Thẻ Miễn Phí” để ra."
                onClick={() => playInventoryCard(jailCardInHand)}
              >
                Dùng thẻ trong kho → Thẻ Ra Tù
              </button>
            )}
            <button type="button" className={styles.rollButton} disabled={busy} onClick={attemptJailRoll}>
              🎲 Thử Đổ Đôi
            </button>
          </div>
        </div>
      )}

      {/* Still in jail, but the turn continues (jail economic-actions
          revision, 2026-09-01). This state simply did not exist before — a
          failed escape used to end the turn immediately — so without this
          line the player sees a normal POST_ACTIONS bar with no hint that
          they are jailed and did not move. They can manage assets freely;
          only movement is blocked, and their next turn returns to
          JAIL_DECISION. */}
      {isMyTurn && gameState.phase === 'POST_ACTIONS' && me.inJail && (
        <p className={styles.jailNotice}>
          🔒 Bạn vẫn đang ở tù (lượt {me.jailTurns}/3) — không di chuyển được, nhưng vẫn xây/bán/cầm cố và giao dịch bình thường.
        </p>
      )}

      {isMyTurn && gameState.phase === 'POST_ACTIONS' && (
        <div className={styles.postActionsRow}>
          {hostileBuyoutTargetId && (
            <button
              type="button"
              className={styles.actionButton}
              disabled={busy || !!hostileBuyoutReason}
              title={hostileBuyoutReason ?? (hostileBuyoutTile ? `Cưỡng đoạt ${hostileBuyoutTile.name}` : undefined)}
              onClick={() => act('HOSTILE_BUYOUT')}
            >
              ⚔️ Cưỡng Đoạt{hostileBuyoutCost != null ? ` ($${hostileBuyoutCost})` : ''}
            </button>
          )}
          <button type="button" className={styles.actionButton} disabled={busy} onClick={() => act('END_TURN')}>
            Kết Thúc Lượt
          </button>
        </div>
      )}

      {/* LIQUIDATION_REQUIRED: the real UI is LiquidationPanel.jsx (position:fixed sidebar),
          which renders all owned properties as actionable sell/mortgage cards.
          Nothing needs to be shown here for that phase — the sidebar is self-contained. */}

      {isMyTurn && !HANDLED_PHASES.includes(gameState.phase) && (
        <p className={styles.status}>
          Đến lượt bạn — giai đoạn "{gameState.phase}" (chưa có giao diện điều khiển cho giai đoạn này).
        </p>
      )}

      {lastError && <ActionNotice error={lastError} />}
    </section>
  )
}
