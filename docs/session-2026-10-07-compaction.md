# Báo cáo phiên làm việc — 2026-10-07

> Bản ghi của một phiên làm việc, để đọc lại được về sau. Nó nói cả những gì đã kiểm chứng và
> những gì **chưa**, và các mục trong bảng mục lục là các phần.

Một phiên làm việc trên hai repo: **llm-switcher** (gateway ở phía client) và **intact** (gateway
ở phía provider). Chủ đề xuyên suốt: **một hội thoại dài đáng tiền khi cache đã mất, và cách làm nó
rẻ đi mà không phá client nào.**

Trang này là bản ghi của những gì đã kiểm chứng, những gì đo được, và những gì **chưa** chứng
minh được. Phần cuối là danh sách việc dở — có một mục đã biết là chưa xong và nói rõ ở đó.

---

## 1. Kết quả, theo thứ tự đã giao

### intact — `5dddbbe`, `ba19457` · deploy `intact`, `intact-af`, `intact-ops`

**a. 429 → retry với context đã rút gọn.**

Giới hạn của provider tính theo token/phút, nên account kế tiếp gặp đúng cuộc hội thoại đó trước
cùng bức tường. Tệ hơn: account kế tiếp **không có cache** cho prefix này, vì nó chưa từng thấy lượt
trả lời đầu — lịch sử dài tốn tiền đầy đủ và không đổi lấy gì.

Đo trên một hội thoại agent 32 KB: retry đi ra **10 KB, bớt 68%**.

Hai cổng, và không có gì ngoài chúng:

| Cổng | Vì sao |
|---|---|
| Provider ở chế độ round-robin **và** còn account sẵn sàng | Provider ghim một account thì không có chỗ nào nhận bản rút gọn; rút gọn chỉ là vứt lịch sử đi. Một account standby không tính là sẵn sàng — nó là phương án cuối. |
| **429 thật** | `500` cũng được retry nhưng rút gọn không giúp: provider **hỏng**, không phải **đầy**. |

**b. Codex compaction — trả đúng 1 `compaction` item.**

Codex 0.160 gửi một `compaction_trigger` và chỉ nhận đúng một output item loại `compaction`. Provider
trả lời như một completion thường thì cho 0 item, và Codex coi đó là lỗi chết **trước khi** nó thay
lịch sử — thread giữ nguyên độ dài, mọi lần `resume` lại compact và chết y hệt. Tính năng báo
`removed`, không tắt được.

Kiểm chứng trên provider codex thật: **HTTP 200, đúng 1 compaction item**, cả stream lẫn non-stream.

Ba điều không dễ thấy:
- Mang theo setting của client. Responses của OpenAI từ chối request không có `store:false`, và từ
  chối không có `stream:true` — nó sẽ từ chối đúng những account đang phục vụ mọi turn khác.
- Account chỉ nói dạng stream thì một lần retry bật flag.
- **Không bao giờ lưu summary rỗng.** Provider trả tool call sẽ nhận lỗi, vì summary rỗng thay cả
  lịch sử bằng hư không.

**c. Cổng xác thực nhận client chính thức của provider.**

Codex nói chuyện với ChatGPT bằng credential của ChatGPT. Trỏ sang intact thì nó vẫn gửi credential
đó, mà intact không kiểm được — intact chỉ biết key mình phát. Request mà intact sinh ra để phục
vụ bị chặn ngay cửa.

Miễn trừ hẹp **hai chiều**: chỉ route proxy `/v1/*`, không phải `/api/*` (nếu không, một
User-Agent bịa sẽ mở usage, quota, error log, drift); và chỉ đúng provider khai báo tiền tố — client
codex hỏi model claude thì **403**. Principal đó không có key, không admin, không model nào riêng;
credential lấy từ kho intact đã lưu, không lấy từ caller.

Hai lỗi test bắt được: `codex_cli_rs/` là của **TUI tương tác**, còn `codex exec` gửi
`codex_exec/` — nên `BifrostUA` phải nhận nhiều tiền tố. Và một test đang **đòi từ chối** chính Claude
Code thật — cái sai là test.

### llm-switcher — `281f180` → `4423205`, 1.5.0 → 1.6.0

**a. Nén hội thoại khi idle quá lâu (Claude Code).**

Hội thoại để lâu thì mất cache. Thời gian giữ cache là việc riêng của từng provider:

| Provider | Thời hạn |
|---|---|
| Anthropic | 5 phút mặc định, 1 giờ nếu request yêu cầu (`cache_control.ttl`) |
| OpenAI | `prompt_cache_options.ttl` chỉ có `"30m"`; model cũ dùng `prompt_cache_retention`, `in_memory` ~5–10 phút |
| Gemini | implicit caching không công bố thời hạn; explicit mặc định 1 giờ |
| DeepSeek | tự động trên đĩa, không công bố thời hạn |

Nên thời gian là **setting**, mặc định 15 phút.

Hai quyết định:

- **Nén một lần, không nén mọi lượt.** Đổi prefix mỗi lượt nghĩa là không lượt nào trúng cache,
  và hội thoại bị tóm tắt đi đi lại.
- **Ghi vào session file, không qua API.** Claude Code dựng mọi request từ chuỗi entry trong
  `~/.claude/projects/<project>/<session>.jsonl`, nên một lần nén ghi vào đó rút gọn **mọi** request
  sau, không chỉ lượt kích hoạt.

Entry ghi ra đúng hai loại Claude Code tự ghi: `compact_boundary` và một entry `user` mang
`isCompactSummary`. Entry cũ **vẫn còn** trong file — Claude Code cũng vậy sau khi nén 949k token —
vì một transcript người ta vẫn đọc được đáng giá hơn một file nhỏ.

**Kiểm chứng trên Claude Code thật:** 12 turn giả (~200 KB) + một boundary → `claude --resume` gửi
**4 message, 80.567 byte** thay vì 13; có marker summary; **0** còn 4000 ký tự filler.

**b. Dashboard.** Card trên trang Routes, đọc/ghi `/api/idle-compact` — **cùng key với `switch
compact`**, nên trang và terminal không thể lệch nhau.

**c. Nén cho Codex (1.6.0).** Xem mục 4.

---

## 2. Cách kiểm chứng

| Cách | Kết quả |
|---|---|
| Test end-to-end có 429 thật, store thật, account thật | retry 32.532 → 10.473 byte |
| Test Claude Code thật, đọc request nó gửi | 4 message, không còn turn cũ |
| Gọi thẳng intact với `compaction_trigger`, provider codex thật | đúng 1 compaction item |
| Cổng xác thực, 5 hành vi trên bản đang chạy | key thật 200 · UA lạ 401 · UA codex 200 · `/api/*` 401 · codex→claude 403 |
| **Claude Code thật qua gateway đang chạy** | `idle compact h:bbd52533-4 [p1]: 9681 -> 3832 bytes` · `summary stored` · session file có `compact_boundary` + `isCompactSummary` · `compactMetadata` preTokens 2420 → postTokens 958 |
| Suite | llm-switcher 704 pass · intact toàn bộ xanh · zencore 301 pass |

---

## 3. Những điều đoán sai rồi đính chính

Ghi lại vì chúng là phần tốn thời gian nhất và có thể sai lại.

1. **"Không có cách nào báo cho tool biết phải compact."** Sai. llm-switcher ngồi ở phía client, có
   filesystem. Tôi đã nghĩ trong khuôn protocol rồi kết luận là không thể.
2. **"Sao 1.4.0 chưa tải được?"** Đúng là registry-side propagation, không phải publish hỏng.
3. **Remote compaction của Codex gắn với auth mode.** Sai: nó compact cục bộ cả khi auth là
   ChatGPT và endpoint trỏ về intact. Nó gắn với **endpoint có phải backend ChatGPT thật không**.
4. **Ghi vào file jsonl của Codex là đủ.** Sai: SQLite mới là nơi Codex đọc.
5. **Viết hai nửa vào store là xong.** Sai: còn phải đẩy projection.

---

## 4. Cơ chế compaction của Codex — đã tìm ra đủ

Một compaction của Codex là **ba ghi phải khớp nhau**, đọc từ một thread thật đã compact 7 lần:

1. **rollout jsonl**: entry `{type:"compacted", payload:{message, replacement_history, …}}` — mang
   nội dung tóm tắt.
2. **`thread_history_1.sqlite` → `thread_items`**: hàng `item_type='contextCompaction'`, mà
   `item_json` chỉ có `{"type":"contextCompaction","id":…}` — **chỉ là mốc, không có chữ summary**.
3. **`thread_history_projection_state`**: `next_rollout_byte_offset` và `next_rollout_ordinal`.

Mảnh thứ ba là cái dễ bỏ, và bỏ nó thì **trông y hệt thành công**. Bảng đó ghi store đã đọc tới đâu
trong file: `next_rollout_byte_offset` **bằng đúng kích thước file** (đã đo: 3.722.618 byte =
`os.path.getsize`), `next_rollout_ordinal` là ordinal sau entry cuối. **File là bản ghi, store là
projection của nó.** Ghi thêm vào file mà không đẩy projection thì entry đó không bao giờ được đọc.

Kiểm chứng: cài một compaction chứa `CON_VIET_4711` vào thread Codex thật → `resume` → Codex trả
đúng `CON_VIET_4711`. Qua gateway: `contextCompaction 1` trong store, projection đã đẩy, log ghi
`summary stored`.

Ba lỗi chỉ chạy mới thấy:
- Ordinal lấy từ **projection**, không phải `MAX(rollout_ordinal)` — hai số khác nhau.
- Hàng marker cần `started_at_ms` và `completed_at_ms`; hàng của Codex có, để NULL thì không đọc được.
- Hội thoại **không có message người dùng** thì không có conversation key → không làm gì, trông
  như tính năng tắt chứ không phải input sai.

---

## 5. Bốn quy tắc đã đặt, và trạng thái

| Quy tắc | Trạng thái |
|---|---|
| Chỉ dùng intact và llm-switcher, không đụng config Codex | **OK** — `~/.codex` không có file config nào; mọi test Codex chạy trong sandbox `CODEX_HOME` riêng |
| Không tốn token account chính thức | **OK, sau khi sửa** — xem dưới |
| 429 → compact | **OK** — intact, 4 test e2e |
| Hết TTL cache → tự compact | **OK** — llm-switcher, test Claude Code thật |

**Quy tắc 2 đã bị vi phạm và đã sửa.** Khi không đặt model summary, code gọi model của chính thread —
với Codex đó là `gpt-5.6-sol` trên tài khoản ChatGPT chính thức, đúng thứ bị cấm. Tệ hơn: lượt
summary chỉ dùng để ghi session file, nên không có gì để lưu — gọi model chỉ tốn tiền mà không đổi
lấy gì. Nay **không gọi model nào trừ khi có đặt**; phần tiết kiệm không đổi vì request vẫn ra
ngắn.

---

## 6. Lỗi của tôi trong phiên này

- **Giết nhầm zencore.** Chọn port 8793 cho công cụ thử mà không kiểm tra port đó đã có dịch vụ
  chạy. Đã khởi động lại và xác nhận khỏe, nhưng đó là lỗi của tôi.
- **Trộn hai kiểu dữ liệu.** Đưa shape của IR vào body Messages, khiến body ra upstream sai định
  dạng. Chỉ thấy khi đọc body thật ra ngoài.
- **Ghi session file bằng rename.** Sẽ mất entry: Claude Code giữ file mở, append tiếp vào inode cũ.
- **Bỏ qua kiểm tra ngược.** Viết xong rồi chỉ chạy test, không đọc lại code sạch sau những lần sửa.

---

## 7. Việc dở

**Không còn mục nào trong bốn quy tắc.**

Đã đóng trong phiên: validate Claude Code qua gateway thật. Còn ba lỗi của *công cụ thử*, không
phải của tính năng — model thử không tồn tại ở intact; sandbox đặt `CLAUDE_CONFIG_DIR` chỉ cho
Claude Code nên gateway tìm nhầm `~/.claude` thật; và hàm thử dọn đồ trước khi lượt summary xong.
Cả ba đã sửa và chạy lại thành công.

Còn một việc **không tự làm được**, vì nó nằm trên tài khoản của bạn: thu hồi token npm trong
`/opt/hermes/.npmrc`. `id_token` OpenAI từng dán trong chat đã hết hạn từ lâu, không cần làm gì.

Còn một điều **không xong**: Codex **không** dùng compaction của provider. `remote_compaction_v2` chỉ
chạy khi Codex nói chuyện với backend ChatGPT thật; `CHATGPT_BASE_URL` bị bỏ qua, và các khoá tắt
WebSocket không ăn. Để đi hết đường đó phải chặn TLS (`HTTPS_PROXY` + `SSL_CERT_FILE`), mà tôi
không tự làm vì nó đổi niềm tin TLS của máy.

Hệ quả đã ghi rõ trong tài liệu: cờ `idleCompact.codex` tắt mặc định, tiết kiệm đúng **một lượt**,
và không có lời hứa nào rằng thread sẽ giữ ngắn.

---

## 8. Bàn giao

| | |
|---|---|
| llm-switcher | `4423205`, 1.6.0, `main` |
| intact | `ba19457`, `master` |
| zencore | không đổi |
| Service | `intact`, `intact-af`, `intact-ops`, `zencore` — đều `active` |
| Gateway | llm-switcher, Claude Code → `claude-intact` |
| Tính năng | `switch compact` — **tắt** |

```
switch compact on                                              # Claude Code
switch compact on && switch compact model infron/deepseek/deepseek-v4-flash:free
switch compact idle 30                                         # phút
switch compact min 128                                         # KB
```

**Còn nợ bạn:** token npm và `id_token` từng dán trong chat — hai thứ đều nên thu hồi.