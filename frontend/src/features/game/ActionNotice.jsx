import { explainError } from './actionErrors'
import styles from './ActionNotice.module.css'

// One notice panel for every server rejection, 2026-09-02.
//
// Replaces the `{errorCode}: {message}` line that seven separate components
// each rendered independently. That line printed an internal developer string
// — function names, raw database UUIDs, English prose — straight at the
// player. See actionErrors.js for the real example that prompted this.
//
// Deliberately a shared component rather than seven local fixes: the codebase
// has been bitten repeatedly by the same logic living in two places and
// drifting (buildRules.js and buyoutRules.js both exist for exactly that
// reason). A new error code now needs one entry in actionErrors.js and
// appears correctly everywhere.
//
// `compact` is for surfaces that are already small and crowded — the auction
// modal, the liquidation sidebar — where the title alone carries the meaning
// and the explanation would crowd out the controls the player needs to reach.
export default function ActionNotice({ error, compact = false }) {
  const info = explainError(error)
  if (!info) return null

  return (
    <div className={`${styles.notice} ${styles[info.tone]} ${compact ? styles.compact : ''}`} role="status">
      <div className={styles.head}>
        <span className={styles.icon} aria-hidden="true">
          {info.tone === 'fault' ? '⚠️' : info.tone === 'timing' ? '⏳' : '🚫'}
        </span>
        <span className={styles.title}>{info.title}</span>
      </div>
      {!compact && <p className={styles.body}>{info.body}</p>}
    </div>
  )
}
