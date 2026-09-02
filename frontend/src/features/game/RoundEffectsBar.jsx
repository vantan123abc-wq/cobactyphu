import { useGameStore } from '../../store/gameStore'
import styles from './RoundEffectsBar.module.css'

// Shared "what is affecting this round" readout (2026-08-23, user request:
// event cards whose effect lasts a whole round must be shown *chung* — to
// everyone at once — not just to whoever drew them).
//
// Reads GameState's two genuinely global, round-scoped modifiers directly;
// nothing is inferred from the card that set them. Both are reset to 0 by
// turnMachine.js's advanceTurn() at the real round-wraparound boundary
// (domain/gameState.js documents each field), so "hết vòng này" below is
// the literal truth, not a UI approximation:
//   - rentModifierPercent    K01 Thị Trường Sôi Động +10 / K02 Suy Thoái -10
//   - buildCostModifierAmount K07 Giá Vật Liệu Tăng +50 / K08 Giảm Giá -50
// Both already reach every client on the normal S2C_STATE_UPDATE broadcast
// (socketServer.js emits the whole gameState, unfiltered) — this needed no
// backend or protocol change at all.
//
// Renders nothing at all when neither modifier is active, which is the
// common case — an always-present "no effects" row would be pure noise.
export default function RoundEffectsBar() {
  const gameState = useGameStore((s) => s.currentGameState)
  if (!gameState) return null

  const rent = gameState.rentModifierPercent ?? 0
  const build = gameState.buildCostModifierAmount ?? 0
  if (rent === 0 && build === 0) return null

  return (
    <div className={styles.bar}>
      {rent !== 0 && (
        <span className={`${styles.chip} ${rent > 0 ? styles.bad : styles.good}`}>
          <span className={styles.icon}>{rent > 0 ? '📈' : '📉'}</span>
          <span className={styles.label}>
            Giá thuê {rent > 0 ? `+${rent}` : rent}%
          </span>
          <span className={styles.duration}>hết vòng này</span>
        </span>
      )}
      {build !== 0 && (
        <span className={`${styles.chip} ${build > 0 ? styles.bad : styles.good}`}>
          <span className={styles.icon}>🧱</span>
          <span className={styles.label}>
            Phí xây {build > 0 ? `+$${build}` : `-$${Math.abs(build)}`}
          </span>
          <span className={styles.duration}>hết vòng này</span>
        </span>
      )}
    </div>
  )
}
