# Goal Check: Kiểm Tra Hoàn Thành Goal Bằng Jev System One

**Goal Check** là cơ chế cổng kiểm soát (gatekeeper/veto) độc lập tích hợp tại `llm-switcher`. Tính năng này bảo vệ các prompt-based stopping condition evaluator của Claude Code (đặc biệt là lệnh `/goal`), ngăn chặn các phán quyết hoàn thành sai (false completion) khi chưa có đủ bằng chứng thực thi bằng tool.

---

## 1. Vấn đề giải quyết

Trong Claude Code (v2.1.295), khi người dùng đặt `/goal`, hệ thống sử dụng một evaluator model riêng đọc transcript và trả về `{ok, reason, impossible?}`:
- **Lỗ hổng**: Evaluator chỉ đọc văn bản và dễ bị nhầm lẫn giữa việc *sửa báo cáo* (rút finding, ghi PASS audit) với việc *sửa code thật sự*.
- **Hệ quả**: Ngay khi evaluator trả về `ok: true`, Claude Code lập tức gỡ hook và ghi nhận `goal_status.met: true`.
- **Giải pháp**: `llm-switcher` chặn phản hồi của evaluator trước khi gửi về client, đồng thời gọi mô hình quyết định **Jev (System One typed decision API)** trên 3 trục độc lập:
  1. `complete`: Toàn bộ công việc theo condition đã hoàn thành thực sự (ngưỡng mặc định: $\ge 0.90$).
  2. `evidence`: Có tool-result trực tiếp chứng minh kết quả thực thi (ngưỡng mặc định: $\ge 0.85$).
  3. `unfinished`: Còn công việc dang dở, lỗi chưa xử lý hoặc verification thiếu (ngưỡng mặc định: $\le 0.10$).

---

## 2. Nguyên tắc hoạt động & Quyết định hợp nhất

Gateway chỉ trả về `ok: true` khi **cả hai bên đồng thuận**:
- Evaluator gốc của Claude Code trả về `ok: true`.
- Jev xác nhận cả 3 điểm số đều đạt ngưỡng cấu hình và evidence không vượt kích thước tối đa.

| Native Evaluator | Jev / Evidence Checks | Trả về Claude Code | Ghi chú |
| :--- | :--- | :--- | :--- |
| `ok: false` | Bất kỳ | `ok: false` | Giữ nguyên lý do gốc của native |
| `ok: true` | Đạt cả 3 ngưỡng | `ok: true` | Cho phép hoàn thành lượt |
| `ok: true` | Một trong 3 trục không đạt | `ok: false` | Veto: Nêu rõ trục vi phạm (ví dụ `complete=0.14 < 0.90`) và yêu cầu cung cấp tool evidence |
| `ok: true` | Lỗi mạng / HTTP 5xx / timeout / thiếu key | `ok: false` | Fail-closed: Báo `Goal Check verification unavailable` |
| `ok: true` | State vượt quá `maxStateChars` | `ok: false` | Báo `Insufficient evidence` (state quá lớn) |
| `impossible: true` | Bất kỳ | `ok: false, impossible: true` | Giữ nguyên ngữ nghĩa thất bại của native |

> **Fail-closed**: Lỗi mạng, thiếu dữ liệu hoặc lỗi cấu hình Jev **không bao giờ** biến thành phán quyết hoàn thành.

---

## 3. Cấu hình qua Dashboard

Truy cập `# /goal-check` từ menu bên trái:

1. **Enable Goal Check**: Toggle bật/tắt (Mặc định: **OFF**).
2. **Model Provider Source**: Chọn profile có sẵn (như `intact-claude`) để kế thừa Base URL và API key, hoặc chọn *Custom Endpoint*.
3. **Base URL**: URL nhà cung cấp Jev (ví dụ: `https://intact.louispham.qzz.io/v1`).
4. **API Key**: Khóa truy cập (được che dạng masked khi hiển thị).
5. **Goal Check Model**: Model ID quyết định (mặc định: `typesafe/jev-latest`).
6. **Test Connection**: Probe thử nghiệm gửi payload quyết định mẫu nhỏ để xác minh kết nối và schema trả về.
7. **Save Configuration**: Lưu cấu hình an toàn vào `config.json`.

### Tùy chọn nâng cao (Advanced)
- **Decision Endpoint Override**: Cho phép ghi đè đường dẫn đầy đủ tới API quyết định (mặc định: `<Base URL>/systemone`).
- **Complete Score Threshold (`completeMin`)**: Ngưỡng hoàn thành tối thiểu (mặc định: 0.90).
- **Evidence Score Threshold (`evidenceMin`)**: Ngưỡng bằng chứng thực thi tối thiểu (mặc định: 0.85).
- **Unfinished Score Max (`unfinishedMax`)**: Trần công việc dang dở tối đa (mặc định: 0.10).
- **Timeout (`timeoutMs`)**: Thời gian chờ cuộc gọi Jev (mặc định: 8000 ms).
- **Total Gate Deadline (`totalTimeoutMs`)**: Tổng hạn ngạch thời gian của cổng (mặc định: 25000 ms).
- **Max State Evidence Budget (`maxStateChars`)**: Giới hạn ký tự transcript gửi Jev (mặc định: 60000 ký tự).

---

## 4. API Endpoints

Tất cả endpoint yêu cầu header `x-llm-switcher-token` (hoặc admin cookie):
- `GET /api/goal-check`: Lấy cấu hình (đã mask key) và trạng thái kết nối.
- `POST /api/goal-check`: Cập nhật cấu hình, lưu vào `config.json`.
- `POST /api/goal-check/test`: Thử nghiệm kết nối tới Jev endpoint.
- `GET /api/goal-check/logs`: Lấy danh sách ring buffer các lượt kiểm tra gần nhất.

---

## 5. Phạm vi & Giới hạn

- **Phạm vi bảo vệ**: Áp dụng cho các prompt stop-condition hook của Claude Code (bao gồm `/goal`).
- **Không áp dụng**: Request chat thông thường, Idle Compaction, Codex CLI, TaskUpdate/TaskCompleted.
- **Giới hạn mô hình**: Jev là mô hình quyết định dựa trên văn bản; không tự chạy lệnh, đọc file hay xem ảnh chụp màn hình trực tiếp. Nếu task đòi hỏi bằng chứng thị giác mà không có biểu diễn text tương đương, gate sẽ đánh giá là thiếu bằng chứng.
