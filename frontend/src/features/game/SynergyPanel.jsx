import { useMemo, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useGameStore } from '../../store/gameStore'
import { GROUP_COLORS, playerColor } from '../board/tileVisuals'
import { ARCHETYPE_MEMBERS, playerSynergies } from '../board/synergy'
import styles from './SynergyPanel.module.css'

// Thế Lực readout (2026-09-04, user request: "hãy thiết kế 1 mục để người chơi
// biết màu gì có buff gì và tiến độ hoàn thành màu của người chơi như kiểu
// tft hoặc cờ liên quân").
//
// Why this needs to exist at all: an ASYMMETRIC synergy is a property of a
// whole PORTFOLIO, derived on the fly by engine/synergyEngine.js and stored
// nowhere. Before this panel, the only trace of it anywhere in the UI was a
// coloured ring on the board tiles already feeding one — which tells you what
// you have finished, never what you are working toward, and never what the
// reward would be. A player could hold four Bình Dân tiles and have no way to
// learn that a fifth changes nothing while a second Bến Xe unlocks a teleport.
//
// ASYMMETRIC only, and self-gating: CLASSIC has no archetypes, and mounting
// this unconditionally would put an empty box in its right rail.
//
// The tier thresholds and counting rule are synergy.js's mirror of the real
// engine, INCLUDING the rule that mortgaged deeds do not count — surfaced
// explicitly here (rather than silently subtracted) because losing a tier by
// mortgaging is a genuinely surprising way to lose one.

/** Small coloured chips naming which board colours feed an archetype. */
function MemberChips({ archetype }) {
  const groups = ARCHETYPE_MEMBERS[archetype] ?? []
  if (groups.length === 0) {
    return (
      <span className={styles.memberNote}>
        {archetype === 'MOBILITY' ? 'mọi Bến Xe' : 'mọi Công Ty'}
      </span>
    )
  }
  return (
    <span className={styles.members}>
      {groups.map((g) => (
        <span key={g} className={styles.memberDot} style={{ background: GROUP_COLORS[g] }} title={g} />
      ))}
    </span>
  )
}

export default function SynergyPanel() {
  const { user } = useAuth()
  const gameState = useGameStore((s) => s.currentGameState)
  const staticBoard = useGameStore((s) => s.staticBoard)
  const [viewedPlayerId, setViewedPlayerId] = useState(null)
  const [isExpanded, setIsExpanded] = useState(true)

  const realPlayers = gameState?.players?.filter((p) => !p.isBank) ?? []
  const me = realPlayers.find((p) => p.playerId === user.id) ?? null
  // Defaults to your own board, but every player is inspectable — knowing an
  // opponent is one tile from a Tử Địa tier is exactly the kind of thing this
  // mode wants you to be able to see and react to.
  const viewed = realPlayers.find((p) => p.id === viewedPlayerId) ?? me ?? realPlayers[0] ?? null

  const rows = useMemo(
    () => (viewed ? playerSynergies(gameState?.properties, staticBoard?.tiles, viewed.id) : []),
    [gameState?.properties, staticBoard, viewed]
  )

  const activeCount = rows.filter((r) => r.tier > 0).length

  if (!gameState || gameState.ruleset !== 'ASYMMETRIC' || !viewed) return null

  return (
    <section className={`${styles.panel} ${isExpanded ? styles.expanded : ''}`}>
      {/* Collapsible, the same shape every other panel in this rail uses
          (MyPortfolio / CardInventory / Ledger all have this exact header
          button). It is not decoration: the rail is a fixed-height flex
          column, and six always-expanded archetype rows pushed the panels
          below it out of their own space — the overlapping mess a real
          screenshot caught. The count badge shows how many Thế Lực are
          actually ACTIVE, so the number worth knowing survives collapsing. */}
      <button
        type="button"
        className={styles.headerBtn}
        onClick={() => setIsExpanded(!isExpanded)}
        title={isExpanded ? 'Thu gọn' : 'Mở rộng'}
      >
        <h2 className={styles.heading}>Thế Lực</h2>
        <span className={styles.count}>{activeCount}</span>
        <span className={styles.toggleIcon}>{isExpanded ? '▼' : '▶'}</span>
      </button>

      {isExpanded && realPlayers.length > 1 && (
        <div className={styles.playerTabs}>
          {realPlayers.map((p) => (
            <button
              key={p.id}
              type="button"
              className={p.id === viewed.id ? `${styles.playerTab} ${styles.playerTabActive}` : styles.playerTab}
              style={{ '--tab-color': playerColor(p) }}
              onClick={() => setViewedPlayerId(p.id)}
              title={p.playerId ?? p.id}
            >
              {p.id === me?.id ? 'Bạn' : (p.playerId ?? '?').slice(0, 6)}
            </button>
          ))}
        </div>
      )}

      {isExpanded && (
      <ul className={styles.list}>
        {rows.map((row) => {
          const active = row.tier > 0
          const maxThreshold = row.thresholds[row.thresholds.length - 1] ?? 0
          // Progress runs toward the NEXT tier, not the last one — the bar
          // should fill as you approach something that actually happens.
          const target = row.nextThreshold ?? maxThreshold
          const pct = target > 0 ? Math.min(100, (row.owned / target) * 100) : 0
          return (
            <li
              key={row.archetype}
              className={active ? `${styles.row} ${styles.rowActive}` : styles.row}
              style={{ '--arch-color': row.meta.color }}
            >
              <div className={styles.rowHead}>
                <span className={styles.pips} aria-hidden="true">
                  {row.thresholds.map((_, i) => (
                    <span key={i} className={i < row.tier ? `${styles.pip} ${styles.pipOn}` : styles.pip} />
                  ))}
                </span>
                <span className={styles.name}>{row.meta.label}</span>
                <MemberChips archetype={row.archetype} />
                <span className={styles.count}>
                  {row.owned}
                  <span className={styles.countTarget}>/{target}</span>
                </span>
              </div>

              <div className={styles.bar}>
                <div className={styles.barFill} style={{ width: `${pct}%` }} />
                {/* Threshold ticks, so the whole ladder is visible at a glance
                    rather than only the next rung. */}
                {row.thresholds.map((t) => (
                  <span
                    key={t}
                    className={row.owned >= t ? `${styles.tick} ${styles.tickOn}` : styles.tick}
                    style={{ left: `${maxThreshold > 0 ? (t / maxThreshold) * 100 : 0}%` }}
                    title={`Mốc ${t} ô`}
                  />
                ))}
              </div>

              <p className={styles.effect}>
                {row.effects.unimplemented ? (
                  <span className={styles.effectNone}>Chưa có hiệu ứng trong bản hiện tại</span>
                ) : (
                  <>
                    <span className={styles.effectLine}>
                      🚶 {row.effects.passThrough}
                      {row.effects.passThroughTier != null && (
                        <em className={styles.effectGate}> (cần mốc {row.thresholds[row.effects.passThroughTier - 1]} ô)</em>
                      )}
                    </span>
                    {row.effects.landing && (
                      <span className={styles.effectLine}>
                        🎯 {row.effects.landing}
                        {row.effects.landingTier != null && (
                          <em className={styles.effectGate}> (cần mốc {row.thresholds[row.effects.landingTier - 1]} ô)</em>
                        )}
                        {row.effects.landingMaxNote != null && (
                          <em className={styles.effectGate}> ({row.effects.landingMaxNote})</em>
                        )}
                      </span>
                    )}
                  </>
                )}
              </p>

              <p className={styles.status}>
                {row.tier === 0
                  ? row.nextThreshold != null
                    ? `Còn ${row.nextThreshold - row.owned} ô nữa để kích hoạt`
                    : 'Không thể kích hoạt'
                  : row.nextThreshold != null
                    ? `Đang ở cấp ${row.tier} — còn ${row.nextThreshold - row.owned} ô nữa lên cấp ${row.tier + 1}`
                    : `Cấp tối đa ${row.tier}/${row.thresholds.length}`}
                {row.mortgaged > 0 && (
                  <span className={styles.mortgagedWarn}> · {row.mortgaged} ô đang cầm cố không được tính</span>
                )}
                <span className={styles.onBoard}> · {row.onBoard} ô trên bàn</span>
              </p>
            </li>
          )
        })}
      </ul>
      )}
    </section>
  )
}
