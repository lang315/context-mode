# Persist lifetime-stats cache — design

**Ngày:** 2026-10-20 · **Fork:** lang315/context-mode · **Trạng thái:** chờ duyệt

## 1. Mục tiêu và tiêu chí thành công

Mục tiêu người dùng: (a) giảm ghi đĩa / bảo vệ SSD, (b) `ctx_*` nhanh.

Bản `1.0.169-lang315.1` đã cache số liệu lifetime theo từng session DB **trong RAM**. Còn lại một chi phí: mỗi tiến trình MCP mới khởi động có cache rỗng, nên lần `getLifetimeStats` đầu tiên mở **toàn bộ** `sessions/*.db` (122 DB trên máy thật: 122 lần mở, 154 ms, ghi lại ~122 × 32 KB ≈ 4 MB file `-shm`).

**Thành công khi:**
1. Tiến trình mới, với các DB không đổi kể từ lần chạy trước, chỉ mở các DB đã đổi (đo bằng loader đếm số lần mở: ≤ số DB thực sự đổi).
2. Kết quả `getLifetimeStats` giống hệt bản không có file cache.
3. Không tăng lượng ghi đĩa ở trạng thái ổn định: file cache chỉ được ghi **tối đa một lần mỗi tiến trình**.
4. File cache hỏng / sai phiên bản / thiếu ⇒ hành vi giống bản hiện tại (quét lại), không lỗi.

**Không làm (YAGNI):** không xoá hay di chuyển DB nào; không đụng `getRealBytesStats`, `getConversationStats`, `scanOneAdapter` (chỉ chạy khi `ctx_stats` hoặc statusline của context-mode — máy này dùng statusline claude-hud); không thêm biến môi trường.

## 2. Giá trị kỳ vọng (nói thẳng)

Tiết kiệm ~4 MB ghi và ~150 ms CPU **mỗi lần mở một session Claude**. Với 10–20 session/ngày: ~40–80 MB/ngày. Nhỏ so với phần đã sửa (từ ~160 GB/ngày xuống ~2 GB/ngày), nhưng không đổi dữ liệu người dùng, rủi ro thấp.

## 3. Thiết kế

### Lưu trữ
- File: `<sessionsDir>/lifetime-cache.json`. Không khớp `*.db` (vòng quét bỏ qua) và không khớp `stats-*.json` (không bị `cleanupStaleStatsFiles` xoá).
- Nội dung:
  ```json
  { "schemaVersion": 1, "entries": { "<file>.db": { "sig": "<mtimeMs>:<size>:<wal>", "agg": { "events": 0, "sessions": 0, "categoryCounts": {}, "rescueBytes": 0, "firstEventMs": null, "projects": [] } } } }
  ```
  Khoá là **tên file** (không phải đường dẫn tuyệt đối) để file đúng cho chính thư mục chứa nó. `firstEventMs` lưu `null` khi là `+Infinity` (JSON không biểu diễn được Infinity).

### Luồng trong `getLifetimeStats` (`src/session/analytics.ts`)
1. **Nạp (1 lần / tiến trình / sessionsDir):** lần đầu gặp một `sessionsDir`, đọc `lifetime-cache.json`; với mỗi entry hợp lệ, đổ vào `lifetimeDbCache` dưới khoá `join(sessionsDir, file)`. Lỗi đọc / parse / `schemaVersion` khác 1 / entry sai kiểu ⇒ bỏ qua (coi như rỗng).
2. **Quét:** giữ nguyên logic hiện tại (chữ ký lấy trước khi đọc; hit thì dùng cache; miss thì `readLifetimeDbAgg`; lỗi thì không cache).
3. **Ghi (tối đa 1 lần / tiến trình / sessionsDir):** sau lần quét **đầu tiên** của tiến trình cho `sessionsDir` đó, nếu có ít nhất một miss thì ghi lại toàn bộ entry của các DB **hiện có** trong lần quét (DB đã biến mất tự rơi ra khỏi file). Ghi bằng file tạm + `renameSync` (atomic) như `persistStats`. Các lần quét sau trong cùng tiến trình **không ghi**.
4. Nhiều tiến trình ghi cùng lúc ⇒ người ghi sau thắng. Chấp nhận: nội dung chỉ là cache dẫn xuất, chữ ký vẫn được kiểm khi nạp nên entry cũ chỉ gây một lần đọc lại, không bao giờ trả số sai.

### Đơn vị code (cùng file, không export mới)
- `loadPersistedLifetimeCache(sessionsDir): void`
- `savePersistedLifetimeCache(sessionsDir, files: string[]): void`
- `Set<string>` các `sessionsDir` đã nạp và đã ghi.

## 4. Xử lý lỗi
Mọi thao tác đọc/ghi file cache nằm trong `try/catch` im lặng (giống phần còn lại của `getLifetimeStats`: "ctx_stats can never be broken by a corrupt sidecar"). Ghi lỗi (ổ đầy, quyền) ⇒ bỏ qua, tiến trình vẫn có cache RAM.

## 5. Kiểm thử (TDD, `tests/session/lifetime-stats.test.ts`)
Để mô phỏng "tiến trình mới", cần xoá cache RAM giữa hai lần gọi: thêm export chỉ dành cho test `__resetLifetimeCacheForTests()` (đặt tên rõ, không dùng ở runtime).
1. Lần gọi 1 ghi `lifetime-cache.json`; reset RAM; lần gọi 2 mở **0** DB và trả kết quả giống hệt.
2. Sau reset, DB nào đổi (thêm event) thì chỉ DB đó bị mở lại; tổng đúng.
3. File cache hỏng (`"not json"`) hoặc `schemaVersion: 2` ⇒ mở lại toàn bộ, kết quả đúng, không ném lỗi.
4. Trong một tiến trình, lần gọi thứ 2 có miss **không** ghi lại file (mtime file cache không đổi).
5. DB bị xoá ⇒ không còn trong tổng, và bị loại khỏi file ở lần ghi sau.
6. `firstEventMs` = `+Infinity` (DB không có event có timestamp) đi qua JSON và quay lại đúng.

Sau đó: toàn suite `npx vitest run`, `npm run typecheck`; đo trên dữ liệu thật bằng loader đếm (tiến trình 1 rồi tiến trình 2 riêng biệt bằng 2 lần `npx tsx`): tiến trình 2 mở ≤ số DB đã đổi.

## 6. Phát hành
Như các bản trước: commit, đổi version `1.0.169-lang315.3`, `npm run bundle` + 2 assert, thêm dòng vào `FORK.md`, fast-forward `main` của fork, `claude plugin marketplace update context-mode` + `claude plugin update context-mode@context-mode`, người dùng restart session.

## 7. Rủi ro
- Hai DB cùng tên file ở hai `sessionsDir` khác nhau: không xung đột vì mỗi thư mục có file cache riêng.
- Đồng hồ/mtime bị lùi (khôi phục backup) ⇒ chữ ký khác ⇒ đọc lại, an toàn.
- Upstream đổi `LifetimeDbAgg` ⇒ phải tăng `schemaVersion`; ghi chú trong code.
