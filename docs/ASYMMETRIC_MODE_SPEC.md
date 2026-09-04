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
- `DRAFTING` Phase (2 vòng) diễn ra trước Lượt 1.
- Thứ tự **Snake Draft** (1-2-3-4 -> 4-3-2-1).
- **CẤM** Draft Bến Xe và Công Ty để tránh snowball max cấp từ Lượt 0.

---

## 2. Các Thế Lực Giai Đoạn 1 (Đã cân bằng theo Traffic & Cost)

### 2.1. 🔴🟢 BÌNH DÂN — "CONTROL" (Giá cực rẻ: ~$440)
- **Traffic:** Nằm ở nửa đầu bàn cờ (Ô 1-8). Bị đi ngang qua nhiều gấp 2.4 lần so với Tử Địa. Cực kỳ hiệu quả trên mỗi đồng vốn.
- **Mốc kích hoạt:** 2 Đất / 4 Đất / 5 Đất.
- **🚶 Đi ngang qua:** Đối thủ bị trừ đúng 1 bước.
- **🎯 Dừng lại:** Trả Rent ×1.5.

### 2.2. 🚉 BẾN XE — "MOBILITY" (Giá rẻ: $400)
- **Mốc kích hoạt:** 1 Bến / 2 Bến (Max).
- **🚶 Đi ngang qua:** Tự động đẩy đối thủ tiến/lùi 1 bước về phía ô đất gần nhất mà bạn sở hữu.
- **🎯 Dừng lại:** Teleport ép buộc (Chỉ mốc 2 Bến).

### 2.3. ⚡💧 HẠ TẦNG — "POWER & SUSTAIN" (Giá rẻ: $400)
- **Mốc kích hoạt:** 1 Công ty / 2 Công ty.
- **🚶 Đi ngang qua:** Phí quá cảnh bạn thu được +10% vào quỹ dự trữ.
- **🎯 Dừng lại:** +25% Rent (Có Overload) + Trích Rent vào Quỹ Dự trữ.

### 2.4. 🟣🟠 GIAO THƯƠNG — "ECONOMY" (Giá trung bình: ~$1.000)
- **Traffic:** Rất thường xuyên bị dẫm trúng do nằm ở khu vực đối thủ chọn "lesser evil" để hạ cánh.
- **Mốc kích hoạt:** 2 Đất / 4 Đất / 6 Đất.
- **🚶 Đi ngang qua:** Nạn nhân bỏ 1 lá bài -> Bạn rút 1 lá.
- **🎯 Dừng lại:** Trả Rent + Chủ đất rút ngay 2 lá bài.

---

## 3. Các Thế Lực Giai Đoạn 2 (Đắt đỏ & Phức tạp)

### 3.1. 🟡🟩 THƯỢNG LƯU — "DENIAL" (Giá đắt: ~$1.480)
- **Mốc kích hoạt:** 2 Đất / 4 Đất / 6 Đất.
- **🚶 Đi ngang qua:** Lá bài kế tiếp của nạn nhân bị lộ cho chủ đất thấy.
- **🎯 Dừng lại:** Lộ toàn bộ tay bài trong 2 lượt.

### 3.2. 🩵🔵 TỬ ĐỊA — "EXECUTION" (Giá đắt nhất: ~$1.670)
- **Traffic:** Nằm cuối bàn cờ (Ô 28-35). Ít người qua lại nhất, hiệu quả trên vốn bị hụt nghiêm trọng. Phải bù đắp bằng sát thương cực cao.
- **Mốc kích hoạt:** 2 Đất / 4 Đất / 5 Đất.
- **🚶 Đi ngang qua:** Trả phí quá cảnh khổng lồ = **[Cấp độ nhà × $75]**. (Tăng gấp 3 lần so với V3 để cân bằng với Control).
- **🎯 Dừng lại:** Trả Rent đầy đủ + Hiệu ứng Tịch thu.

---

## 4. Lộ Trình Triển Khai Thực Tế

- **Bước 1: Nâng cấp Bộ bài (Movement Dictionary).** Đổi toàn bộ các thẻ đi bộ thông thường thành dải `[4, 5, 6, 7, 8, 9]`. Sửa thẻ Sprint thành 12 bước.
- **Bước 2: Cập nhật State Machine.** Thêm Timer cho `PLAYING_CARD`, giảm giới hạn tay bài xuống còn 2.
- **Bước 3: Tích hợp Draft Phase.** (Giữ nguyên kiến trúc độc lập).
- **Bước 4: Cập nhật Middleware.** Viết logic Pass-through và đếm Set Levels.
