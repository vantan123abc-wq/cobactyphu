import styles from './ZodiacFigure.module.css'

// ─────────────────────────────────────────────────────────────────────────
// The 12 con giáp as standing, walking board pieces (2026-08-23, user
// request: "những con vật 3d đi đứng được").
//
// APPROACH, stated plainly rather than implied: each animal is a drawn
// figure that STANDS UPRIGHT in the board's real 3D space — GameBoard's
// `.tokenStandee` billboards it (undoing the board's own rotateZ spin and
// rotateX tilt) so it rises off the tile and keeps facing the camera from
// any camera angle, with a real ground shadow cast on the tile beneath it.
// It is not a solid mesh: building twelve animals out of transformed CSS
// planes would be enormous and would look worse, not better, at the ~34px
// these render at. This is the same standee construction physical board
// games use for animal pieces, and unlike the previous emoji-on-a-cube it
// can actually be POSED — which is what makes the walk cycle below real
// rather than a slide.
//
// Deliberately supersedes zodiac.js's own emoji for the board piece
// specifically (that file's header had already flagged emoji as a knowing
// exception to TileIcon.jsx's no-emoji rule). An emoji glyph cannot have
// its legs animated and renders differently on every platform; PlayersPanel
// keeps using the emoji, where it's a small static avatar and neither
// concern applies.
//
// Every figure faces RIGHT, stands on the ground line at y=46 of a
// 44x48 viewBox, and is drawn in the PLAYER's colour rather than the
// animal's natural one — on a board, "which piece is mine" has to read
// faster than "is the tiger orange". Silhouette carries the zodiac
// identity, colour carries the ownership.
// ─────────────────────────────────────────────────────────────────────────

const GROUND = 46

// Diagonal gait: each pair swings opposite its diagonal partner, which is
// how a real quadruped walks and reads correctly even at this size.
const A = styles.legA
const B = styles.legB

/** One leg, hinged at its top (the hip) so the CSS rotation reads as a stride. */
function Leg({ x, top, len, w = 4, cls }) {
  return (
    <g transform={`translate(${x} ${top})`}>
      <rect className={`${styles.leg} ${cls}`} x={-w / 2} y="0" width={w} height={len} rx={w / 2} />
    </g>
  )
}

/** The four legs of a quadruped, back pair drawn darker so it reads as behind. */
function Legs({ backX = [13, 18], frontX = [26, 31], top = 32, len = 13, w = 4 }) {
  return (
    <>
      <g className={styles.far}>
        <Leg x={backX[0]} top={top} len={len} w={w} cls={B} />
        <Leg x={frontX[0]} top={top} len={len} w={w} cls={A} />
      </g>
      <Leg x={backX[1]} top={top} len={len} w={w} cls={A} />
      <Leg x={frontX[1]} top={top} len={len} w={w} cls={B} />
    </>
  )
}

const Eye = ({ cx, cy, r = 1.5 }) => <circle className={styles.eye} cx={cx} cy={cy} r={r} />

// ── The twelve figures ───────────────────────────────────────────────────
// Keyed by zodiac.js's own ZODIAC keys, so an unknown/unset key falls
// through to the caller's initial-letter fallback rather than guessing.

const FIGURES = {
  // Chuột — small body, oversized round ears, long bare tail, pointed snout.
  ty: (
    <>
      <path className={styles.dark} d="M10 32 Q2 30 2 22 Q2 18 6 19 Q3 25 10 28 Z" />
      <Legs backX={[14, 18]} frontX={[26, 30]} top={35} len={10} w={3.5} />
      <ellipse className={styles.body} cx="21" cy="31" rx="11.5" ry="7.5" />
      <circle className={styles.light} cx="29.5" cy="19.5" r="4.2" />
      <circle className={styles.light} cx="34.5" cy="21" r="4.2" />
      <path className={styles.body} d="M27 27 Q34 22 41 28 Q36 33 28 32 Z" />
      <Eye cx="33" cy="26.5" />
      <circle className={styles.dark} cx="40.5" cy="28.5" r="1.4" />
    </>
  ),

  // Trâu — heavy body, wide sweeping horns, low head, tufted tail.
  suu: (
    <>
      <path className={styles.dark} d="M8 26 Q3 27 3 34 Q3 38 6 38 Q4 32 9 30 Z" />
      <Legs backX={[13, 18]} frontX={[27, 32]} top={33} len={13} w={5} />
      <ellipse className={styles.body} cx="20" cy="27" rx="13.5" ry="9" />
      <path className={styles.body} d="M29 23 Q37 21 39 27 Q40 33 33 33 Q28 32 28 27 Z" />
      <path className={styles.horn} d="M31 21 Q28 13 21 12 Q26 15 27 22 Z" />
      <path className={styles.horn} d="M36 21 Q39 13 44 14 Q39 16 38 22 Z" />
      <Eye cx="33" cy="26" />
      <ellipse className={styles.dark} cx="38.5" cy="30.5" rx="2.6" ry="2" />
    </>
  ),

  // Hổ — striped flank, broad head, small round ears, heavy raised tail.
  dan: (
    <>
      <path className={styles.dark} d="M8 27 Q1 24 2 16 Q3 12 6 14 Q3 21 10 24 Z" />
      <Legs backX={[13, 18]} frontX={[27, 32]} top={33} len={13} w={4.6} />
      <ellipse className={styles.body} cx="20" cy="28" rx="13" ry="8" />
      <path className={styles.stripe} d="M15 21v14M20 20.5v15M25 21v14" />
      <circle className={styles.light} cx="30" cy="18" r="3" />
      <circle className={styles.light} cx="37" cy="18" r="3" />
      <circle className={styles.body} cx="33.5" cy="23" r="7" />
      <Eye cx="31.5" cy="22" />
      <Eye cx="36" cy="22" />
      <circle className={styles.dark} cx="34" cy="26" r="1.6" />
    </>
  ),

  // Mèo — slim, tall pointed ears, tail carried upright.
  mao: (
    <>
      <path className={styles.dark} d="M9 30 Q3 28 4 19 Q5 15 8 17 Q5 24 11 27 Z" />
      <Legs backX={[14, 18]} frontX={[26, 30]} top={34} len={11} w={3.6} />
      <ellipse className={styles.body} cx="20" cy="30" rx="11.5" ry="7" />
      <path className={styles.light} d="M28 20 L29 13 L33 18 Z" />
      <path className={styles.light} d="M37 20 L38 13 L34 18 Z" />
      <circle className={styles.body} cx="33" cy="23" r="6" />
      <Eye cx="31" cy="22" />
      <Eye cx="35.5" cy="22" />
      <circle className={styles.dark} cx="33.2" cy="25.5" r="1.3" />
    </>
  ),

  // Rồng — serpentine, no standard quadruped frame: a rising S body with a
  // dorsal crest, horns and whiskers. Its own shape is the identity.
  thin: (
    <>
      <path
        className={styles.crest}
        d="M9 41 L6 36 L12 37 L10 31 L16 33 L15 26 L21 29 L21 21 L27 25"
      />
      <path
        className={styles.body}
        d="M5 46 Q4 38 11 36 Q18 34 17 27 Q16 20 24 18 Q31 16 33 20 L33 27 Q28 26 27 30 Q26 37 17 40 Q11 42 12 46 Z"
      />
      <path className={styles.body} d="M28 16 Q37 12 41 19 Q42 25 35 26 Q29 26 28 21 Z" />
      <path className={styles.horn} d="M31 13 Q29 6 24 5 Q29 9 29 14 Z" />
      <path className={styles.whisker} d="M40 22 Q44 25 42 30M40 20 Q44 17 43 13" />
      <Eye cx="35" cy="18.5" />
      <circle className={styles.dark} cx="41" cy="21" r="1.3" />
    </>
  ),

  // Rắn — a coiled base with the body rising out of it; no legs at all, so
  // the walk cycle below animates the coil instead (see .slither).
  ty2: (
    <>
      <g className={styles.slither}>
        <ellipse className={styles.dark} cx="19" cy="41" rx="14" ry="5" />
        <ellipse className={styles.body} cx="19" cy="38" rx="11.5" ry="4.2" />
        <path
          className={styles.body}
          d="M14 37 Q9 30 15 25 Q22 20 28 24 Q33 28 30 33 L24 33 Q26 29 22 27 Q17 26 18 31 Q19 34 21 36 Z"
        />
        <path className={styles.body} d="M28 22 Q37 19 41 25 Q42 31 35 31 Q29 31 28 27 Z" />
        <path className={styles.tongue} d="M41 27 L45 27 M45 27 L47 25 M45 27 L47 29" />
        <Eye cx="34" cy="24.5" />
      </g>
    </>
  ),

  // Ngựa — the tall one: long legs, long neck, mane and a flowing tail.
  ngo: (
    <>
      <path className={styles.mane} d="M7 24 Q0 28 2 38 Q4 43 7 41 Q3 33 9 28 Z" />
      <Legs backX={[13, 17]} frontX={[26, 30]} top={30} len={16} w={4} />
      <ellipse className={styles.body} cx="19" cy="26" rx="12" ry="7.5" />
      <path className={styles.body} d="M25 24 Q27 15 32 12 L37 15 Q32 18 31 27 Z" />
      <path className={styles.mane} d="M25 22 Q28 13 33 10 L35 13 Q30 17 29 23 Z" />
      <path className={styles.body} d="M31 13 Q39 9 41 14 Q42 19 36 19 Q31 18 31 15 Z" />
      <path className={styles.light} d="M32 11 L31 5 L35 9 Z" />
      <Eye cx="35" cy="13.5" />
      <circle className={styles.dark} cx="40" cy="16" r="1.3" />
    </>
  ),

  // Dê — backward-curving horns and a beard, the two features that read at
  // this size.
  mui: (
    <>
      <path className={styles.dark} d="M9 26 Q4 24 4 19 Q5 16 8 18 Q6 22 11 24 Z" />
      <Legs backX={[14, 18]} frontX={[26, 30]} top={33} len={12} w={3.8} />
      <ellipse className={styles.body} cx="20" cy="29" rx="11.5" ry="7.5" />
      <path className={styles.body} d="M28 24 Q35 21 39 26 Q41 31 35 32 Q29 31 28 27 Z" />
      <path className={styles.horn} d="M31 21 Q30 13 24 11 Q29 15 28 22 Z" />
      <path className={styles.horn} d="M35 21 Q35 13 29 10 Q34 15 33 22 Z" />
      <path className={styles.light} d="M34 32 Q35 39 32 41 Q31 36 31 32 Z" />
      <Eye cx="33" cy="25.5" />
      <circle className={styles.dark} cx="39" cy="28" r="1.3" />
    </>
  ),

  // Khỉ — the upright one: standing on two legs with long arms and a
  // curled tail, so its whole posture separates it from the quadrupeds.
  than: (
    <>
      <path className={styles.dark} d="M13 32 Q5 33 5 26 Q5 21 9 22 Q6 28 14 29 Z" />
      <g className={styles.far}>
        <Leg x={18} top={34} len={12} w={4} cls={B} />
      </g>
      <Leg x={24} top={34} len={12} w={4} cls={A} />
      <ellipse className={styles.body} cx="21" cy="28" rx="9" ry="10" />
      <path className={`${styles.body} ${styles.armA}`} d="M14 22 Q7 26 8 34 L12 35 Q11 28 16 26 Z" />
      <path className={`${styles.body} ${styles.armB}`} d="M28 22 Q35 26 34 34 L30 35 Q31 28 26 26 Z" />
      <circle className={styles.light} cx="13" cy="15" r="3.4" />
      <circle className={styles.light} cx="29" cy="15" r="3.4" />
      <circle className={styles.body} cx="21" cy="16" r="8" />
      <ellipse className={styles.light} cx="21" cy="18.5" rx="5" ry="4.5" />
      <Eye cx="18.5" cy="14.5" />
      <Eye cx="23.5" cy="14.5" />
      <circle className={styles.dark} cx="21" cy="18" r="1.2" />
    </>
  ),

  // Gà — a biped: comb, beak, wattle and a fan of tail feathers.
  dau: (
    <>
      <path className={styles.plume} d="M11 29 Q2 24 3 14 Q7 20 12 22 M12 31 Q3 30 1 21 Q6 26 13 25" />
      <g className={styles.far}>
        <Leg x={19} top={34} len={12} w={3} cls={B} />
      </g>
      <Leg x={24} top={34} len={12} w={3} cls={A} />
      <ellipse className={styles.body} cx="21" cy="28" rx="10.5" ry="9" />
      <path className={styles.body} d="M25 21 Q26 14 30 12 L34 15 Q30 18 30 23 Z" />
      <circle className={styles.body} cx="31" cy="15" r="5.5" />
      <path className={styles.comb} d="M27 11 Q28 7 30 10 Q32 6 33 10 Q35 7 35 11 Z" />
      <path className={styles.comb} d="M31 20 Q29 24 32 24 Q34 23 33 20 Z" />
      <path className={styles.beak} d="M36 14 L42 16 L36 18 Z" />
      <Eye cx="32" cy="14" />
    </>
  ),

  // Chó — floppy ear and an upright tail, drawn mid-wag.
  tuat: (
    <>
      <path className={styles.dark} d="M9 28 Q4 22 7 15 Q10 12 11 16 Q8 21 12 25 Z" />
      <Legs backX={[14, 18]} frontX={[26, 31]} top={33} len={12} w={4.2} />
      <ellipse className={styles.body} cx="20" cy="28" rx="12.5" ry="7.5" />
      <circle className={styles.body} cx="32" cy="23" r="6.5" />
      <path className={styles.body} d="M35 24 Q42 24 42 28 Q41 31 35 30 Z" />
      <path className={styles.dark} d="M28 18 Q25 25 28 30 Q32 27 31 19 Z" />
      <Eye cx="32.5" cy="21.5" />
      <circle className={styles.dark} cx="41.5" cy="27" r="1.4" />
    </>
  ),

  // Lợn — round and low, big snout, curly tail, short legs.
  hoi: (
    <>
      <path className={styles.curl} d="M7 27 Q2 26 3 22 Q4 19 6 21 Q4 24 8 24" />
      <Legs backX={[14, 18]} frontX={[27, 31]} top={36} len={9} w={4.6} />
      <ellipse className={styles.body} cx="21" cy="30" rx="13" ry="9" />
      <path className={styles.light} d="M30 21 L29 15 L34 19 Z" />
      <path className={styles.light} d="M37 22 L38 16 L34 19 Z" />
      <circle className={styles.body} cx="34" cy="27" r="7" />
      <ellipse className={styles.light} cx="39" cy="29" rx="3.6" ry="3" />
      <circle className={styles.dark} cx="38.2" cy="28.2" r="0.9" />
      <circle className={styles.dark} cx="40.2" cy="29.8" r="0.9" />
      <Eye cx="33" cy="25" />
    </>
  ),
}

/**
 * @param {object} props
 * @param {string} [props.zodiac] - a zodiac.js ZODIAC key
 * @param {boolean} [props.walking] - true while this piece is stepping between tiles; drives the leg/gait animation
 * @param {string} [props.fallback] - shown when `zodiac` is unset or unrecognized (GameBoard passes playerInitial())
 */
export default function ZodiacFigure({ zodiac, walking = false, fallback }) {
  const figure = FIGURES[zodiac]

  if (!figure) {
    return (
      <svg className={styles.figure} viewBox="0 0 44 48" aria-hidden="true">
        <ellipse className={styles.body} cx="22" cy="30" rx="13" ry="15" />
        <text className={styles.fallbackText} x="22" y="36" textAnchor="middle">
          {fallback ?? '?'}
        </text>
      </svg>
    )
  }

  return (
    <svg className={`${styles.figure} ${walking ? styles.walking : ''}`} viewBox="0 0 44 48" aria-hidden="true">
      {/* Ground line is y=46; every figure above is drawn standing on it. */}
      <g className={styles.gait}>{figure}</g>
    </svg>
  )
}

export { GROUND }
