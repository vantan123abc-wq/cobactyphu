// Plain constants/helpers shared between BoardCamera.jsx (the control
// cluster) and GameBoard.jsx (the wheel-to-zoom handler) — split out
// deliberately, same "plain constants, not a component" reasoning
// tileVisuals.js's own header already documents, and for the identical
// reason: exporting these alongside a component trips oxlint's
// react(only-export-components) Fast Refresh rule.
//
// Named cameraControls.js, not boardCamera.js — a first attempt used that
// name and broke the production build (rolldown: "default" is not exported
// by "BoardCamera.js") because it differs from BoardCamera.jsx only by the
// first letter's case, and this filesystem/bundler resolves module
// specifiers case-insensitively; `import ... from './BoardCamera'` was
// silently resolving to this file instead of the component. Real,
// caught-by-build lesson, not a hypothetical: never name a sibling file a
// case-only variant of an existing one in this project.
export const ZOOM_MIN = 0.6
export const ZOOM_MAX = 2.2

export function clampZoom(z) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))
}

/* ── Rotation snapping (2026-08-23) ────────────────────────────────────────
   The board only ever looks deliberate at two families of angle: the 45deg
   DIAMOND (a corner toward the viewer, all four edges visible at once) or
   axis-aligned (one edge square-on to the viewer). Anything between reads
   as "the board got knocked crooked" rather than as a camera angle — which
   is exactly what a user reported after free-rotating ~12deg off.

   Snapping to the DIAMOND family. This reverses an earlier same-day pass
   that snapped to axis-aligned instead; the user's own words on seeing that
   result: "góc cơ bản phải là góc nghiêng nhìn toàn cảnh bàn cờ... chứ sao
   giờ thành góc thẳng rồi" — the default is supposed to be the angled
   overview, not a square-on view. That is also the project's original
   intent (GameBoard.module.css's own header cites a reference of "the board
   rotated into a diamond and real depth"), so this restores it rather than
   inventing a new preference.

   The tradeoff is real and was measured, not hand-waved: the diamond's
   footprint factors (1.414 / 1.414*cos(tilt)) are larger than axis-aligned's
   (1.0 / cos(tilt)), and --side divides the available space by exactly
   those — so the diamond yields a smaller board and smaller tile text for
   the same screen. Seeing the whole board laid out as one clear overview is
   what was asked for, and it's what a physical board looks like from a
   player's chair.

   BOARD_SPIN_STEP stays 90 (four diamond orientations) — a nudge button
   that lands on an angle the drag would immediately snap away from is just
   a broken control. */
export const BOARD_SPIN_STEP = 90

/** Nearest diamond spin. Total Z rotation is `45deg + spin` (GameBoard.module.css), so a diamond is any spin that is a whole multiple of 90 — leaving total Z at 45/135/225/315. */
export function snapSpin(spin) {
  return Math.round(spin / BOARD_SPIN_STEP) * BOARD_SPIN_STEP
}

// ── Spin tween ─────────────────────────────────────────────────────────
// Animating the rotation in JS rather than with a CSS `transition` is
// deliberate and load-bearing: GameBoard.module.css's own header documents
// a real Chromium bug this project hit, where a `transition` on a transform
// built from calc(var(--spin)) could get PERMANENTLY stuck on a stale
// value. Driving the number itself frame by frame produces a normal
// re-render each time, with no transitioned property anywhere, so that
// failure mode cannot occur at all.
const SPIN_TWEEN_MS = 260
const SPIN_TWEEN_GUARD_MS = SPIN_TWEEN_MS + 140
let activeTween = null // requestAnimationFrame id
let activeGuard = null // setTimeout id — the wall-clock backstop below

/** True while a spin tween is still easing — so a watchdog can tell "mid-animation" apart from "genuinely left at a crooked angle". */
export function isSpinTweening() {
  return activeTween != null || activeGuard != null
}

/** True if `spin` is already exactly on one of the four diamond orientations. */
export function isSnappedSpin(spin) {
  return Math.abs(snapSpin(spin) - spin) < 0.01
}

/** Stops any in-flight spin tween — call before taking direct control (a drag). */
export function cancelSpinTween() {
  if (activeTween != null) {
    cancelAnimationFrame(activeTween)
    activeTween = null
  }
  if (activeGuard != null) {
    clearTimeout(activeGuard)
    activeGuard = null
  }
}

/**
 * Eases `boardSpin` from its current value to `target`, via the caller's own
 * setter. Cancels any tween already running, so a second call never fights
 * the first.
 *
 * SAFETY NET, and it is not theoretical — caught live while testing this
 * very function: requestAnimationFrame does not run at all while the page
 * isn't compositing (a backgrounded tab, an occluded window). Without a
 * backstop the tween simply never advances, and since the *whole point* of
 * the snap is to land on an axis-aligned angle, a half-finished tween
 * leaves the board resting at exactly the crooked angle the snap existed to
 * prevent — permanently, until something else moves it. Same failure shape
 * as the event-card flip animation earlier in this project, and the same
 * fix: a plain setTimeout, which browsers throttle but still run in
 * background tabs, forces the exact target regardless of whether a single
 * animation frame ever fired.
 * @param {number} from - the spin value to start from
 * @param {number} target - the spin value to settle on
 * @param {(spin: number) => void} setSpin
 */
export function tweenSpinTo(from, target, setSpin) {
  cancelSpinTween()
  if (from === target) return

  const startedAt = performance.now()
  const delta = target - from

  const land = () => {
    cancelSpinTween()
    setSpin(target) // the exact value, never an easing remainder
  }

  const frame = (now) => {
    const t = Math.min(1, (now - startedAt) / SPIN_TWEEN_MS)
    if (t >= 1) {
      land()
      return
    }
    const eased = 1 - Math.pow(1 - t, 3) // easeOutCubic — decisive start, soft landing
    setSpin(from + delta * eased)
    activeTween = requestAnimationFrame(frame)
  }

  activeTween = requestAnimationFrame(frame)
  activeGuard = setTimeout(land, SPIN_TWEEN_GUARD_MS)
}
