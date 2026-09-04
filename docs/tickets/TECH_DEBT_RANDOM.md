# Tech Debt: luồn `randomSource` vào luồng rút bài di chuyển

**Trạng thái:** Mở · **Ưu tiên:** Thấp · **Ghi nhận:** 2026-09-04 (khép lại chiến dịch Asymmetric)

## Vấn đề

`drawMovementHand()` (`backend/src/domain/movementDictionary.js`) và chỉ số discard của
`CARD_REROLL` (`backend/src/stateMachine/turnMachine.js`, hàm `applyCardEffect`) gọi thẳng
`Math.random()`. Điều này phá vỡ quy ước "state machine không tự sinh ngẫu nhiên" mà
`engine/dice.js`, `engine/draftPhase.js` và `serverGeneratedFields()` (socketServer.js)
đều tuân theo.

Bản thân `turnMachine.js` đã ghi nhận điều này trong comment của `applyCardEffect` —
ticket này chỉ đưa nó ra khỏi chỗ không ai đọc.

## Vì sao không sửa được bằng cách thông thường

Quy ước hiện tại là **sinh sẵn** giá trị ngẫu nhiên ở tầng socket rồi nhét vào
`action.payload` (xem `serverGeneratedFields()` xử lý `cardRoll` cho thẻ `MOVE_RANDOM_2_12`).

Ở đây **không sinh sẵn được**: *rút bao nhiêu lá* phụ thuộc vào runtime — người chơi cắt
ngang qua mấy ô Giao Thương (ECONOMY) thì mới biết `CARD_REROLL` kích hoạt mấy lần. Tầng
socket không thể biết trước con số đó.

Nên phương án thực tế là một trong hai:

1. Luồn tham số `randomSource` xuyên qua `startTurn()` (mọi đường `advanceTurn`/`END_TURN`
   đều đi tới) và `applyCardEffect()`, theo đúng chữ ký mà `rollDice()`/`offerDraftTiles()`
   đã dùng; hoặc
2. Gắn một PRNG có seed lên chính `GameState`, để mọi lời gọi ngẫu nhiên đều tái lập được
   từ snapshot.

Cả hai đều cần cập nhật fuzz harness đi kèm.

## Vì sao ưu tiên THẤP (không phải lỗ hổng bảo mật)

- Client **không tác động được** vào `Math.random()` phía server.
- `stateMachine/idempotency.js` **cache kết quả** thay vì thực thi lại, nên một lần retry
  phát lại đúng lá bài đã rút chứ không rút lại lá khác.

Đây là nợ về **tính nhất quán kiến trúc và khả năng tái lập**, không phải lỗ hổng khai
thác được.

## Giá trị thật khi trả nợ

Replay một trận đấu từ `game_state_snapshots` sẽ cho ra kết quả y hệt lần chạy gốc —
hiện tại thì không. Nếu team làm tính năng **Replay / xem lại trận**, đây trở thành việc
bắt buộc chứ không còn là dọn dẹp.

## Vị trí cần sửa

| File | Điểm gọi |
|---|---|
| `backend/src/domain/movementDictionary.js` | `drawMovementHand()` — `DECK_ARRAY[Math.floor(Math.random() * ...)]` |
| `backend/src/stateMachine/turnMachine.js` | `applyCardEffect()` — `const discardIndex = Math.floor(Math.random() * hand.length)` |
| `backend/src/stateMachine/turnMachine.js` | `startTurn()` — gọi `drawMovementHand()` để bù bài đầu lượt |
