import styles from './GoToJailArt.module.css'

// Go To Jail tile art (2026-08-22, user request — "Bị Tuýt Còi/Tạm Giữ
// Phương Tiện" concept: a traffic stop). Same reusable pattern
// GoTileArt.jsx established (a full-bleed `.artBg` gradient layer inside
// `.tile`, escaping `.content`'s own flex layout via `position: absolute;
// inset: 0` against `.tile`'s `position: relative`) — see that file's own
// header for the fuller reasoning, not repeated here.
//
// The brief's own directional-arrow requirement ("points toward the Jail
// corner") is deliberately NOT attempted as a geometrically-aimed arrow —
// Go To Jail and Jail sit on *diagonally opposite* corners of the board
// (computeGridPosition's own jailCorner vs goToJailCorner), so a real aimed
// arrow would need live per-render trig against the tile's own current
// isometric rotation, the same class of computation GameBoard.jsx already
// does for the camera — worth doing if this becomes a real requirement, not
// worth guessing at here. A plain downward chevron (the "you're being sent
// away" motif) is used instead, flagged rather than faked as aimed.
export default function GoToJailArt() {
  return (
    <div className={styles.artBg}>
      <span className={styles.warnBadge}>!</span>
      <div className={styles.baton} />
      <span className={styles.whistle} />
      <span className={styles.artTitle}>VÀO TÙ</span>
      <span className={styles.chevron} />
    </div>
  )
}
