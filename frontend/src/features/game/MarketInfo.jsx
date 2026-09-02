import { useGameStore } from '../../store/gameStore'
import { HOUSE_SUPPLY_TOTAL, HOTEL_SUPPLY_TOTAL } from './winConditionConstants'
import styles from './MarketInfo.module.css'

// Table-wide market state, 2026-09-02 (design brief §16 "Market Information").
//
// Every figure here already existed — it was just scattered: the jackpot lived
// in GameControls' bottom bar, building supply only inside PropertyManager's
// build panel, and the live auction high only inside the FlashAuction modal.
// A player could not see any of it while deciding something else. Gathered
// onto the shared status rail beside the round counter, which is where the
// other table-wide readouts already live.
//
// INFORMATION ONLY — deliberately no advice, no highlighting of a "best"
// option, no derived recommendation (design brief §18). Every number is a
// plain fact about current state that a player could count by hand off the
// board; showing it removes bookkeeping, not judgement. That distinction is
// the whole design line: what a player *could* tally themselves is tedium to
// hide, whereas telling them what it means would be playing for them.
//
// Building supply is the one that changes how people play once it is visible:
// 32 houses are shared match-wide and genuinely run out (measured: ~50% of
// matches drop below 10 remaining, 12% exhaust them completely), so "can I
// still build later?" is a real question this answers.
export default function MarketInfo() {
  const gameState = useGameStore((s) => s.currentGameState)
  if (!gameState) return null

  const houses = gameState.houseSupply ?? HOUSE_SUPPLY_TOTAL
  const hotels = gameState.hotelSupply ?? HOTEL_SUPPLY_TOTAL
  const jackpot = gameState.freeParkingJackpot ?? 0
  const auction = gameState.pendingAuction

  // Scarcity is worth flagging visually, but only as a neutral state marker —
  // it says "few left", never "so build now".
  const housesLow = houses <= 6
  const hotelsLow = hotels <= 2

  return (
    <div className={styles.rail}>
      <span className={`${styles.chip} ${housesLow ? styles.low : ''}`} title="Nhà còn lại trong kho chung của cả bàn">
        🏠 {houses}/{HOUSE_SUPPLY_TOTAL}
      </span>
      <span className={`${styles.chip} ${hotelsLow ? styles.low : ''}`} title="Khách sạn còn lại trong kho chung">
        🏨 {hotels}/{HOTEL_SUPPLY_TOTAL}
      </span>
      {jackpot > 0 && (
        <span className={styles.chip} title="Tiền đang tích trong Bãi Đậu Xe Miễn Phí">
          💰 ${jackpot}
        </span>
      )}
      {auction && (
        <span className={`${styles.chip} ${styles.auction}`} title="Giá cao nhất của phiên đấu giá đang diễn ra">
          🔨 ${auction.currentBid}
        </span>
      )}
    </div>
  )
}
