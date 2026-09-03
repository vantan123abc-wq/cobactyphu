import { useEffect, useState } from 'react'
import { useGameStore } from '../../store/gameStore'
import { zodiacEmoji } from './zodiac'
import styles from './DiceRoll.module.css'

// How long a roll stays on the board after it lands. Introduced 2026-08-25
// together with the server-side change that stopped clearing lastRoll at
// TURN_START: the dice used to vanish the instant the turn advanced, which
// meant three real rolls (a failed jail escape, a 3rd consecutive double,
// and landing on Go To Jail) were never visible to anyone at all, since each
// ends the turn in the same transition. Now every roll is shown for a fixed
// window instead, and "when to stop showing it" is a presentation decision
// rather than a game-state one.
const DICE_VISIBLE_MS = 5000

// Real 3D dice that tumble onto the board (2026-08-22) — replaces the flat
// Unicode die glyphs (⚀-⚅) that used to sit in GameControls' bottom bar
// (removed there, so the two can't show contradictory faces).
//
// Renders inside GameBoard's own `.board` element, so it lives in the
// board's 3D space and lands on the board surface rather than floating in
// the UI chrome. Values are `gameState.lastRoll`'s real server-generated
// die1/die2 (finding #27 — dice have been genuinely server-authoritative
// since 2026-08-19; nothing here generates or influences a value, it only
// animates the result that already arrived).

// 3x3 grid cell indices carrying a pip, per face value — the standard
// arrangement (6 is two columns of three, not two rows).
const PIPS = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
}

// The cube rotation that brings each face to the front, i.e. the exact
// inverse of where DiceRoll.module.css parks that face. Opposite faces sum
// to 7 the way a real die does (1/6 front-back, 3/4 right-left, 5/2
// top-bottom), so this is a real die's layout, not an arbitrary one.
const FACE_ROTATION = {
  1: { rx: 0, ry: 0 },
  2: { rx: 90, ry: 0 },
  3: { rx: 0, ry: -90 },
  4: { rx: 0, ry: 90 },
  5: { rx: -90, ry: 0 },
  6: { rx: 0, ry: 180 },
}

function Face({ value }) {
  const pips = PIPS[value] ?? []
  return (
    <div className={`${styles.face} ${styles[`face${value}`]}`}>
      {Array.from({ length: 9 }, (_, i) => (
        <span key={i} className={pips.includes(i) ? styles.pip : undefined} />
      ))}
    </div>
  )
}

function Die({ value, index }) {
  const { rx, ry } = FACE_ROTATION[value] ?? FACE_ROTATION[1]
  return (
    <div
      className={styles.cube}
      style={{
        // The keyframes spin from these plus whole extra turns and land
        // exactly here, so the die always settles showing its real face.
        '--rx-end': `${rx}deg`,
        '--ry-end': `${ry}deg`,
        animationDelay: `${index * 0.09}s`,
      }}
    >
      {[1, 2, 3, 4, 5, 6].map((v) => (
        <Face key={v} value={v} />
      ))}
    </div>
  )
}

export default function DiceRoll() {
  const lastRoll = useGameStore((s) => s.currentGameState?.lastRoll)
  const lastRollSeq = useGameStore((s) => s.currentGameState?.lastRollSeq)
  // The roller is always the current-turn player at the moment of the roll.
  // Read here so every OTHER player can see whose dice these are, which is
  // the whole point of showing them table-wide.
  const roller = useGameStore((s) =>
    s.currentGameState?.players?.find((p) => !p.isBank && p.turnOrder === s.currentGameState.currentTurnIndex)
  )

  const [hidden, setHidden] = useState(false)
  useEffect(() => {
    setHidden(false)
    if (lastRollSeq == null) return
    const timer = setTimeout(() => setHidden(true), DICE_VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [lastRollSeq])

  // `die1 <= 0` marks a lastRoll that is NOT a roll at all: ASYMMETRIC
  // reuses this field as a plain "distance walked" carrier for movement-card
  // plays, so GameBoard.jsx can animate the walk (turnMachine.js's
  // handlePlayMovementCard explains why it reuses the field rather than
  // inventing another one). Those carriers set die1 to 0 precisely so this
  // component can tell them apart and stay out of the way — without this
  // guard, playing a card would show the table a single bogus die face.
  // Belt-and-braces: the write site also leaves lastRollSeq untouched, which
  // already keeps the reveal timer below from re-arming.
  if (!lastRoll || lastRoll.die1 <= 0 || hidden) return null

  return (
    // Keyed so a fresh roll remounts this subtree and the CSS tumble
    // animation replays from the top — the same key-to-replay-an-animation
    // technique FlashAuction.module.css's .bidAmount already uses.
    //
    // Keyed by lastRollSeq, NOT stateVersion (finding #37, fixed
    // 2026-08-23): stateVersion increments on every successful action by
    // anyone, while gameState.lastRoll is only cleared at TURN_START — so
    // the already-settled dice re-tumbled from scratch on every unrelated
    // action for the rest of the roller's own turn (buying a property,
    // resolving an event card, another player proposing a trade).
    // lastRollSeq is incremented server-side only where lastRoll is
    // genuinely set, which also covers the case a `${die1}-${die2}` key
    // would miss: a doubles bonus turn that rolls the exact same faces.
    <div key={lastRollSeq} className={styles.layer}>
      <div className={styles.tray}>
        <Die value={lastRoll.die1} index={0} />
        {lastRoll.die2 > 0 && <Die value={lastRoll.die2} index={1} />}
      </div>
      {/* "Rolled a double, so they go again" — announced to the whole table
          (2026-08-25 request), not just to the roller.

          `isDouble` being visible at all already means the bonus turn is
          real, by construction rather than by a second check: the one case
          where a double does NOT grant another roll is the 3rd consecutive
          one, and that branch sends the player to jail and advances the turn
          instead — so it can never be the roll that is currently pending.
          The roller's zodiac is shown because it is the same token they move
          on the board and the same avatar PlayersPanel gives them, so other
          players can tell whose bonus roll it is without a name lookup. */}
      {lastRoll.isDouble && (
        <span className={styles.doubleBadge}>
          {roller?.zodiac ? `${zodiacEmoji(roller.zodiac)} ` : ''}ĐÔI — ĐI TIẾP!
        </span>
      )}
    </div>
  )
}
