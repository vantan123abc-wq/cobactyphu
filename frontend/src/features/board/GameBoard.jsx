import { useEffect, useMemo, useRef, useState } from 'react'
import { useGameStore } from '../../store/gameStore'
import BoardTile from './BoardTile'
import DiceRoll from './DiceRoll'
import CenterBoardArea from './CenterBoardArea'
import ZodiacFigure from './ZodiacFigure'
import { clampZoom, tweenSpinTo } from './cameraControls'
import { playerColor, playerInitial } from './tileVisuals'
import { ownerTypeCounts, rentLabel, ownsFullGroup } from './rentPreview'
import { synergyByTileId } from './synergy'
import { trapLabel } from './traps'
import styles from './GameBoard.module.css'

// P11-T02/T03/T04 — the board grid. Deliberately NOT hardcoded to the
// classic real-world 40-tile layout (4 corners + 9/edge) — this project's
// own approved design (docs/ADAPTIVE_BOARD_DESIGN.md, "fully approved,
// locked numbers") uses two different sizes instead: Small = 36 tiles (4
// corners + 8/edge, 2-4 players), Large = 44 tiles (4 corners + 10/edge,
// 5-6 players), selected server-side by player count. computeGridPosition()
// below is derived from the *real* corner positions (0/9/18/27 for Small,
// 0/11/22/33 for Large — backend/supabase/seed/boards.sql) and the general
// edgeLength, so this same component renders either board correctly
// without a code change — "40" never appears here.
//
// Tiles come from useGameStore's `staticBoard` (GET /api/v1/boards/:boardId
// — network/socketClient.js fetches it once it learns the current game's
// boardId from a real S2C_STATE_UPDATE, not from mock data anymore).
// Players come from the live `currentGameState.players`. Both can
// legitimately be absent (no game has started yet, or the board fetch
// hasn't resolved) — rendered as a loading state below, not a crash.
//
// P11-T09: tiles are now also matched against `currentGameState.properties`
// (game-scoped ownership rows, keyed by `boardTileId`) — the same lookup
// PropertyManager.jsx needs, computed once here rather than duplicated per
// tile. A tile only becomes clickable (`onClick` passed to BoardTile at all)
// when it has a matching Property row — 'go'/'chance'/'fortune'/'tax'/the
// corners never do (domain/property.js: one row "per property-type tile",
// which this codebase's real taxonomy extends to transport/utility too,
// since those are also ownable/mortgageable — see tile.js's own
// `mortgageValue` JSDoc, "only set for property/transport/utility"). Not
// gated on the local player owning it — PropertyManager.jsx itself is what
// decides which actions are actually available once a property is selected;
// selecting is just "show me this tile's details."
//
// Board animation slice (2026-08-21): player tokens moved out of
// BoardTile.jsx's own per-tile rendering into the `tokenLayer` overlay
// below. Reason: CSS Grid has no way to animate a `grid-row`/`grid-column`
// change (they're not interpolatable properties), so a token that's a grid
// item of "whichever tile currently owns it" can only ever teleport between
// tiles, never slide. The overlay instead positions each token with plain
// `left`/`top` percentages (computed from the exact same computeGridPosition
// this file already uses for tile placement, so the two can never disagree
// about where a given board position actually sits) — a percentage change on
// a persistent, stably-keyed (`key={player.id}`) DOM node is something CSS
// `transition` handles natively, no animation library needed (this project's
// own deliberately-minimal-dependencies stance). GameBoard.module.css's
// `.token` rule owns the actual transition timing.
//
// Step-by-step movement + camera, 2026-08-22 (user request): a straight
// left/top CSS transition between two positions cuts a diagonal line across
// the board for any multi-tile move, which doesn't read as "walking the
// board." useWalkingPositions() below tracks a *displayed* position per
// player, separate from the real currentPosition, and hops it forward one
// tile at a time when a move looks like a genuine walk (its forward delta
// matches the real gameState.lastRoll.total) — a teleport (Go To Jail, an
// event-card send) doesn't match that and renders as a direct jump instead,
// same as before, rather than fake-walking a path never actually taken.

const CORNER_TYPES = new Set(['go', 'jail', 'free_parking', 'go_to_jail'])
const EMPTY_PLAYERS = [] // a stable fallback reference — `?? []` inline would create a new array every render, defeating useMemo below
// Per-tile hop duration. Raised from 130ms to 220ms 2026-08-25 (user
// request: "tốc độ di chuyển từng ô... chậm rãi hơn") — slow enough to
// actually watch each tile go by rather than reading as a fast blur, still
// short enough that a maximum single-roll walk (12 tiles, double sixes)
// takes under 2.7s and doesn't stall the turn. Coupled 1:1 with
// GameBoard.module.css's `.token` transition duration AND `.tokenHop`'s own
// animation-duration below — all three must change together, or the
// horizontal glide and the vertical hop drift out of sync with each other
// mid-walk.
const STEP_MS = 220

// How long the piece stands on the Go To Jail tile before being taken away.
// The whole point of walking there at all is that the player gets to SEE the
// cause, so it has to outlast a glance — a straight cut would look identical
// to the teleport this replaces.
const JAIL_HOP_PAUSE_MS = 620

/**
 * Maps a tile's board `position` to a 1-indexed { row, col } grid cell,
 * for any board built from 4 corners + `edgeLength` tiles per edge — true
 * for both approved board sizes (8 for Small, 10 for Large). Loop order
 * (confirmed by the real seed data): GO -> up the left edge -> Jail ->
 * right along the top edge -> Free Parking -> down the right edge ->
 * Go-To-Jail -> left along the bottom edge -> back to GO.
 */
function computeGridPosition(position, edgeLength) {
  const size = edgeLength + 2
  const jailCorner = edgeLength + 1
  const parkingCorner = 2 * edgeLength + 2
  const goToJailCorner = 3 * edgeLength + 3

  if (position === 0) return { row: size, col: 1 } // GO
  if (position < jailCorner) return { row: size - position, col: 1 } // left edge
  if (position === jailCorner) return { row: 1, col: 1 }
  if (position < parkingCorner) return { row: 1, col: position - jailCorner + 1 } // top edge
  if (position === parkingCorner) return { row: 1, col: size }
  if (position < goToJailCorner) return { row: position - parkingCorner + 1, col: size } // right edge
  if (position === goToJailCorner) return { row: size, col: size }
  return { row: size, col: size - (position - goToJailCorner) } // bottom edge
}

/**
 * Which of the board's four edges a position sits on ('corner' for the four
 * corner tiles). Deliberately a separate function rather than an extra
 * return value on computeGridPosition above — that one is correctness-
 * critical and already covered by real verification, so this reads the same
 * corner boundaries independently instead of reshaping it.
 *
 * Board-layout slice, 2026-08-22: tile content is laid flat on the board and
 * rotated to run parallel to its own edge (the way a real board game prints
 * it — see BoardTile.module.css), which needs to know the edge per tile.
 */
function computeEdge(position, edgeLength) {
  const jailCorner = edgeLength + 1
  const parkingCorner = 2 * edgeLength + 2
  const goToJailCorner = 3 * edgeLength + 3

  if (position === 0 || position === jailCorner || position === parkingCorner || position === goToJailCorner) {
    return 'corner'
  }
  if (position < jailCorner) return 'left'
  if (position < parkingCorner) return 'top'
  if (position < goToJailCorner) return 'right'
  return 'bottom'
}

// Multiple players sharing one tile (2026-08-22, user request) — the old
// single-axis `--token-offset-x` spread crowded tokens into an unreadable
// overlapping line once 3-4 players shared a tile (near-certain at GO on
// turn 1 of a 4+ player game). Arranges them into a small centered grid
// instead — 2 columns up to 4 players, 3 columns for 5-6 (MAX_PLAYERS=6,
// GAME_DESIGN_SPEC.md §0) — reusing the same flat-px offset convention (not
// scaled by --side) the original single-axis version already used, so it
// still composes correctly with .token's own isometric counter-rotation
// (GameBoard.module.css) and reads as a real on-screen 2D nudge, not skewed
// by the board's own tilt.
// Widened 15 -> 26 (2026-08-23) alongside the ~1.8x bigger standee pieces —
// the old spacing was tuned for the small cube token and left the new
// figures almost entirely overlapping whenever 2+ players shared a tile.

const TOKEN_CELL_PX = 26
function computeTokenOffset(index, total) {
  if (total <= 1) return { x: 0, y: 0 }
  const columns = Math.ceil(Math.sqrt(total))
  const rows = Math.ceil(total / columns)
  const col = index % columns
  const row = Math.floor(index / columns)
  return {
    x: (col - (columns - 1) / 2) * TOKEN_CELL_PX,
    y: (row - (rows - 1) / 2) * TOKEN_CELL_PX,
  }
}

// Jail's own two-zone token split (2026-08-22, user request — "Trong Tù"
// vs "Thăm Nuôi", matching real Monopoly rules and JailArt.jsx's own
// two-zone art): a genuinely jailed player and a player merely passing
// through both legitimately share the exact same board `position` (the
// Jail tile's), and previously rendered identically, lumped into the same
// overlap-avoidance grid with no way to tell them apart. Splits `group` by
// the real `player.inJail` flag and gives each sub-group its own fixed
// anchor on top of the normal computeTokenOffset spread — jailed players
// pulled toward the tile's own visual "behind bars" center, visitors
// toward its outer "sidewalk" margin. Every other position keeps the exact
// same single-group behavior as before; this only branches for one
// specific tile.
const JAIL_ZONE_Y = { inJail: -16, visiting: 19 }
function tokensForPosition(position, group, jailPosition) {
  if (position !== jailPosition) {
    return group.map((player, index) => {
      const { x, y } = computeTokenOffset(index, group.length)
      return { player, x, y }
    })
  }
  const jailed = group.filter((p) => p.inJail)
  const visiting = group.filter((p) => !p.inJail)
  return [
    ...jailed.map((player, index) => {
      const { x, y } = computeTokenOffset(index, jailed.length)
      return { player, x, y: y + JAIL_ZONE_Y.inJail }
    }),
    ...visiting.map((player, index) => {
      const { x, y } = computeTokenOffset(index, visiting.length)
      return { player, x, y: y + JAIL_ZONE_Y.visiting }
    }),
  ]
}

const EMPTY_PROPERTIES = [] // same stable-reference reasoning as EMPTY_PLAYERS above
const EMPTY_TRAPS = [] // ditto — activeTraps/lastTrapHits are both ASYMMETRIC-only and usually absent
const EMPTY_SYNERGY = new Map() // ditto, for the CLASSIC path that computes no synergies at all

// How long a "bẫy phát nổ" marker stays on the tile it fired on. Long enough
// that a player who was looking elsewhere still catches it, short enough not
// to sit on top of the next player's turn.
const TRAP_BOOM_MS = 2600

/**
 * Shows the traps that just went off, then clears them.
 *
 * Keyed off `lastTrapHitSeq`, never `stateVersion` — the field exists for
 * exactly this and its own JSDoc (domain/gameState.js) explains why:
 * stateVersion bumps on every action anyone in the match takes, so an
 * explosion keyed to it would re-detonate on every later unrelated action.
 * That is finding #37's bug, already fixed once for the dice.
 */
function useTrapBooms(lastTrapHits, lastTrapHitSeq) {
  const [booms, setBooms] = useState(EMPTY_TRAPS)
  useEffect(() => {
    if (!lastTrapHits.length) return
    setBooms(lastTrapHits)
    const timer = setTimeout(() => setBooms(EMPTY_TRAPS), TRAP_BOOM_MS)
    return () => clearTimeout(timer)
    // lastTrapHits is deliberately NOT a dependency: it is a fresh array on
    // every single broadcast (a new object off the wire), so depending on it
    // would restart the timer on every unrelated state update and leave the
    // marker on screen indefinitely. The seq counter is the real signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastTrapHitSeq])
  return booms
}

/**
 * Tracks each player's *displayed* board position, separate from their real
 * `currentPosition`, and animates it one tile at a time for a genuine walk
 * (see this file's own header). Returns `{ displayed, lastSettled, warpedAt }`
 * — `displayed` is what actually renders the token; `lastSettled` is each
 * player's position *before* their most recent move, kept around afterward as
 * the "you were just here" ghost marker (GameBoard.module.css's
 * `.fromGhost`), not cleared until their next move; `warpedAt` names the
 * tile a player last arrived at WITHOUT walking, so the token can fade in
 * there rather than silently blinking into place.
 *
 * Walks BACKWARDS too, as of 2026-09-04 (ASYMMETRIC's BACKUP_3, and MOBILITY's
 * own backward NUDGE). `lastRoll.total` carries an unsigned distance — the
 * server does not say which way (see turnMachine.js's handlePlayMovementCard
 * for why) — so the direction is recovered by testing the real position delta
 * both ways round. That is unambiguous: the two readings can only agree at
 * exactly half a lap (18 tiles on Small, 22 on Large), and nothing in either
 * ruleset moves a player that far in one go (12 on dice, SPRINT_12 plus a
 * nudge on cards).
 *
 * Hook rules require this to run on every render (including before
 * `staticBoard` has loaded) — callers pass a safe fallback `totalTiles` for
 * that case; nothing actually renders off it until the real board exists.
 */
function useWalkingPositions(players, lastRoll, totalTiles, jailEvent) {
  const [displayed, setDisplayed] = useState(() => {
    const m = new Map()
    for (const p of players) m.set(p.id, p.currentPosition)
    return m
  })
  const [lastSettled, setLastSettled] = useState(() => new Map())
  const [warpedAt, setWarpedAt] = useState(() => new Map())
  // Second-leg timers, kept apart from timersRef's intervals so cleanup can
  // use the right clear* for each. A player present in EITHER map is still
  // mid-animation and must not have a fresh walk started for them.
  const jailHopRef = useRef(new Map()) // playerId -> timeoutId
  const displayedRef = useRef(displayed)
  displayedRef.current = displayed
  const timersRef = useRef(new Map()) // playerId -> intervalId, so a real position update mid-walk doesn't start a second, overlapping walk for the same player

  useEffect(() => {
    for (const p of players) {
      const from = displayedRef.current.get(p.id)
      if (from === undefined) {
        // A player this hook has never seen before (first render after
        // joining the animated view) — seed directly, nothing to walk from.
        setDisplayed((prev) => new Map(prev).set(p.id, p.currentPosition))
        continue
      }
      if (from === p.currentPosition || timersRef.current.has(p.id) || jailHopRef.current.has(p.id)) continue

      // Landing on Go To Jail is the one move whose real destination is NOT
      // where the player walked to: the server relocates them to the jail
      // tile in the same transition, so `p.currentPosition` is already the
      // jail corner and the tile that caused it never appears in any
      // position this component is told about. gameState.lastJailEvent
      // carries it back as `viaPosition` precisely so the walk can be shown.
      //
      // Deliberately self-validating rather than trusted: the waypoint is
      // only used when walking there actually matches the reported roll. A
      // stale event (one whose seq belongs to an earlier turn) therefore
      // can't hijack an unrelated move — the arithmetic simply won't line up
      // and this falls back to the normal single-leg behaviour.
      const via =
        jailEvent != null && jailEvent.playerId === p.id && jailEvent.viaPosition != null
          ? jailEvent.viaPosition
          : null
      const viaDelta = via == null ? -1 : ((via - from) % totalTiles + totalTiles) % totalTiles
      const useVia = via != null && lastRoll != null && viaDelta === lastRoll.total && via !== p.currentPosition

      const legTarget = useVia ? via : p.currentPosition
      const forwardDelta = ((legTarget - from) % totalTiles + totalTiles) % totalTiles
      const backwardDelta = (totalTiles - forwardDelta) % totalTiles
      const walkDirection =
        lastRoll == null ? 0 : forwardDelta === lastRoll.total ? 1 : backwardDelta === lastRoll.total ? -1 : 0

      setLastSettled((prev) => new Map(prev).set(p.id, from))

      if (walkDirection === 0) {
        // A teleport (Go To Jail, an event-card move, MOBILITY's own forced
        // jump, or any move whose distance the server didn't report) — jump
        // straight there rather than fake-walking a path never taken, same
        // as before this slice. Recorded in `warpedAt` so the token can fade
        // in at the destination instead of appearing with no explanation.
        setWarpedAt((prev) => new Map(prev).set(p.id, p.currentPosition))
        setDisplayed((prev) => new Map(prev).set(p.id, p.currentPosition))
        continue
      }

      // A real walk clears any earlier warp marker for this player, so the
      // fade-in can never replay on a subsequent ordinary move.
      setWarpedAt((prev) => (prev.has(p.id) ? new Map([...prev].filter(([id]) => id !== p.id)) : prev))

      let step = from
      const target = legTarget
      const finalPosition = p.currentPosition
      const playerId = p.id
      const intervalId = setInterval(() => {
        step = (step + walkDirection + totalTiles) % totalTiles
        setDisplayed((prev) => new Map(prev).set(playerId, step))
        if (step !== target) return

        clearInterval(intervalId)
        timersRef.current.delete(playerId)
        if (target === finalPosition) return

        // Second leg: they walked onto Go To Jail, stood there long enough to
        // be seen, and are now taken to the cells. Rendered as a warp rather
        // than a walk — being marched to jail is not a journey around the
        // board, and walking it would retrace tiles they never crossed.
        const hopId = setTimeout(() => {
          jailHopRef.current.delete(playerId)
          setWarpedAt((prev) => new Map(prev).set(playerId, finalPosition))
          setDisplayed((prev) => new Map(prev).set(playerId, finalPosition))
        }, JAIL_HOP_PAUSE_MS)
        jailHopRef.current.set(playerId, hopId)
      }, STEP_MS)
      timersRef.current.set(p.id, intervalId)
    }
    // jailEvent joins the deps for correctness, not because it needs to
    // retrigger anything: it is a fresh object on every broadcast, exactly
    // like `players` already is, and the in-flight guards above (timersRef /
    // jailHopRef) are what actually stop a re-run from disturbing a walk.
  }, [players, lastRoll, totalTiles, jailEvent])

  // Unmount cleanup only — deliberately not re-run per players/lastRoll
  // change (that would clear an in-flight walk on every unrelated
  // broadcast); the effect above already owns cancelling/replacing its own
  // per-player timers via timersRef.
  useEffect(
    () => () => {
      for (const id of timersRef.current.values()) clearInterval(id)
      timersRef.current.clear()
      for (const id of jailHopRef.current.values()) clearTimeout(id)
      jailHopRef.current.clear()
    },
    []
  )

  return { displayed, lastSettled, warpedAt }
}

export default function GameBoard() {
  const staticBoard = useGameStore((s) => s.staticBoard)
  const players = useGameStore((s) => s.currentGameState?.players) ?? EMPTY_PLAYERS
  const properties = useGameStore((s) => s.currentGameState?.properties) ?? EMPTY_PROPERTIES
  const lastRoll = useGameStore((s) => s.currentGameState?.lastRoll) ?? null
  const currentTurnIndex = useGameStore((s) => s.currentGameState?.currentTurnIndex)
  const selectedPropertyId = useGameStore((s) => s.selectedPropertyId)
  const selectProperty = useGameStore((s) => s.selectProperty)
  const trapDraft = useGameStore((s) => s.trapDraft)
  const setTrapDraft = useGameStore((s) => s.setTrapDraft)
  const ruleset = useGameStore((s) => s.currentGameState?.ruleset)
  const activeTraps = useGameStore((s) => s.currentGameState?.activeTraps) ?? EMPTY_TRAPS
  const lastTrapHits = useGameStore((s) => s.currentGameState?.lastTrapHits) ?? EMPTY_TRAPS
  const lastTrapHitSeq = useGameStore((s) => s.currentGameState?.lastTrapHitSeq) ?? 0
  // Why someone was just jailed. Only `viaPosition` is used here (to walk the
  // piece onto the Go To Jail tile it actually landed on); the human-readable
  // announcement is CenterBoardArea.jsx's job.
  const lastJailEvent = useGameStore((s) => s.currentGameState?.lastJailEvent) ?? null
  const boardZoom = useGameStore((s) => s.boardZoom)
  const boardSpin = useGameStore((s) => s.boardSpin)
  const boardTilt = useGameStore((s) => s.boardTilt)
  const setBoardZoom = useGameStore((s) => s.setBoardZoom)

  // Measures the board's real container instead of estimating it
  // (2026-08-23). --side used to be a pure CSS formula subtracting
  // hard-coded chrome widths from 100vw/100vh (466px / 232px, with two more
  // variants per breakpoint). Those magic numbers were guesses at the
  // surrounding layout and were repeatedly wrong as that layout changed —
  // measured here: the vertical one reserved 232px while the real container
  // was 141px taller than the formula assumed, so the board came out
  // needlessly small and left a wide band of the column empty.
  // The container's own clientWidth/clientHeight is the exact answer, needs
  // no per-breakpoint variants, and can never drift from the real layout.
  // NOTE: the board's own --side is computed entirely in CSS now, from
  // `.viewport`'s container-query units (GameBoard.module.css). A JS
  // ResizeObserver measurement lived here briefly and caused a real
  // user-visible bug — it captured the container's box at attach time,
  // before the surrounding layout had settled, and could then render the
  // board at roughly a third of its proper size with nothing to correct it.
  // Only --spread/--vfactor are passed from here now, because only this
  // component knows the live camera angle.

  // Real tile count when known, an arbitrary safe placeholder otherwise —
  // see useWalkingPositions's own header for why this hook must run
  // unconditionally, before the `!staticBoard` early return below.
  const totalTiles = staticBoard?.tiles?.length || 40
  const { displayed: displayedPositions, lastSettled, warpedAt } = useWalkingPositions(players, lastRoll, totalTiles, lastJailEvent)

  const propertyByBoardTileId = useMemo(() => {
    const map = new Map()
    for (const property of properties) map.set(property.boardTileId, property)
    return map
  }, [properties])

  // Per-owner transport/utility holding counts (2026-08-25, user correction:
  // an owned tile's on-board price badge must show real RENT — what landing
  // there costs — not the purchase price; see rentPreview.js's own header).
  // Computed once per render here, not per-tile inside the map below, since
  // every tile a given owner holds needs the SAME count — recomputing it once
  // per owner is O(players), recomputing it per-tile would be
  // O(tiles×properties) for no benefit.
  const rentCountsByOwnerId = useMemo(() => {
    const map = new Map()
    for (const player of players) {
      if (player.isBank) continue
      map.set(player.id, ownerTypeCounts(properties, staticBoard?.tiles ?? [], player.id))
    }
    return map
  }, [players, properties, staticBoard])

  // Which tiles are currently POWERING a live synergy, and at what tier
  // (synergy.js — a mirror of backend/src/engine/synergyEngine.js). Computed
  // once per render, not per tile: a tier belongs to the OWNER, so every tile
  // one owner holds in one archetype shares a single answer.
  const synergyTiles = useMemo(
    () => (ruleset === 'ASYMMETRIC' ? synergyByTileId(properties, staticBoard?.tiles ?? []) : EMPTY_SYNERGY),
    [ruleset, properties, staticBoard]
  )

  // "Sương mù bẫy" — the fog is drawn by the SERVER, not here. Redaction
  // (backend/src/engine/stateRedaction.js's maskTrap) already replaces every
  // trap this viewer doesn't own with an anonymous stub whose tileIndex is
  // null, preserving only the array's length. So a trap that arrives with a
  // real numeric tileIndex is, by construction, one of the viewer's own —
  // there is nothing to filter by ownerId here, and no way for this component
  // to leak a position it was never told.
  const visibleTrapByPosition = useMemo(() => {
    const map = new Map()
    // Gated on the ruleset as well as on the data. In practice activeTraps is
    // always empty in CLASSIC (nothing writes it there), so this changes
    // nothing today — but it makes the mode boundary explicit rather than
    // relying on an invariant held somewhere else, which is the same class of
    // leak that let a stale fixture put a "bẫy ẩn" badge on a Classic board.
    if (ruleset !== 'ASYMMETRIC') return map
    for (const trap of activeTraps) {
      if (typeof trap.tileIndex === 'number') map.set(trap.tileIndex, trap)
    }
    return map
  }, [activeTraps, ruleset])
  // Same ruleset gate as visibleTrapByPosition above, and it MUST be gated
  // separately: this is a subtraction, so gating only the map made a Classic
  // board report every trap as hidden rather than none at all.
  const hiddenTrapCount = ruleset === 'ASYMMETRIC' ? activeTraps.length - visibleTrapByPosition.size : 0

  const trapBooms = useTrapBooms(lastTrapHits, lastTrapHitSeq)

  const dragRef = useRef(null)
  const lastRotatedKeyRef = useRef(null)
  const setBoardSpin = useGameStore((s) => s.setBoardSpin)

  // Auto-rotate camera to follow the current player's edge (2026-08-22, user request)
  useEffect(() => {
    if (currentTurnIndex == null || currentTurnIndex < 0 || currentTurnIndex >= players.length) return
    const currentPlayer = players[currentTurnIndex]
    const pos = displayedPositions.get(currentPlayer.id)
    if (pos == null || !staticBoard?.tiles) return

    // Wait until they actually finish walking so we don't spin dizzyingly mid-move
    if (pos !== currentPlayer.currentPosition) return

    const key = `${currentPlayer.id}-${pos}`
    if (lastRotatedKeyRef.current === key) return
    lastRotatedKeyRef.current = key

    const edgeLength = (totalTiles - 4) / 4
    const jailCorner = edgeLength + 1
    const parkingCorner = 2 * edgeLength + 2
    const goToJailCorner = 3 * edgeLength + 3

    // Turns the board so the active player's own edge sits toward the
    // viewer. Each target is a whole multiple of 90deg, i.e. total Z of
    // 45/135/225/315 — the DIAMOND family (cameraControls.js's snapSpin),
    // so auto-follow and manual snapping always agree on the same four
    // orientations.
    //
    // Revised 2026-08-23: these were previously offset by -45 each, landing
    // on the axis-aligned family (total Z 0/90/180/270) to put the active
    // edge exactly horizontal at the bottom. That made the board render
    // square-on, which the user rejected — the default is meant to be the
    // angled full-board overview ("góc nghiêng nhìn toàn cảnh"), the
    // project's own original reference. Shifting each target by +45 keeps
    // the identical "face the active player" behaviour while staying in the
    // diamond family.
    // - Bottom edge: rotateZ(45deg)  -> spin = 0
    // - Left edge:   rotateZ(-45deg) -> spin = -90
    // - Top edge:    rotateZ(-135deg)-> spin = -180
    // - Right edge:  rotateZ(135deg) -> spin = 90
    let targetAngle = 0
    if (pos >= goToJailCorner) targetAngle = 0
    else if (pos >= parkingCorner) targetAngle = 90
    else if (pos >= jailCorner) targetAngle = -180
    else targetAngle = -90

    // Find the closest equivalent angle to current boardSpin to prevent full 360 sweeps
    const diff = (((targetAngle - boardSpin) % 360) + 540) % 360 - 180
    if (diff !== 0) {
      // Eased rather than an instant jump (2026-08-23) — this used to rely
      // on `.board`'s CSS transition, which had to be removed (see
      // GameBoard.module.css: a real Chromium bug could leave a
      // calc(var(--spin))-derived transform permanently stuck). Tweening the
      // number itself restores the smooth turn with no transitioned
      // property involved, so that failure mode can't come back.
      // Re-entrancy is safe: this effect re-runs on every frame the tween
      // updates boardSpin, but lastRotatedKeyRef above short-circuits it
      // until the player genuinely moves again.
      tweenSpinTo(boardSpin, boardSpin + diff, setBoardSpin)
    }
  }, [currentTurnIndex, players, displayedPositions, staticBoard, boardSpin, setBoardSpin, totalTiles])

  // Isometric camera transform
  const totalZDeg = 45 + boardSpin
  const thetaRad = (totalZDeg * Math.PI) / 180
  const spread = Math.abs(Math.cos(thetaRad)) + Math.abs(Math.sin(thetaRad))
  // Uses dynamic tilt instead of fixed 55
  const vfactor = spread * Math.cos((boardTilt * Math.PI) / 180)

  // The board's own layout size, from the container's REAL measured box (see
  // viewportRef above). `spread`/`vfactor` convert the rendered footprint
  // this square will actually occupy back into the square's own side length,
  // so whichever axis runs out first is the one that binds — the same
  // relationship the old CSS formula expressed, just against a measured box
  // instead of a guessed one. Left null until the first measurement lands,
  // where the CSS fallback in GameBoard.module.css covers the first paint.

  function onWheelZoom(e) {
    e.preventDefault()
    setBoardZoom(clampZoom(boardZoom + (e.deltaY < 0 ? 0.1 : -0.1)))
  }

  if (!staticBoard || !staticBoard.tiles || staticBoard.tiles.length === 0) {
    return (
      <div className={styles.empty}>
        <p>Đang tải dữ liệu bàn cờ…</p>
      </div>
    )
  }

  const { tiles } = staticBoard
  const edgeLength = (tiles.length - 4) / 4
  const size = edgeLength + 2
  // Matches computeGridPosition's own local `jailCorner` constant exactly
  // (same formula, safe to duplicate — it's a one-line derivation already
  // used identically twice in this file).
  const jailPosition = edgeLength + 1

  const playersByPosition = new Map()
  for (const player of players) {
    if (player.isBank) continue // the Bank sentinel row has no token on the board
    const pos = displayedPositions.get(player.id) ?? player.currentPosition
    const list = playersByPosition.get(pos) ?? []
    list.push(player)
    playersByPosition.set(pos, list)
  }

  function onPointerDown(e) {
    const spinLocked = useGameStore.getState().boardSpinLocked
    if (spinLocked) return
    dragRef.current = { 
      startX: e.clientX, 
      startY: e.clientY,
      startSpin: boardSpin,
      startTilt: useGameStore.getState().boardTilt,
      isDragging: false 
    }
  }

  function onPointerMove(e) {
    if (!dragRef.current) return
    const dx = e.clientX - dragRef.current.startX
    const dy = e.clientY - dragRef.current.startY
    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) dragRef.current.isDragging = true
    if (dragRef.current.isDragging) {
      // 0.35deg/px for Z spin, 0.25deg/px for X tilt
      useGameStore.getState().setBoardSpin(dragRef.current.startSpin + dx * 0.35)
      const newTilt = Math.min(80, Math.max(25, dragRef.current.startTilt - dy * 0.25))
      useGameStore.getState().setBoardTilt(newTilt)
    }
  }

  function onPointerUp() {
    if (!dragRef.current) return
    if (dragRef.current.isDragging) {
      dragRef.current.wasDragging = true
      // Don't set null yet, wait for click to capture, or timeout
      setTimeout(() => { dragRef.current = null }, 50)
    } else {
      dragRef.current = null
    }
  }

  function onClickCapture(e) {
    if (dragRef.current?.wasDragging) {
      e.stopPropagation()
      e.preventDefault()
      dragRef.current.wasDragging = false
    }
  }

  return (
    <div
      className={styles.viewport}
      onWheel={onWheelZoom}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
      onClickCapture={onClickCapture}
    >
      <div
        className={styles.board}
        style={{
          '--board-size': size,
          '--zoom': boardZoom,
          '--spin': `${boardSpin}deg`,
          '--tilt': `${boardTilt}deg`,
          '--spread': spread,
          '--vfactor': vfactor,
        }}
      >
        {/* PLACE_TRAP target-picking (ASYMMETRIC, trapDraft in gameStore.js —
            set by MovementHandControls.jsx's own "Đặt Bẫy" button). A trap
            can land on ANY tile position, not only ones with a matching
            Property row (trapEngine.js's validateTrapPlacement has no such
            restriction — go/tax/chance are all legal targets), so this
            overrides the normal property-select onClick for every tile while
            active rather than only extending it to the already-clickable
            subset. */}
        {tiles.map((tile) => {
          const { row, col } = computeGridPosition(tile.position, edgeLength)
          const property = propertyByBoardTileId.get(tile.id) ?? null
          const isTargetingTrap = trapDraft != null && trapDraft.targetPosition == null
          const trapTileOnClick = isTargetingTrap ? () => setTrapDraft({ ...trapDraft, targetPosition: tile.position }) : null
          // Ownership/houses shown directly on the tile (2026-08-22, user
          // request) — resolved once here (property.ownerId -> the matching
          // PlayerGameState, same id-space every other ownerId lookup in
          // this codebase uses, e.g. PropertyManager.jsx's own `owner`)
          // rather than inside BoardTile itself, same division of labor
          // this file already uses for isSelected/onClick.
          const owner = property?.ownerId ? (players.find((p) => p.id === property.ownerId) ?? null) : null
          // What landing on this tile actually costs right now — only
          // meaningful once it's owned, so left undefined otherwise rather
          // than computed and discarded.
          const rentPreview =
            property && owner
              ? rentLabel(
                  tile,
                  property,
                  rentCountsByOwnerId.get(owner.id) ?? { transportCount: 0, utilityCount: 0 },
                  ownsFullGroup(tile, properties, staticBoard.tiles, owner.id)
                )
              : undefined
          return (
            <BoardTile
              key={tile.id}
              tile={tile}
              isCorner={CORNER_TYPES.has(tile.tileType)}
              edge={computeEdge(tile.position, edgeLength)}
              isSelected={!isTargetingTrap && property != null && property.id === selectedPropertyId}
              onClick={trapTileOnClick ?? (property ? () => selectProperty(property.id) : undefined)}
              isTargetable={isTargetingTrap}
              synergy={synergyTiles.get(tile.id)}
              trap={visibleTrapByPosition.get(tile.position)}
              owner={owner}
              upgradeLevel={property?.upgradeLevel ?? 0}
              rentPreview={rentPreview}
              style={{ gridRow: row, gridColumn: col }}
            />
          )
        })}
        <div className={styles.center}>
          <CenterBoardArea />
        </div>

        {/* Inside .board (not .viewport) so the dice live in the board's own
            3D space and land on its surface — see DiceRoll.module.css. */}
        <DiceRoll />
        {/* Absolutely positioned, outside CSS Grid's own auto-placement
            (spec-excluded for position:absolute children) — see this file's
            own header for why tokens live here instead of inside BoardTile. */}
        <div className={styles.tokenLayer}>
          {/* "From" ghost markers (2026-08-22) — one per player whose last
              settled tile differs from where they're shown now, faded and
              in their own colour, answering "which tile were they just at."
              Rendered *before* the real tokens so a token sharing that same
              tile (e.g. someone else already standing there) still paints
              on top of the ghost, not under it. */}
          {[...lastSettled.entries()].map(([playerId, ghostPosition]) => {
            const player = players.find((p) => p.id === playerId)
            const currentDisplayed = displayedPositions.get(playerId)
            if (!player || currentDisplayed === undefined || ghostPosition === currentDisplayed) return null
            const { row, col } = computeGridPosition(ghostPosition, edgeLength)
            return (
              <span
                key={`ghost-${playerId}`}
                className={styles.fromGhost}
                style={{
                  left: `${((col - 0.5) / size) * 100}%`,
                  top: `${((row - 0.5) / size) * 100}%`,
                  background: playerColor(player),
                }}
                title="Vị trí trước đó"
              />
            )
          })}

          {/* "Bẫy phát nổ" — a one-shot marker on the tile a trap actually
              fired on (gameState.lastTrapHits, cleared by useTrapBooms after
              TRAP_BOOM_MS). This is the ONLY way a victim ever learns where a
              trap was: they never saw it beforehand, since redaction hides
              every trap but your own. Rendered in the token layer so it sits
              over the board in the same percentage-positioned coordinate
              space the tokens themselves use. */}
          {trapBooms.map((hit) => {
            const { row, col } = computeGridPosition(hit.tileIndex, edgeLength)
            return (
              <span
                key={`boom-${lastTrapHitSeq}-${hit.tileIndex}`}
                className={styles.trapBoom}
                style={{ left: `${((col - 0.5) / size) * 100}%`, top: `${((row - 0.5) / size) * 100}%` }}
                title={trapLabel(hit.type)}
              >
                💥
              </span>
            )
          })}

          {[...playersByPosition.entries()].flatMap(([position, group]) => {
            const { row, col } = computeGridPosition(position, edgeLength)
            const left = ((col - 0.5) / size) * 100
            const top = ((row - 0.5) / size) * 100
            return tokensForPosition(position, group, jailPosition).map(({ player, x, y }) => {
              const isCurrentTurn = player.turnOrder === currentTurnIndex
              // Still stepping toward their real tile — drives the walk
              // cycle (ZodiacFigure.module.css). Derived from the same
              // displayed-vs-real split useWalkingPositions already
              // maintains, so the legs move for exactly as long as the
              // piece is actually travelling, teleports included (those
              // resolve in one frame and so never trigger it).
              const displayedPos = displayedPositions.get(player.id) ?? player.currentPosition
              const isWalking = displayedPos !== player.currentPosition
              // Arrived here without walking (MOBILITY's forced TELEPORT, Go
              // To Jail, an event-card send). Fades in on the spot instead of
              // playing the arrival hop — a hop reads as "I just stepped
              // here", which is exactly the wrong story for a teleport.
              const isWarp = warpedAt.get(player.id) === displayedPos
              return (
                <div
                  key={`token-${player.id}`}
                  className={`${styles.token} ${isCurrentTurn ? styles.tokenActive : ''}`}
                  style={{
                    left: `${left}%`,
                    top: `${top}%`,
                    '--token-offset-x': `${x}px`,
                    '--token-offset-y': `${y}px`,
                    '--token-color': playerColor(player),
                    zIndex: isCurrentTurn ? 10 : 5,
                  }}
                  title={player.playerId ?? player.id}
                >
                  {/* Lies flat on the tile (no counter-rotation) so it reads
                      as a real cast shadow, and grounds the standing figure
                      — without it a billboarded piece looks like it floats.
                      Deliberately OUTSIDE .tokenHop below: a real shadow
                      stays on the ground while only the figure rises, so it
                      must not inherit the hop's own translateY. */}
                  <div className={styles.tokenShadow} />
                  {/* Bounce-on-arrival (2026-08-25, user request: "di chuyển
                      tới ô nào ô đấy phải nảy nảy cho sinh động"). A separate
                      wrapper around .tokenStandee, not a transform added
                      directly to it — .tokenStandee's own transform is the
                      billboard counter-rotation (rotateZ/rotateX against
                      --spin/--tilt) and that file's own header explains in
                      detail why it can never carry an animated transform of
                      its own (a real Chromium bug: a var()-driven calc()
                      inside an animated/transitioned transform can freeze
                      permanently on a stale value). Two separate elements
                      each owning their own `transform` composes safely;
                      layering both onto one would not.
                      Keyed by the player's own DISPLAYED position (not
                      currentPosition) so a fresh key — and a fresh play of
                      the animation — happens on every tile actually arrived
                      at: each step of a real walk, one at a time, and once
                      on a straight teleport landing alike. */}
                  <div key={displayedPos} className={isWarp ? styles.tokenWarp : styles.tokenHop}>
                    {/* Stands upright out of the board and keeps facing the
                        camera at any spin/tilt — the same billboard formula
                        `.fromGhost` already uses, but hinged at its base so
                        the figure rises FROM the tile rather than hovering
                        centred over it. */}
                    <div className={styles.tokenStandee}>
                      <ZodiacFigure zodiac={player.zodiac} walking={isWalking} fallback={playerInitial(player)} />
                    </div>
                  </div>
                </div>
              )
            })
          })}
        </div>
      </div>

      {/* How many traps are live that this viewer cannot see. Redaction
          preserves activeTraps' LENGTH while stripping the contents, and that
          is deliberate (stateRedaction.js's maskTrap): "N hazards are out
          there somewhere" is information the design wants everyone to have —
          it is what makes an unknown tile worth hesitating over — while the
          positions stay secret. Sits in .viewport, OUTSIDE .board, so the
          board's own rotateX/rotateZ camera never skews it. */}
      {hiddenTrapCount > 0 && (
        <div className={styles.hiddenTrapBadge} title={`${hiddenTrapCount} bẫy của đối thủ đang hoạt động ở đâu đó trên bàn cờ`}>
          ⚠️ {hiddenTrapCount} bẫy ẩn
        </div>
      )}
    </div>
  )
}
