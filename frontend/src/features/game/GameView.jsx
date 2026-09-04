import { useAuth } from '../auth/AuthContext'
import { supabase } from '../../supabaseClient'
import { useGameStore } from '../../store/gameStore'
import GameBoard from '../board/GameBoard'
import BoardCamera from '../board/BoardCamera'
import PlayersPanel from './PlayersPanel'
import Ledger from './Ledger'
import SynergyPanel from './SynergyPanel'
import MyPortfolio from './MyPortfolio'
import GameControls from './GameControls'
import MovementHandControls from './MovementHandControls'
import ForfeitButton from './ForfeitButton'
import PropertyActionDrawer from './PropertyActionDrawer'
import FlashAuction from './FlashAuction'
import PropertyManager from './PropertyManager'
import TradeWindow from './TradeWindow'
import EventCardModal from './EventCardModal'
import RoundEffectsBar from './RoundEffectsBar'
import MarketInfo from './MarketInfo'
import CardInventory from './CardInventory'
import EventCardHistory from './EventCardHistory'
import RentRiskChoice from './RentRiskChoice'
import FinalPhaseBanner from './FinalPhaseBanner'
import FinalDuelBanner from './FinalDuelBanner'
import GameOverScreen from './GameOverScreen'
import LiquidationPanel from './LiquidationPanel'
import DraftPhase from './DraftPhase'
import styles from './GameView.module.css'

// GameView redesign (2026-08-22) — was a flat list of independently
// `position: fixed` corner overlays over a full-bleed board; now a real
// 3-column shell (Players | board+controls | Ledger+property), matching a
// reference mockup the user shared, in a dedicated navy/gold palette scoped
// to this component only (--et-* custom properties below, not touching
// index.css or the app's own light/dark theme — confirmed explicitly via
// AskUserQuestion, not the app's adaptive theme). The isometric board
// itself (GameBoard.jsx/GameBoard.module.css) is unchanged — same
// confirmed constraint — except one small, deliberate, flagged fix: its
// `.viewport`'s old asymmetric right padding (260px) existed specifically
// to keep the board clear of the *previous* fixed-position PlayerHud/
// PropertyManager corner overlays; those overlays no longer exist (they're
// real grid-column siblings now, not floating over the board), so that
// padding became stale dead weight, not a deliberate "board" decision worth
// preserving — see GameBoard.module.css's own comment at that exact line.
//
// This file keeps its own established role (composition wrapper for "the
// board plus its controls" once a match is in progress) — every full-screen
// modal below (PropertyManager/PropertyActionDrawer/FlashAuction/
// TradeWindow/EventCardModal/RentRiskChoice/FinalPhaseBanner/GameOverScreen)
// keeps its own z-index stacking and logic completely unchanged, still
// mounted as plain siblings of the new shell — they already float above via
// their own `position: fixed`, which composes over any layout underneath
// without needing to know this shell exists at all.
//
// PropertyManager moved OUT of `.right` and into this overlay group
// (2026-08-23, user request: a selected property's full detail card should
// show big, centre-screen — see PropertyManager.module.css's own header)
// rather than staying a normal flow child of the sidebar the way MyPortfolio/
// Ledger still are.
export default function GameView() {
  const { user } = useAuth()
  const gameState = useGameStore((s) => s.currentGameState)

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <span className={styles.brand}>Cờ Tỷ Phú</span>
        <BoardCamera />
        <div className={styles.topbarRight}>
          <span className={styles.greeting}>Xin chào, {user.user_metadata?.display_name || user.email}</span>
          <ForfeitButton />
          <button type="button" className={styles.logoutButton} onClick={() => supabase.auth.signOut()}>
            Đăng xuất
          </button>
        </div>
      </header>

      <div className={styles.body}>
        <aside className={styles.left}>
          <PlayersPanel />
        </aside>

        <div className={styles.center}>
          {/* Shared match-status rail (2026-08-23) — the round number, plus
              any round-scoped event-card effect currently in force. Both
              belong to the whole table, not to one player, so they live
              together here rather than in PlayersPanel's per-player cards. */}
          <div className={styles.statusRail}>
            {gameState && <span className={styles.turnPill}>🎲 Vòng {gameState.roundNumber}</span>}
            {/* Which ruleset this match is ACTUALLY running (2026-09-04). Added
                after a real report of "chế độ mới chẳng khác gì chế độ cũ":
                the room ruleset was not being persisted, so a match created as
                Đột Phá could silently start as Cổ Điển with nothing anywhere
                on screen contradicting the lobby label. The bug is fixed, but
                the mode a match is running should never again be something a
                player has to infer from whether a Draft modal happened to
                appear. Reads gameState.ruleset — the value the ENGINE is
                actually using, not the room record. */}
            {gameState && (
              <span className={gameState.ruleset === 'ASYMMETRIC' ? styles.modePillAsym : styles.modePill}>
                {gameState.ruleset === 'ASYMMETRIC' ? '⚔️ Đột Phá' : '♟️ Cổ Điển'}
              </span>
            )}
            {/* Table-wide market state (design brief §16) — building supply,
                jackpot, live auction high. Every figure already existed but
                was scattered across three separate panels, none of them
                visible while deciding something else; gathered here beside
                the round counter, where the other table-wide readouts live. */}
            <MarketInfo />
            <RoundEffectsBar />
            {/* Sits on the shared status rail rather than in a sidebar
                because it is table-wide history, like the round counter and
                the round-scoped effects beside it — and because it has to
                stay reachable at the moment a player realises they closed a
                card too early, without hunting for a panel. */}
            <EventCardHistory />
          </div>
          <div className={styles.boardWrap}>
            <GameBoard />
          </div>
          <GameControls />
          {/* PLAYING_CARD (ASYMMETRIC only) — self-gates, docks to the same
              bottom-of-board spot GameControls' own ROLLING button occupies
              for CLASSIC. The two are mutually exclusive by ruleset, so
              they never render at once. */}
          <MovementHandControls />
        </div>

        <aside className={styles.right}>
          {/* ASYMMETRIC only, self-gating — the mode's synergies are derived
              from a whole portfolio and stored nowhere, so without this panel
              the only trace of them in the UI was a ring on tiles already
              feeding one: what you finished, never what you are building
              toward or what it would pay. First in the rail because in that
              mode it is the readout every purchase decision is made against. */}
          <SynergyPanel />
          <MyPortfolio />
          <CardInventory />
          <Ledger />
        </aside>
      </div>

      {/* DRAFTING_ACTIVE (ASYMMETRIC only) — the very first phase a match can
          be in, before TURN_START even fires once. Listed first here for the
          same reason. */}
      <DraftPhase />
      <PropertyManager />
      <PropertyActionDrawer />
      <LiquidationPanel />
      <FlashAuction />
      <TradeWindow />
      <EventCardModal />
      <RentRiskChoice />
      <FinalPhaseBanner />
      <FinalDuelBanner />
      <GameOverScreen />
    </div>
  )
}
