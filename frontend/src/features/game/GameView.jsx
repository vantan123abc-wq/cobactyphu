import { useAuth } from '../auth/AuthContext'
import { supabase } from '../../supabaseClient'
import { useGameStore } from '../../store/gameStore'
import GameBoard from '../board/GameBoard'
import BoardCamera from '../board/BoardCamera'
import PlayersPanel from './PlayersPanel'
import Ledger from './Ledger'
import MyPortfolio from './MyPortfolio'
import GameControls from './GameControls'
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
        </div>

        <aside className={styles.right}>
          <MyPortfolio />
          <CardInventory />
          <Ledger />
        </aside>
      </div>

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
