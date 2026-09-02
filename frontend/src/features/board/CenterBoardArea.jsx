import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useGameStore } from '../../store/gameStore'
import { getRoom } from '../../network/api'
import styles from './CenterBoardArea.module.css'

// How long a "+$200" Pass GO callout stays up (2026-08-25, user request:
// "khi ai qua ô bắt đầu thì hiển thị to ở giữa bàn cờ là +200"). Kept
// noticeably longer than PlayersPanel.jsx's own per-player money floats
// (2.4s) — this one is meant to be read by the WHOLE table, including
// whoever isn't the one who moved, not just glanced at by the player it
// happened to.
const PASS_GO_NOTICE_MS = 3200

// ─────────────────────────────────────────────────────────────────────────
// Trống Đồng Đông Sơn — the board's center medallion (2026-08-23, user
// request: a traditional-Vietnamese image for the middle of the board).
//
// Drawn as one inline SVG on a 0-200 viewBox (centre 100,100) rather than
// as nested divs: every element below is a real concentric band, which is
// exactly what a Đông Sơn drum face is, and SVG is the only way to place
// them accurately. Same "hand-drawn SVG, no external asset" approach
// TileIcon.jsx already established for this project (no image-generation
// tool exists here — confirmed with the user during the GO-tile art pass).
//
// The counts are the real artefact's, not decorative guesses: the Ngọc Lũ
// drum's central sun has **14 rays**, and its bird band carries stylised
// Lạc birds flying counter-clockwise — both reproduced at 14 here so the
// two bands line up radially. Point lists are COMPUTED below rather than
// written out as literal path strings, so the geometry is verifiable by
// structure rather than by eye — the same discipline GoTileArt.jsx/
// TileIcon.jsx's own headers already set for board art in this codebase.
//
// Deliberately low-contrast (see .drum's own opacity in the CSS module):
// this is the board's *printed surface art*, and DiceRoll.jsx lands its
// dice directly on top of the star (it's absolutely positioned at .board's
// dead centre, which is this cell's centre too). Dice legibility wins over
// medallion contrast — a real drum face under real dice reads exactly like
// this.
// ─────────────────────────────────────────────────────────────────────────

const C = 100 // viewBox centre, both axes

// -90deg offset so angle 0 points straight up, which is where every band
// below starts — keeps the star's top ray, the first bird and the first
// circle-motif all on the same vertical axis.
const polarX = (r, deg) => C + r * Math.cos((deg - 90) * (Math.PI / 180))
const polarY = (r, deg) => C + r * Math.sin((deg - 90) * (Math.PI / 180))

/** Alternating outer/inner vertices — a `rays`-pointed star as one polygon. */
function starPoints(rays, outerR, innerR) {
  const points = []
  for (let i = 0; i < rays * 2; i += 1) {
    const r = i % 2 === 0 ? outerR : innerR
    const deg = (180 / rays) * i
    points.push(`${polarX(r, deg).toFixed(2)},${polarY(r, deg).toFixed(2)}`)
  }
  return points.join(' ')
}

/** "Răng lược" comb-tooth band — one continuous zigzag between two radii. */
function sawtoothPath(teeth, innerR, outerR) {
  const step = 360 / teeth
  const segments = []
  for (let i = 0; i < teeth; i += 1) {
    const a0 = step * i
    const a1 = step * (i + 0.5)
    segments.push(
      `M${polarX(innerR, a0).toFixed(2)},${polarY(innerR, a0).toFixed(2)}` +
        `L${polarX(outerR, a1).toFixed(2)},${polarY(outerR, a1).toFixed(2)}` +
        `L${polarX(innerR, a0 + step).toFixed(2)},${polarY(innerR, a0 + step).toFixed(2)}`
    )
  }
  return segments.join('')
}

const ringAngles = (count) => Array.from({ length: count }, (_, i) => (360 / count) * i)

const RAYS = 14 // the Ngọc Lũ drum's real ray count — reused for the bird and motif bands so all three align radially

// One stylised Lạc bird ("chim Lạc"), drawn around a local origin and
// flying toward -x; placed at the top of its band and then rotated around
// the medallion, which makes every bird fly counter-clockwise exactly as
// on the real drum. The long straight beak is the defining feature.
const LAC_BIRD = (
  <>
    <path d="M-4.5 -1.3 L-15 0.3 L-4.5 1.5 Z" />
    <path d="M-5.6 -2.7 Q0 -4.4 5 -2.5 Q10.2 -0.8 13.8 2.7 Q8 2.5 3 2.3 Q-2 2.1 -5.6 1.3 Z" />
    <path d="M-1 -2.9 L2.6 -9.8 L7.6 -2.1 Z" />
    <path d="M12.2 2.3 L18.8 1.1 M12.8 3.1 L19 3.5" strokeWidth="0.9" fill="none" />
    <path d="M6 2.5 L10.6 6.2 M8.1 2.5 L12.6 6.6" strokeWidth="0.8" fill="none" />
  </>
)

function DongSonDrum() {
  return (
    <svg className={styles.drum} viewBox="0 0 200 200" aria-hidden="true">
      {/* Drum face: a warm bronze disc the bands are engraved into. */}
      <circle cx={C} cy={C} r="98" className={styles.drumFace} />

      {/* Outer rim — a double line, as on the cast originals. */}
      <circle cx={C} cy={C} r="97" className={styles.drumLine} />
      <circle cx={C} cy={C} r="93.5" className={styles.drumLine} />

      {/* Răng lược (comb teeth) band. */}
      <path d={sawtoothPath(42, 85, 92)} className={styles.drumLineThin} />
      <circle cx={C} cy={C} r="84" className={styles.drumLine} />

      {/* Chim Lạc band — the drum's most recognisable register. */}
      {ringAngles(RAYS).map((angle) => (
        <g key={`bird-${angle}`} transform={`rotate(${angle} ${C} ${C}) translate(${C} 29) scale(0.8)`} className={styles.drumSolid}>
          {LAC_BIRD}
        </g>
      ))}

      <circle cx={C} cy={C} r="55" className={styles.drumLine} />

      {/* "Vòng tròn đồng tâm có chấm giữa" — concentric-circle motifs. */}
      {ringAngles(RAYS).map((angle) => (
        <g key={`motif-${angle}`} transform={`rotate(${angle} ${C} ${C})`}>
          <circle cx={C} cy="52" r="5" className={styles.drumLineThin} />
          <circle cx={C} cy="52" r="2.4" className={styles.drumLineThin} />
          <circle cx={C} cy="52" r="0.9" className={styles.drumSolid} />
        </g>
      ))}

      <circle cx={C} cy={C} r="41" className={styles.drumLine} />

      {/* Dotted band. */}
      {ringAngles(RAYS * 2).map((angle) => (
        <circle key={`dot-${angle}`} cx={polarX(36, angle)} cy={polarY(36, angle)} r="1.1" className={styles.drumSolid} />
      ))}

      <circle cx={C} cy={C} r="31" className={styles.drumLine} />

      {/* Ngôi sao 14 cánh — the sun at the drum's centre. */}
      <polygon points={starPoints(RAYS, 27, 11.5)} className={styles.drumStar} />
      <circle cx={C} cy={C} r="5.4" className={styles.drumLineThin} />

      {/* Corner brackets — frames the round medallion inside its square
          cell, so the four corners of the board's centre don't read as
          unfinished dead space. */}
      {[0, 90, 180, 270].map((angle) => (
        <path
          key={`corner-${angle}`}
          d="M4 22 L4 4 L22 4"
          className={styles.drumLine}
          transform={`rotate(${angle} ${C} ${C})`}
        />
      ))}
    </svg>
  )
}

// Center-of-board status readout (2026-08-22, user request) — replaces the
// previous static "Cờ Tỷ Phú" wordmark, which never conveyed anything about
// the actual match. Rendered inside GameBoard.jsx's own `.center` grid
// cell. DiceRoll.jsx (GameBoard.jsx's own sibling, absolutely positioned
// inside `.board` at its exact dead-center — which is also `.center`'s own
// geometric middle, since the grid is symmetric) already owns the big
// tumbling dice; the status pill and the pass-GO callout are billboarded
// (counter-rotated against the board's camera transform) and each nudged a
// short way off dead-centre in screen space, so they stay upright and clear
// of the dice at any board rotation (CenterBoardArea.module.css) — this
// component only ever renders the small text, never gameState.lastRoll
// itself.
//
// Display names aren't on GameState.players (only playerId/turnOrder/...) —
// resolved the same way GameControls.jsx/PropertyManager.jsx already each
// independently do (GET /api/v1/rooms/:id, fetched once on mount) — this
// project's established "not centralized" precedent for this exact lookup,
// not an oversight.
export default function CenterBoardArea() {
  const { user, session } = useAuth()
  const roomId = useGameStore((s) => s.roomState?.roomId)
  const gameState = useGameStore((s) => s.currentGameState)
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
      .catch(() => {}) // a name-lookup failure is a UX nicety miss only, never blocks gameplay
  }, [roomId, session.access_token])

  // The medallion is board *surface art* — it belongs there whether or not
  // a match has started, so it renders on both branches below.
  const me = gameState?.players.find((p) => p.playerId === user.id)
  const activePlayer = gameState?.players.find((p) => !p.isBank && p.turnOrder === gameState.currentTurnIndex)
  const isMyTurn = me != null && me.turnOrder === gameState.currentTurnIndex
  const nameFor = (player) => displayNames[player?.playerId] ?? player?.playerId ?? '…'

  // Pass GO callout (2026-08-25, user request: "khi ai qua ô bắt đầu thì
  // hiển thị to ở giữa bàn cờ là +200"). Driven by the store's raw
  // `transactions` batch — exactly "what this one broadcast just caused" —
  // the same technique PlayersPanel.jsx's per-player money floats already
  // use, deduped by `stateVersion` so a reconnect resync (which redelivers
  // the same broadcast) can never double-fire it. `toGamePlayerId` is
  // already `PlayerGameState.id`, the id space `gameState.players` itself
  // keys on — no translation needed (the id-space trap finding #36 was
  // made of).
  const [passGoNotices, setPassGoNotices] = useState([])
  const seenPassGoVersionRef = useRef(null)

  useEffect(() => {
    if (stateVersion == null || seenPassGoVersionRef.current === stateVersion) return
    seenPassGoVersionRef.current = stateVersion
    const passGoTxs = (transactions ?? []).filter((t) => t.transactionType === 'pass_go_salary')
    if (passGoTxs.length === 0) return
    const born = Date.now()
    setPassGoNotices((current) => [
      ...current,
      ...passGoTxs.map((t) => ({ id: `${stateVersion}:${t.toGamePlayerId}`, playerId: t.toGamePlayerId, amount: t.amount, born })),
    ])
  }, [stateVersion, transactions])

  // Same age-based pruning as PlayersPanel's own money floats, for the same
  // reason: a per-item setTimeout registered inside the effect above would
  // be cancelled by that effect's own cleanup on the very next broadcast,
  // leaving a notice on screen forever.
  useEffect(() => {
    if (passGoNotices.length === 0) return
    const timer = setTimeout(
      () => setPassGoNotices((current) => current.filter((n) => Date.now() - n.born < PASS_GO_NOTICE_MS)),
      PASS_GO_NOTICE_MS
    )
    return () => clearTimeout(timer)
  }, [passGoNotices])

  return (
    <>
      <div className={styles.drumLayer}>
        <DongSonDrum />
      </div>
      {/* One billboard anchor for every centre-board text overlay (turn
          status, Pass GO callout, pre-game wordmark). It counter-rotates
          against the board's camera transform so its contents stay upright,
          level and centred on the board at any spin/tilt, and it's a FLAT
          subtree — so each child's own `translateY` nudge is a pure
          screen-space offset, not one that couples into board-space depth and
          sinks the element behind `.center`'s felt. See
          CenterBoardArea.module.css. */}
      <div className={styles.calloutAnchor}>
        {passGoNotices.length > 0 && (
          <div className={styles.passGoLayer}>
            {passGoNotices.map((n) => {
              const player = gameState?.players.find((p) => p.id === n.playerId)
              return (
                <p key={n.id} className={styles.passGoNotice}>
                  <span className={styles.passGoAmount}>+${n.amount}</span>
                  <span className={styles.passGoLabel}>
                    {n.playerId === me?.id ? 'Bạn' : nameFor(player)} qua Ô Bắt Đầu
                  </span>
                </p>
              )
            })}
          </div>
        )}
        {gameState ? (
          <p className={styles.turnStatus}>{isMyTurn ? 'Đến lượt của bạn' : `Đến lượt của ${nameFor(activePlayer)}`}</p>
        ) : (
          <span className={styles.wordmark}>Cờ Tỷ Phú</span>
        )}
      </div>
    </>
  )
}
