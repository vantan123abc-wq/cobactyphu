import { useGameStore } from '../../store/gameStore'
import styles from './MatchUnavailable.module.css'

// Shown instead of the board once the server has told us this match does not
// exist for us any more (gameStore's MATCH_UNAVAILABLE_CODES).
//
// Why this screen exists: the client used to keep rendering a fully
// interactive board in that situation. Every click then came back "Ván chưa
// bắt đầu" — a sentence that reads as nonsense in the middle of round 3, and
// which cost a real player a bug hunt through the Đầu hàng button when the
// button was fine and the match was simply gone from the server.
//
// The common cause is a backend restart (a deploy does exactly that) landing
// between the durable snapshots that are written at each END_TURN. The board
// on screen is then a ghost: it renders from this tab's own last known state
// and nothing it does can reach a game.
const REASONS = {
  ROOM_NOT_IN_PROGRESS: 'Máy chủ không còn giữ ván đấu này — nhiều khả năng nó đã khởi động lại giữa ván.',
  GAME_NOT_FOUND: 'Máy chủ không tìm thấy dữ liệu ván đấu này để khôi phục.',
  NOT_A_PARTICIPANT: 'Tài khoản này không còn là người chơi trong phòng đó.',
}

export default function MatchUnavailable() {
  const code = useGameStore((s) => s.matchUnavailable)
  const resetAfterGame = useGameStore((s) => s.resetAfterGame)

  return (
    <section className={styles.wrap}>
      <div className={styles.card}>
        <p className={styles.eyebrow}>⚠️ Ván đấu không còn khả dụng</p>
        <p className={styles.reason}>{REASONS[code] ?? 'Máy chủ đã từ chối mọi thao tác trong ván này.'}</p>
        <p className={styles.note}>
          Bàn cờ bạn vẫn đang thấy chỉ là bản hiển thị cũ của trình duyệt, không còn kết nối tới ván nào.
          Mọi thao tác trên đó đều sẽ bị từ chối.
        </p>
        <button type="button" className={styles.button} onClick={resetAfterGame}>
          Quay về sảnh
        </button>
        <p className={styles.code}>Mã lỗi: {code}</p>
      </div>
    </section>
  )
}
