import { useCallback, useEffect, useRef } from 'react'
import { useGameStore } from '../../store/gameStore'
import {
  ZOOM_MIN,
  ZOOM_MAX,
  clampZoom,
  BOARD_SPIN_STEP,
  snapSpin,
  tweenSpinTo,
  cancelSpinTween,
  isSpinTweening,
  isSnappedSpin,
} from './cameraControls'
import styles from './BoardCamera.module.css'

// Board camera controls (2026-08-22) — zoom in/out and free rotation of the
// centre board, per the user's own request ("zoom in zoom out... xoay bàn
// cờ linh hoạt"). State lives in gameStore (boardZoom/boardSpin) so
// GameBoard.jsx's transform math and this control cluster always agree —
// see GameBoard.module.css's own header for how zoom/spin actually reshape
// the board's transform and its margin reconciliation. ZOOM_MIN/MAX/
// clampZoom live in boardCamera.js, shared with GameBoard.jsx's own
// wheel-to-zoom handler — see that file's own header for why it's split out.
const ZOOM_STEP = 0.15
// Rotation now steps/snaps by BOARD_SPIN_STEP (90deg) — see cameraControls.js
// for why the axis-aligned family specifically, and why the old 45deg step
// had to go with it.

// Wraps any spin value into [0, 360) for the drag-strip's own dot position
// only — the stored value itself is left unwrapped (GameBoard.module.css's
// rotateZ(calc(...)) is well-defined for any real number of degrees, and
// wrapping the stored value on every nudge would just be extra work for no
// visible difference).
function normalizedSpin(spin) {
  return ((spin % 360) + 360) % 360
}

export default function BoardCamera() {
  const zoom = useGameStore((s) => s.boardZoom)
  const spin = useGameStore((s) => s.boardSpin)
  const spinLocked = useGameStore((s) => s.boardSpinLocked)
  const setBoardZoom = useGameStore((s) => s.setBoardZoom)
  const setBoardSpin = useGameStore((s) => s.setBoardSpin)
  const setBoardSpinLocked = useGameStore((s) => s.setBoardSpinLocked)

  // Drag-to-rotate lives on this small strip, deliberately not on the board
  // itself — the board's own tiles already have a real onClick (select a
  // property, PropertyManager.jsx), and distinguishing "a click" from "the
  // start of a drag" on the same element reliably needs more machinery
  // (pointer-capture + a movement threshold) than this feature is worth;
  // isolating rotation to its own small control sidesteps that conflict
  // entirely rather than trying to solve it.
  const dragRef = useRef(null) // { startX, startSpin } while a drag is active, else null

  // The drag itself stays completely free (every intermediate angle renders
  // live, so it still feels like really turning the board) — the snap
  // happens only on RELEASE, easing to the nearest diamond orientation.
  // That keeps the freedom of the gesture while making it impossible to
  // come to rest at one of the in-between angles that read as crooked.
  const endDrag = useCallback(() => {
    if (!dragRef.current) return
    dragRef.current = null
    const current = useGameStore.getState().boardSpin
    tweenSpinTo(current, snapSpin(current), setBoardSpin)
  }, [setBoardSpin])

  // Pointer up/move are tracked on WINDOW, not on the strip (2026-08-23) —
  // this is the fix for a reproduced bug, not a precaution. Listening only
  // on the element meant a release that never reached it (pointer let go
  // outside the window, a `pointercancel` the browser didn't deliver, a
  // touch interrupted by a system gesture) left the drag open forever, and
  // with it the board frozen at whatever crooked angle the gesture stopped
  // on. Reproduced exactly: dragging to -57deg and withholding pointerup
  // left the board at -57deg indefinitely, with edges at -7/70deg —
  // matching a user screenshot of this exact symptom almost degree for
  // degree. A window-level release can't be missed the same way.
  const onStripPointerDown = useCallback(
    (e) => {
      if (spinLocked) return
      cancelSpinTween() // taking direct control — a tween still easing toward a snap must not fight the drag
      dragRef.current = { startX: e.clientX, startSpin: spin }
    },
    [spin, spinLocked]
  )

  useEffect(() => {
    const onMove = (e) => {
      if (!dragRef.current) return
      const dx = e.clientX - dragRef.current.startX
      setBoardSpin(dragRef.current.startSpin + dx * 0.6) // ~0.6deg/px — a drag across this strip's own ~140px width covers a full turn, more than "flexible" needs
    }
    // `blur` covers the case the other two can't: the window losing focus
    // mid-drag (alt-tab, a system dialog), where no pointer event of any
    // kind is ever delivered.
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', endDrag)
    window.addEventListener('pointercancel', endDrag)
    window.addEventListener('blur', endDrag)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', endDrag)
      window.removeEventListener('pointercancel', endDrag)
      window.removeEventListener('blur', endDrag)
    }
  }, [setBoardSpin, endDrag])

  // Both read the LIVE store value rather than this render's `spin` prop —
  // the auto-follow camera (GameBoard.jsx) and an in-flight tween both write
  // boardSpin outside React's render cycle, so the closed-over value can be
  // a frame or more stale. Snapping from a stale angle would step from the
  // wrong place; `onStripPointerUp` above already reads live for the same
  // reason.
  function rotateBy(delta) {
    // Snap first, then step: if the board is currently mid-way between two
    // aligned angles (e.g. rotation was locked during a drag), one click
    // should still land on a clean angle rather than carrying the offset
    // forward forever.
    const current = useGameStore.getState().boardSpin
    tweenSpinTo(current, snapSpin(current) + delta, setBoardSpin)
  }

  function resetCamera() {
    setBoardZoom(1)
    tweenSpinTo(useGameStore.getState().boardSpin, snapSpin(0), setBoardSpin)
    useGameStore.getState().setBoardTilt(55)
  }

  // Watchdog: the board must NEVER be left resting at a crooked angle, for
  // any reason (2026-08-23). The snap on pointer-up covers the normal case,
  // but a drag can end without one — a pointer released outside the window,
  // a `pointercancel` the browser doesn't deliver, a touch interrupted by a
  // system gesture — and any of those leaves the board stuck between
  // orientations with nothing to correct it. That is exactly the "board
  // looks crooked" symptom this whole mechanism exists to prevent, so it
  // gets a last line of defence that does not depend on any particular
  // event arriving.
  //
  // Deliberately quiet: it only acts when the angle is genuinely unsnapped,
  // no drag is in progress, and no tween is still easing toward a snap —
  // so it never fights the drag, the tween, or the auto-follow camera. The
  // delay is longer than a tween's own worst case (260ms + its 400ms
  // wall-clock guard), so a normal animation always finishes on its own and
  // this never fires during one.
  // Deliberately does NOT trust `dragRef` to tell it a drag is over — that
  // was the flaw in the first version of this watchdog, found by testing it
  // against the very bug it was meant to catch: with the release event
  // missing, `dragRef` stays set forever, so deferring to it meant deferring
  // forever. It watches the ANGLE instead. This effect re-runs on every spin
  // change, so a live drag keeps resetting the timer and it can never fire
  // mid-gesture; it only gets to run once the angle has been still for
  // longer than any real animation takes.
  useEffect(() => {
    if (spinLocked || isSnappedSpin(spin)) return
    const timer = setTimeout(() => {
      if (isSpinTweening()) return // a snap is already on its way
      const current = useGameStore.getState().boardSpin
      if (isSnappedSpin(current)) return
      dragRef.current = null // whatever this was, it is plainly over
      tweenSpinTo(current, snapSpin(current), setBoardSpin)
    }, 900)
    return () => clearTimeout(timer)
  }, [spin, spinLocked, setBoardSpin])

  return (
    <div className={styles.cluster}>
      <div className={styles.group}>
        <button type="button" className={styles.button} onClick={() => setBoardZoom(clampZoom(zoom - ZOOM_STEP))} disabled={zoom <= ZOOM_MIN} aria-label="Thu nhỏ bàn cờ">
          −
        </button>
        <span className={styles.zoomValue}>{Math.round(zoom * 100)}%</span>
        <button type="button" className={styles.button} onClick={() => setBoardZoom(clampZoom(zoom + ZOOM_STEP))} disabled={zoom >= ZOOM_MAX} aria-label="Phóng to bàn cờ">
          +
        </button>
      </div>

      <div className={styles.group}>
        <button type="button" className={styles.button} onClick={() => rotateBy(-BOARD_SPIN_STEP)} disabled={spinLocked} aria-label="Xoay trái">
          ↺
        </button>
        <div
          className={`${styles.rotateStrip} ${spinLocked ? styles.rotateStripLocked : ''}`}
          onPointerDown={onStripPointerDown}
          title={spinLocked ? 'Đã khoá xoay' : 'Kéo để xoay bàn cờ'}
          role="slider"
          aria-label="Xoay bàn cờ"
          aria-valuemin={0}
          aria-valuemax={360}
          aria-valuenow={Math.round(normalizedSpin(spin))}
          aria-disabled={spinLocked}
        >
          <span className={styles.rotateStripDot} style={{ left: `${(normalizedSpin(spin) / 360) * 100}%` }} />
        </div>
        <button type="button" className={styles.button} onClick={() => rotateBy(BOARD_SPIN_STEP)} disabled={spinLocked} aria-label="Xoay phải">
          ↻
        </button>
        {/* Rotation lock (2026-08-22) — found live that the drag strip made
            it easy to spin the board by accident while reaching for
            something else nearby; this doesn't affect zoom, which was never
            reported as accidentally triggered the same way. */}
        <button
          type="button"
          className={`${styles.button} ${spinLocked ? styles.buttonActive : ''}`}
          onClick={() => setBoardSpinLocked(!spinLocked)}
          aria-pressed={spinLocked}
          aria-label={spinLocked ? 'Mở khoá xoay' : 'Khoá xoay'}
          title={spinLocked ? 'Mở khoá xoay' : 'Khoá xoay bàn cờ'}
        >
          {spinLocked ? '🔒' : '🔓'}
        </button>
      </div>

      <button type="button" className={styles.resetButton} onClick={resetCamera}>
        Đặt lại góc nhìn
      </button>
    </div>
  )
}
