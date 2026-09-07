# Asymmetric Mode (Chế độ Đột Phá) - Deckbuilding & TFT Synergy Architecture (V4 - Data Driven)

*Bản V4 được cập nhật dựa trên dữ liệu thật từ mô phỏng Monte Carlo (1000 ván). Sửa chữa sai lầm định lượng của các phiên bản trước.*

---

## 1. Nền Tảng Kỹ Thuật & Dữ Liệu (Monte Carlo Data)

### 1.1. Hành vi Né tránh (Landing vs Pass-through)
Trái với dự đoán ban đầu, việc người chơi có Thẻ Di Chuyển **không làm biến mất việc dẫm trúng (Landing)**. Dữ liệu cho thấy:
- **Tần suất dẫm:** Chỉ giảm từ 43.8% xuống 35.7%. Người chơi vẫn phải dẫm lên đất địch vì 72% bàn cờ đã bị mua hết.
- **Tiền thuê (Rent):** Giảm mạnh 46%.
👉 **Kết luận:** Người chơi không thể né việc dẫm trúng, họ chỉ dồn tài nguyên để **né các khu đất đắt tiền (Tử Địa, Thượng Lưu)** và chấp nhận dẫm lên khu rẻ tiền (Bình Dân, Giao Thương). Do đó, các hiệu ứng Landing không dùng tiền (Rút bài, Lộ bài) vẫn hoạt động hoàn hảo.

### 1.2. Nhịp độ Game & Bộ Bài Tốc Độ Cao (Fast Deck)
Do Thẻ Di Chuyển thường ngắn hơn Xúc xắc (3 bước vs 7 bước), nền kinh tế bị chậm đi một nửa (Lương qua trạm GO giảm 46%).
👉 **Giải pháp:** Phổ bước đi của Bộ Bài (Movement Deck) được nâng lên **4–9 bước** (thay vì 1-6), có kèm Sprint 12. Điều này khôi phục 100% dòng tiền của hệ thống.

### 1.3. Các Giới Hạn Toàn Cục (Global Caps)
- **Tay bài (Hand Size):** Giảm xuống **2 lá** (Dữ liệu cho thấy lá thứ 3 không tạo thêm giá trị né tránh đáng kể, giữ ở 2 lá làm game gắt gao và punchy hơn).
- **Trần Pass-through:** Tối đa 2 hiệu ứng Pass-through / lần di chuyển. (Tỉ lệ Pass-through : Landing thực tế là 6:1).

### 1.4. Phase Draft (Định Hình Đội Hình)
- `DRAFTING` Phase diễn ra trước Lượt 1. **Số vòng co giãn theo số người: 2 người → 2 vòng · 3 người → 3 vòng · 4 người trở lên → 4 vòng.**
- Thứ tự **Snake Draft** (1-2-3-4 -> 4-3-2-1), đảo chiều ở **mọi vòng chẵn**.
- Draft chào **mọi ô mua được**, bao gồm cả Bến Xe và Công Ty.

> **[SỬA 2026-09-07 — hai thay đổi, đều do đo đạc ép ra]**
>
> **(1) Số vòng co giãn.** Trước đây cố định 2 vòng cho mọi số người. Bàn nhỏ có 26 ô mua được và `boards.sql` cho 2-4 người ngồi trên nó, nên mỗi người đi từ ~12 ô (2 người) xuống ~6 ô (4 người) — trong khi ngưỡng Thế Lực vẫn là con số tuyệt đối. Đo 250 trận 4 người với 2 vòng: người chuyên **Bình Dân trung bình chỉ gom được 1.7 ô và không kích hoạt nổi cấp nào trong 49% số trận**; Hạ Tầng là 56%. Tức là một nửa số ván "chọn hệ" kết thúc với hệ bị tắt hoàn toàn.
>
> **(2) Bỏ lệnh cấm draft Bến Xe/Công Ty.** Lệnh cấm cũ ("tránh snowball max cấp từ Lượt 0") hoá ra gây hại lớn hơn nhiều so với thứ nó phòng: Bến Xe và Hạ Tầng mỗi hệ chỉ có 2 ô trên bàn nhỏ, và là **hai hệ duy nhất draft không với tới được** — muốn có phải dẫm trúng đúng 1 trong 2 ô trước khi người khác mua. Tăng số vòng draft **không giúp chúng một ô nào** (0.7 ô ở 2 vòng, vẫn 0.7 ở 5 vòng) chính vì bị loại khỏi rổ. Sau khi bỏ cấm: tỉ lệ "cấp 0" của Bến Xe rơi 41% → 18%, Hạ Tầng 43% → 20%, và cân bằng ván **2 người cũng tốt lên** (dải mạnh-yếu 11.9 → 6.8 điểm). Snowball lo ngại không xuất hiện: ôm cả 2 bến từ lượt 0 là lợi thế thật nhưng không áp đảo, và phải trả bằng 2 lượt draft đầu.

---

## 2. Các Thế Lực Giai Đoạn 1 (Đã cân bằng theo Traffic & Cost)

### 2.1. 🔴🟢 BÌNH DÂN — "CONTROL" (Giá cực rẻ: ~$440)
- **Traffic:** Nằm ở nửa đầu bàn cờ (Ô 1-8). Bị đi ngang qua nhiều gấp 2.4 lần so với Tử Địa. Cực kỳ hiệu quả trên mỗi đồng vốn.
- **Mốc kích hoạt:** 2 Đất / 3 Đất / 4 Đất.
- **🚶 Đi ngang qua:** Đối thủ bị trừ 1 bước — **đủ 4 Đất (cấp 3) thì trừ 2 bước**.
- **🎯 Dừng lại:** Trả Rent ×1.5 (không đổi theo cấp).

> **[SỬA 2026-09-07 — thang cấp trước đây rỗng]** Mốc cũ là 2/4/5, tức cấp 3 đòi **cả 5 ô** Bình Dân. Chạy trực tiếp trên engine từ 1 đến 5 ô cho thấy hiệu ứng **y hệt nhau từ 2 ô trở lên** (trừ 1 bước, +50% thuê, ở mọi cấp) — hai phần ba cái thang chỉ tồn tại trong giao diện, mà bảng Thế Lực vẫn hiện "còn 2 ô nữa lên cấp 2" cho người chơi. Cấp 3 cũ đo được chỉ đạt 2% số trận 2 người và 0% số trận 4 người.
>
> Đã thử cho **tiền thuê** tăng theo cấp (+50% → +75% → +100%) và **đo là vô dụng**: tỉ lệ thắng nhích 26.1% → 26.6%, vì đất Bình Dân có tiền thuê gốc thấp nhất bàn cờ ($2-$8) nên vài chục phần trăm của một số nhỏ vẫn là số nhỏ. Giá trị của hệ này nằm ở hiệu ứng **đi ngang qua**, nên phần thưởng cấp phải đặt ở đó. Mốc hạ xuống 2/3/4 để cái thang thật sự với tới được (cấp 2: 10% → 38%, cấp 3: 3% → 13% ở mẫu 500).

### 2.2. 🚉 BẾN XE — "MOBILITY" (Giá rẻ: $400)
- **Mốc kích hoạt:** 1 Bến / 2 Bến (Max).
- **🚶 Đi ngang qua:** Tự động đẩy đối thủ tiến/lùi 1 bước về phía ô đất gần nhất mà bạn sở hữu.
- **🎯 Dừng lại:** Teleport ép buộc (Chỉ mốc 2 Bến).

### 2.3. ⚡💧 HẠ TẦNG — "POWER & SUSTAIN" (Giá rẻ: $400)
- **Mốc kích hoạt:** 1 Công ty / 2 Công ty.
- **🚶 Đi ngang qua:** Đối thủ trả $25 phí hạ tầng (chỉ khi đủ 2 Công ty).
- **🎯 Dừng lại:** Mọi tiền thuê chủ sở hữu thu được +10% (đủ 2 Công ty: +25%) — áp dụng trên **TẤT CẢ** các ô, kể cả ô thuộc hệ khác.

> **[ĐÃ SỬA 2026-09-04 — bản trên là bản thực sự chạy trong code.]** Bản gốc của mục này tiêu cả hai hiệu ứng vào một "Quỹ dự trữ" chưa từng tồn tại trong codebase (không có state, không có luật nạp, không có luật tiêu) — đó chính là lý do Hạ Tầng nằm im không hiệu ứng nào suốt từ đầu. Bản đã ship giữ nguyên định vị "POWER & SUSTAIN" (hệ hỗ trợ, rẻ, tự nó không sát thương nhưng nhân giá trị mọi thứ khác bạn có) nhưng chỉ dùng từ vựng mà engine đã biết cách thanh toán. Nếu sau này Quỹ dự trữ được xây thật, đây là chỗ để xem lại.

### 2.4. 🟣🟠 GIAO THƯƠNG — "ECONOMY" (Giá trung bình: ~$1.000)
- **Traffic:** Rất thường xuyên bị dẫm trúng do nằm ở khu vực đối thủ chọn "lesser evil" để hạ cánh.
- **Mốc kích hoạt:** 2 Đất / 4 Đất / 6 Đất.
- **🚶 Đi ngang qua:** Nạn nhân bỏ 1 lá bài -> Bạn rút 1 lá. **Từ mốc 4 Đất trở lên, thu thêm phí $30 mỗi cấp** (4 Đất: $30 · 6 Đất: $60).
- **🎯 Dừng lại:** Trả Rent + Chủ đất rút ngay 2 lá bài.

> **[BỔ SUNG 2026-09-07 — phí quá cảnh]** Giao Thương và Thượng Lưu là hai hệ duy nhất mà hiệu ứng đi-ngang-qua **không tốn của đối thủ đồng nào** (đổi bài / lộ bài). Đo trên engine thật: cả hai chỉ thắng ~28-30% trong khi bốn hệ còn lại ở 43-53%, và lý do nằm ở số nhà — đối thủ xây được 5.9-6.8 nhà khi đấu với hai hệ này, so với 3.3-4.7 khi đấu với các hệ khác. Không bị chặn dòng tiền, đối thủ cứ thế xây và vượt lên. **Đã thử tăng tiền thuê trước và bác bỏ bằng số liệu:** quét từ +0% đến +100% (tức gấp đôi tiền thuê) chỉ làm tỉ lệ thắng nhúc nhích trong sai số (30.6% → 31.2%), vì dừng lại đúng ô của một bộ 6 ô là biến cố quá hiếm. Đi ngang qua mới là biến cố thường xuyên, nên phí được đặt ở đó.
>
> **Vì sao chặn ở mốc 4 Đất chứ không phải 2:** Giao Thương + Thượng Lưu cộng lại là tím+cam+vàng+xanh lá = **12 trong tổng số 22 ô đất**. Nếu phí bắt đầu từ mốc 2 Đất, nó đánh thuế hơn nửa bàn cờ và người **mua dàn trải** mới là người thu được nhiều nhất, chứ không phải người chuyên một hệ. Đo thật: phí $20 tính từ mốc 2 kéo Giao Thương/Thượng Lưu lên ~50% nhưng đồng thời dìm Tử Địa từ 53.2% xuống **16.5%** và Bình Dân xuống 28.7%. Mốc 4 Đất là thứ người chơi dàn trải gần như không bao giờ gom đủ, còn người chuyên hệ thì luôn đạt — nên nó biến phí này thành **phần thưởng cho việc dốc sức vào một hệ**, không phải thuế toàn bàn.

---

## 3. Các Thế Lực Giai Đoạn 2 (Đắt đỏ & Phức tạp)

### 3.1. 🟡🟩 THƯỢNG LƯU — "DENIAL" (Giá đắt: ~$1.480)
- **Mốc kích hoạt:** 2 Đất / 4 Đất / 6 Đất.
- **🚶 Đi ngang qua:** Lá bài kế tiếp của nạn nhân bị lộ cho chủ đất thấy. **Từ mốc 4 Đất trở lên, thu thêm phí $30 mỗi cấp** (4 Đất: $30 · 6 Đất: $60) — xem giải thích ở §2.4.
- **🎯 Dừng lại:** Lộ toàn bộ tay bài trong 2 lượt.

> **[GHI CHÚ 2026-09-07 — hiệu ứng lộ bài đã hoạt động thật]** Comment trong `synergyEngine.js` từng cảnh báo hiệu ứng này "vô hiệu" vì server phát toàn bộ GameState cho mọi người. Cảnh báo đó **đã cũ**: `engine/stateRedaction.js` che bài theo từng người xem, `socketServer.js` gọi nó trước khi gửi, và `PlayersPanel.jsx` hiện lá bị lộ kèm nhãn 🔍. Đo riêng bằng thí nghiệm cách ly (hai bên đều Thượng Lưu, cùng cách mua đất, cùng dùng bẫy, chỉ khác một bên **dùng** thông tin còn bên kia cố tình bỏ qua): bên biết dùng thắng **57-60%**. Nghĩa là thông tin có giá trị thật — nhưng chỉ với người chịu để ý. Phí quá cảnh ở trên tồn tại để hệ này vẫn có giá trị nền cho người không tận dụng thông tin.

### 3.2. 🩵🔵 TỬ ĐỊA — "EXECUTION" (Giá đắt nhất: ~$1.670)
- **Traffic:** Nằm cuối bàn cờ (Ô 28-35). Ít người qua lại nhất, hiệu quả trên vốn bị hụt nghiêm trọng. Phải bù đắp bằng sát thương cực cao.
- **Mốc kích hoạt:** 2 Đất / 4 Đất / 5 Đất.
- **🚶 Đi ngang qua:** Trả phí quá cảnh = **[Cấp độ nhà × ($30 / $45 / $60 theo cấp Thế Lực)]**.
  - **[Phân phối lại 2026-09-07 — thang cấp trước đây rỗng, y như Bình Dân]** Phí cũ là $45/cấp nhà ở **mọi** cấp Thế Lực, nên 2 ô và 5 ô cho ra hiệu ứng giống hệt nhau. Nay $30 ở cấp 1, +$15 mỗi cấp. **Đây không phải buff** — trung bình giữ gần như cũ, chỉ là dời cùng số tiền lên cái thang để cái thang có ý nghĩa. Đo trung tính: 45.2% (phẳng) so với 46.3% (phân phối lại) ở mẫu 300, nằm trong sai số.
  - **[Nâng lại 2026-09-07: $30 → $45]** Không phải vì Tử Địa yếu sẵn, mà vì bàn cờ quanh nó vừa đổi. Khi Giao Thương/Thượng Lưu có phí quá cảnh (§2.4), cả bàn cờ có thêm một chỗ rò tiền — và Tử Địa là hệ chịu đựng kém nhất, vì phí của chính nó nhân theo **cấp nhà**, tức là nó bắt buộc phải xây được nhà thì mới có răng. Tiền trả phí cho người khác là tiền không xây được nhà. Đo thật: giữ nguyên $30 sau khi thêm phí mới, Tử Địa rơi từ 53.2% xuống **40.3%** và chỉ xây được 2.9 nhà so với 5.7 của đối thủ. Ở $45 nó về **49.5%** và xây 4.3 so với 4.4. Đã quét cả $60 và $75 — cả hai đều quá tay, kéo Bình Dân xuống 35-36%.
  - *(Lịch sử: Retuned 2026-09-06: $75 — vốn tăng gấp 3 lần từ V3 để cân bằng với Control — chưa từng được kiểm lại sau khi bẫy/Hạ Tầng/bộ bài thật ra đời. Mô phỏng Monte-Carlo trên engine thật cho thấy $75 khiến Tử Địa thắng 60%+; tắt hẳn phí lại khiến nó dưới 40% — chứng minh phí quá cảnh, không phải tiền thuê gốc, mới là đòn bẩy thật. $30 đưa tỉ lệ thắng về ~52-55%, tỉ lệ tổng tài sản đo được đúng 1.00 ở mẫu 600 trận.)*
- **🎯 Dừng lại:** Trả Rent đầy đủ + Hiệu ứng Tịch thu.

---

## 3.3. Kết Quả Cân Bằng Đo Được (2026-09-07)

Mỗi hệ đóng vai người chơi A (chuyên một hệ) đấu các người chơi B (mua dàn trải, không thiên vị hệ nào), **500 trận/hệ**, chạy trực tiếp trên `stateMachine/turnMachine.js` chứ không phải mô hình riêng.

⚠️ **Cảnh báo về số cũ:** bảng đăng ở bản trước của mục này (dải 8.6 điểm) được đo bằng một con bot có lỗi — bot "mua dàn trải" luôn bốc **ô rẻ nhất** trong draft, mà 5 ô rẻ nhất bàn cờ **chính là 5 ô Bình Dân** ($60-$120). Nó vặt sạch bộ Bình Dân mỗi ván theo cách không bàn người thật nào làm. Bot đã được sửa thành bốc ngẫu nhiên (đó mới là đường cơ sở trung lập cho một đối thủ không thiên vị hệ nào); mọi con số dưới đây đo lại sau khi sửa.

**2 người (bàn nhỏ, draft 2 vòng):**

| Thế Lực | Trước loạt sửa | Sau |
|---|---|---|
| Bình Dân (CONTROL) | 36.3% | **41.7%** |
| Giao Thương (ECONOMY) | 42.7% | 42.0% |
| Thượng Lưu (DENIAL) | 44.4% | 38.7% |
| Tử Địa (EXECUTION) | 40.3% | 39.1% |
| Bến Xe (MOBILITY) | 32.5% | **36.4%** |
| Hạ Tầng (INFRA) | 37.4% | **43.3%** |

**Độ lệch mạnh nhất ↔ yếu nhất: 11.9 điểm → 6.9 điểm.**

**4 người (bàn nhỏ, draft 4 vòng — thắng ngẫu nhiên = 25%):** mọi hệ nay đều ở hoặc trên mức ngẫu nhiên (25.8% - 39.2%), và quan trọng hơn là tỉ lệ "kết thúc ván mà chưa kích hoạt nổi cấp nào" đã giảm mạnh ở hai hệ từng bị bỏ đói: Bến Xe 48% → 20%, Hạ Tầng 56% → 27%.

⚠️ **Giới hạn của con số này, cần đọc kèm:**
1. Toàn bộ đo ở **2 người chơi, bot đấu bot, không có thương lượng/trao đổi**. Ván thật 3-6 người có yếu tố chính trị bàn cờ mà mô phỏng này không mô tả được — Thượng Lưu (thông tin) nhiều khả năng mạnh hơn trong bối cảnh đó chứ không yếu hơn.
2. Đối thủ B luôn là bot mua dàn trải. Cả 6 hệ đều dưới 50% một chút là chuyện bình thường: mua dàn trải vốn có lợi thế cấu trúc trong thế 1-đấu-1.
3. **Bẫy là công cụ mạnh hơn mọi Thế Lực.** Đo riêng: chuyên gia biết đặt bẫy chủ động thắng 78-93% trước đối thủ không dùng bẫy. Khi cả hai bên đều dùng bẫy thì trở lại cân bằng. Nghĩa là người chơi bỏ qua cơ chế bẫy sẽ thua rất đậm — đây là vấn đề **hướng dẫn/UX**, không phải vấn đề cân bằng số.
4. Bàn nhỏ (36 ô) phục vụ **2-4 người**, bàn lớn (44 ô) phục vụ 5-6. Số ô mua được là cố định (26 / 28) trong khi ngưỡng Thế Lực là số tuyệt đối, nên càng đông người thì mỗi hệ càng khó thành hình. Draft co giãn (§1.4) là thứ bù cho việc đó; nếu sau này mở bàn nhỏ cho 5+ người hoặc đổi số ô, phải đo lại mục này.

---

## 4. Lộ Trình Triển Khai Thực Tế

- **Bước 1: Nâng cấp Bộ bài (Movement Dictionary).** Đổi toàn bộ các thẻ đi bộ thông thường thành dải `[4, 5, 6, 7, 8, 9]`. Sửa thẻ Sprint thành 12 bước.
- **Bước 2: Cập nhật State Machine.** Thêm Timer cho `PLAYING_CARD`, giảm giới hạn tay bài xuống còn 2.
- **Bước 3: Tích hợp Draft Phase.** (Giữ nguyên kiến trúc độc lập).
- **Bước 4: Cập nhật Middleware.** Viết logic Pass-through và đếm Set Levels.
