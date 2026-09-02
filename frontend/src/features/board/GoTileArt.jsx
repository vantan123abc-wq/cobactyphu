import styles from './GoTileArt.module.css'

// Mirrors backend/src/stateMachine/turnMachine.js's own PASS_GO_SALARY
// constant — no shared package between frontend/backend in this repo, same
// standing as every other mirrored backend constant this codebase already
// has (JAIL_FINE in GameControls.jsx, MAX_UPGRADE_LEVEL in
// PropertyManager.jsx/BoardTile.jsx, etc.).
const PASS_GO_SALARY = 200

// GO/START tile art (2026-08-22, user-supplied reference image + a full
// "Vietnamese Street & Heritage" art-direction brief) — a festive Tết "lì
// xì" (lucky-money envelope) treatment, replacing the tile's old plain
// "GO" text label. Scoped to just this one corner for now (the user's own
// explicit choice, out of the brief's much larger scope covering every
// tile type) but built as a reusable pattern, not a one-off: every class in
// GoTileArt.module.css is named generically (`.artBg`/`.artCorner`/
// `.artTitle`/`.artSubtitle`), not go-specific, so a future Jail/Free
// Parking/Go To Jail (or any other) tile that gets real art can follow the
// identical structure with different content/colors instead of inventing a
// second pattern.
//
// No AI-generated background image exists yet (this session has no
// image-generation tool) — `.artBg` paints a CSS gradient placeholder in
// the brief's own warm red/gold palette, wired through a `--art-bg-image`
// custom property that defaults to `none`. Dropping a real generated
// PNG/WebP in later needs exactly one line — set that custom property to
// `url(...)` (inline style, or a small CSS override) — not a component
// change.
//
// The envelope/coins below are simple layered circles and rounded
// rectangles, not a recreation of the reference image's full illustration
// — the same "simple primitives only, no complex bezier curves" discipline
// TileIcon.jsx's own header already established, and for the same reason:
// this session's tooling still can't produce a screenshot, so every shape
// has to be simple enough to verify correct by measurement/structure, not
// by eye. The reference image's cherry-blossom branches and cloud+arrow
// flourish are deliberately not attempted here — that level of illustrated
// detail is exactly what the eventual AI-generated background image is
// for, not something worth hand-approximating in CSS at a real corner
// tile's actual on-screen size (~150-170px).
export default function GoTileArt() {
  return (
    <div className={styles.artBg}>
      <span className={`${styles.artCorner} ${styles.tl}`} />
      <span className={`${styles.artCorner} ${styles.tr}`} />
      <span className={`${styles.artCorner} ${styles.bl}`} />
      <span className={`${styles.artCorner} ${styles.br}`} />

      <div className={styles.envelope}>
        <span className={`${styles.coin} ${styles.coin0}`} />
        <span className={`${styles.coin} ${styles.coin1}`} />
        <span className={styles.envelopeBody}>
          <span className={styles.envelopeSeal} />
        </span>
      </div>

      <span className={styles.artTitle}>BẮT ĐẦU</span>
      <span className={styles.artSubtitle}>+${PASS_GO_SALARY}</span>
    </div>
  )
}
