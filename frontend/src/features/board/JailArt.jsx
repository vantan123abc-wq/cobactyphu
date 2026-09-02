import styles from './JailArt.module.css'

// Jail / Just Visiting tile art (2026-08-22, user request — "Trà Đá Chờ
// Bảo Lãnh" concept). Same reusable `.art*` pattern GoTileArt.jsx
// established.
//
// This is also the tile behind the "hai loại token trên cùng một ô" split
// — see GameBoard.jsx's own `tokensForPosition()`. The art here only draws
// the two zones (an inner barred `.cell` for "Trong Tù", the tile's own
// outer margin standing in for the "Thăm Nuôi" sidewalk, labeled directly);
// where a given player's *token* actually lands is entirely GameBoard.jsx's
// concern, computed from the real `player.inJail` flag, not anything this
// component reads or renders.
export default function JailArt() {
  return (
    <div className={styles.artBg}>
      <span className={styles.visitLabel}>THĂM TÙ</span>

      <div className={styles.cell}>
        <span className={styles.bar} />
        <span className={styles.bar} />
        <span className={styles.bar} />
        <span className={styles.bar} />
        <span className={styles.stool} />
        <span className={styles.cup} />
        <span className={styles.lock} />
      </div>

      <span className={styles.artTitle}>Ở TÙ</span>
    </div>
  )
}
