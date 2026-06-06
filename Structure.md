# Cấu trúc dự án — HUST Student Assistant (Backend)

## Tổng quan

Backend Node.js/Express cho ứng dụng trợ lý sinh viên HUST. Cung cấp API cho:
- Xác thực người dùng (JWT + OAuth Google/Microsoft)
- Đồng bộ email Gmail
- Scrape tin tức/kế hoạch từ CTT HUST
- Chat với AI (Gemini) kèm tool use (tạo task, đọc file đính kèm)
- Quản lý task, tag, file đính kèm

---

## Cây thư mục

```
Project/
├── docker-compose.yml          # PostgreSQL + pgAdmin + server
├── tutorial.md                 # Hướng dẫn cài đặt & chạy
├── Structure.md                # Tài liệu cấu trúc dự án (file này)
│
├── database/
│   ├── init_schema.sql         # Khởi tạo schema PostgreSQL
│   └── migrations/             # Migration bổ sung (v2...)
│
├── uploads/                    # File đính kèm lưu trên disk
│   ├── AI_CHAT/                # File do user upload trong AI chat
│   ├── EMAIL/                  # File đính kèm từ email Gmail
│   └── NEWS/                   # File đính kèm từ bài viết CTT
│
└── server/
    ├── Dockerfile
    ├── package.json
    ├── .env.example            # Template biến môi trường
    └── src/
        ├── app.js              # Entry point — khởi tạo Express, mount routes
        │
        ├── config/             # Cấu hình kết nối & bảo mật
        │   ├── db.js           # PostgreSQL connection pool
        │   ├── passport.js     # OAuth strategies (Google, Microsoft)
        │   ├── crypto.js       # Mã hóa/giải mã token OAuth
        │   └── linkCodeStore.js # Bộ nhớ tạm cho link code OAuth
        │
        ├── middleware/
        │   ├── authMiddleware.js   # Xác minh JWT, gắn req.user
        │   └── lastWriteWins.js    # Giải quyết xung đột sync
        │
        ├── routes/             # Định nghĩa API endpoints
        │   ├── auth.js         # Đăng nhập / đăng ký / đăng xuất
        │   ├── accounts.js     # Liên kết tài khoản OAuth
        │   ├── ai.js           # AI chat (standalone, email, news)
        │   ├── attachments.js  # Download file đính kèm
        │   ├── emails.js       # Danh sách & chi tiết email
        │   ├── news.js         # Danh sách tin tức & kế hoạch
        │   ├── sync.js         # Trigger đồng bộ dữ liệu
        │   ├── tags.js         # CRUD tag người dùng
        │   ├── tasks.js        # CRUD task (todo/lịch học/thi)
        │   └── userInfo.js     # Thông tin cá nhân sinh viên
        │
        └── services/           # Business logic
            ├── aiService.js            # Gọi Gemini API + vòng lặp tool use
            ├── aiTools.js              # Khai báo & thực thi AI tools
            ├── attachmentService.js    # Lưu trữ & phân quyền file đính kèm
            ├── attachmentTextService.js # Trích xuất text từ file (PDF, DOCX...)
            ├── gmailService.js         # Gmail API client
            ├── emailSyncService.js     # Vòng lặp poll & đồng bộ email
            ├── newsScrapeService.js    # Scrape bài viết từ CTT HUST
            ├── newsScrapeScheduler.js  # Lịch chạy tự động scraper
            └── newsRecommendationService.js # Lọc & cache tin tức gợi ý
```

---

## Database Schema

### Enums

| Enum | Giá trị |
|------|---------|
| `provider_type` | `GMAIL`, `OUTLOOK`, `CTT` |
| `task_category` | `TODO`, `CLASS`, `EXAM` |
| `source_origin` | `MANUAL`, `EMAIL`, `NEWS`, `CTT` |
| `account_status` | `ACTIVE`, `EXPIRED`, `REVOKED` |
| `attachment_owner` | `NEWS`, `EMAIL`, `AI_CHAT` |

### Các bảng chính

| Bảng | Mục đích | Soft-delete |
|------|---------|-------------|
| `users` | Tài khoản người dùng (email + hash mật khẩu) | `is_deleted` |
| `user_info` | Thông tin sinh viên (MSSV, tên, ngành, lớp, khóa) | — |
| `accounts` | Credentials OAuth (Google/Microsoft) | `status` enum |
| `user_account_cross_ref` | Liên kết nhiều-nhiều users ↔ accounts | — |
| `emails` | Email Gmail đã đồng bộ | `is_deleted` |
| `news` | Bài viết / kế hoạch từ CTT HUST | `is_deleted` |
| `news_sources` | Nguồn tin (seeded: CTT HUST) | `is_deleted` |
| `news_recommendations` | Cache gợi ý tin tức theo user (TTL 6h) | `is_dismissed` |
| `attachments` | Metadata file đính kèm (NEWS/EMAIL/AI_CHAT) | `is_deleted` |
| `tasks` | Task của người dùng (todo/lịch học/thi) | `is_deleted` |
| `tags` | Tag màu do user tự tạo | `is_deleted` |
| `task_tag_cross_ref` | Liên kết nhiều-nhiều tasks ↔ tags | `is_deleted` |

**Lưu ý thiết kế:**
- Tất cả bảng dùng UUID làm primary key.
- Timestamps dùng `TIMESTAMPTZ`, múi giờ mặc định `+07:00` (Việt Nam).
- Soft-delete qua `is_deleted` thay vì xóa thật. Trigger cascade: khi email/news/user bị soft-delete thì `attachments` liên quan cũng bị soft-delete.

---

## API Endpoints

### Auth — `/api/auth`

| Method | Path | Mô tả |
|--------|------|-------|
| POST | `/register` | Đăng ký tài khoản mới |
| POST | `/login` | Đăng nhập, nhận JWT |
| POST | `/logout` | Đăng xuất |
| GET | `/me` | Thông tin user đang đăng nhập |

### Accounts — `/api/accounts`

| Method | Path | Mô tả |
|--------|------|-------|
| GET | `/link/google` | Bắt đầu OAuth flow liên kết Gmail |
| GET | `/link/microsoft` | Bắt đầu OAuth flow liên kết Outlook |
| GET | `/` | Danh sách tài khoản đã liên kết |
| DELETE | `/:accountId` | Hủy liên kết tài khoản |

### AI Chat — `/api/ai`

| Method | Path | Mô tả |
|--------|------|-------|
| POST | `/upload-attachment` | Upload file cho AI chat (tối đa 25 MB) |
| POST | `/chat` | Chat AI tổng quát (có thể đính kèm file) |
| POST | `/email-chat` | Chat AI với ngữ cảnh thread email |
| POST | `/news-chat` | Chat AI với ngữ cảnh bài viết |

### Emails — `/api/emails`

| Method | Path | Mô tả |
|--------|------|-------|
| GET | `/` | Danh sách email (phân trang) |
| GET | `/:emailId` | Chi tiết email + attachments |

### News — `/api/news`

| Method | Path | Mô tả |
|--------|------|-------|
| GET | `/` | Danh sách tin tức/kế hoạch gợi ý |
| GET | `/:newsId` | Chi tiết bài viết |

### Tasks — `/api/tasks`

| Method | Path | Mô tả |
|--------|------|-------|
| GET | `/` | Danh sách task của user |
| POST | `/` | Tạo task mới |
| PUT | `/:taskId` | Cập nhật task |
| DELETE | `/:taskId` | Xóa task |

### Tags — `/api/tags`

| Method | Path | Mô tả |
|--------|------|-------|
| GET | `/` | Danh sách tag |
| POST | `/` | Tạo tag mới |
| PUT | `/:tagId` | Cập nhật tag |
| DELETE | `/:tagId` | Xóa tag |

### Attachments — `/api/attachments`

| Method | Path | Mô tả |
|--------|------|-------|
| GET | `/:attachmentId` | Download file (kiểm tra quyền truy cập) |

### Sync — `/api/sync`

| Method | Path | Mô tả |
|--------|------|-------|
| POST | `/emails` | Trigger đồng bộ email ngay lập tức |

### User Info — `/api/user-info`

| Method | Path | Mô tả |
|--------|------|-------|
| GET | `/` | Lấy thông tin sinh viên |
| PUT | `/` | Cập nhật thông tin sinh viên |

---

## Services

### `aiService.js` — Gemini API Client

Gọi Gemini API với vòng lặp tool use (tối đa 5 vòng):

```
chat({ messages, systemInstruction, tools, toolExecutor })
  → { reply, usage, toolCalls }
```

Các hàm build system instruction:
- `buildAttachmentsSystemNote(attachments)` — Danh sách file có thể đọc
- `buildEmailSystemInstruction(thread, attachments)` — Ngữ cảnh thread email
- `buildNewsSystemInstruction(news, attachments)` — Ngữ cảnh bài viết

### `aiTools.js` — AI Tool Declarations & Executors

**Công cụ AI có thể gọi:**

| Tool | Mô tả |
|------|-------|
| `create_task` | Tạo một task đơn lẻ (todo/lịch học/thi) |
| `create_weekly_tasks` | Tạo task lặp lại hàng tuần (lịch học theo kỳ) |
| `read_attachment` | Đọc nội dung text của file đính kèm |

`makeTaskToolExecutor({ userId, sourceType, sourceId, allowedAttachmentIds })` — Factory trả về hàm thực thi tool, kiểm soát quyền truy cập file.

### `attachmentService.js` — Quản lý File Đính Kèm

Phân quyền truy cập theo loại:
- **NEWS**: Mọi user đều đọc được
- **EMAIL**: Chỉ user có tài khoản Gmail liên kết với email đó
- **AI_CHAT**: Chỉ user đã upload file

Hàm chính: `saveAiChatUpload`, `saveBuffer`, `downloadAndSave`, `getAttachmentForUser`, `listForOwner`.

### `attachmentTextService.js` — Trích Xuất Text

Hỗ trợ: PDF, DOCX, XLSX/XLS, CSV, HTML, TXT, MD, JSON, XML, LOG.

4 lớp tìm kiếm file theo tên (AI hay đặt tên sai):
1. Khớp chính xác
2. Chuẩn hóa Unicode (NFC)
3. Không phân biệt hoa/thường
4. Xóa ký tự đặc biệt (fuzzy)

Cắt ngắn text > 60K ký tự: giữ 40K đầu + 20K cuối.

### `gmailService.js` — Gmail API Client

- `listMessageIds(accessToken, sinceDate)` — Lấy danh sách ID email gần đây
- `getFullMessage(accessToken, messageId)` — Lấy nội dung đầy đủ (headers, body, attachments)
- Giải mã Base64URL, trích xuất MIME multipart

### `emailSyncService.js` — Email Polling

Poll Gmail định kỳ theo `POLL_INTERVAL_MS` (mặc định 5 phút). Tự động refresh access token khi hết hạn.

### `newsScrapeService.js` + `newsScrapeScheduler.js`

Scrape bài viết từ website CTT HUST bằng `cheerio`. Chạy định kỳ theo `NEWS_SCRAPE_INTERVAL_MS` (mặc định 1 giờ).

### `newsRecommendationService.js`

Lọc và cache tin tức phù hợp với từng user dựa trên `user_info` (ngành, khóa...). Cache 6 giờ, tự làm mới khi user cập nhật thông tin.

---

## Cấu hình môi trường (`.env`)

| Nhóm | Biến | Mô tả |
|------|------|-------|
| Server | `PORT`, `NODE_ENV` | Cổng và môi trường |
| Database | `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | Kết nối PostgreSQL |
| OAuth Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL` | OAuth |
| OAuth Microsoft | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_CALLBACK_URL` | OAuth |
| Bảo mật | `JWT_SECRET`, `SESSION_SECRET`, `ENCRYPTION_KEY` | Mã hóa |
| AI | `GEMINI_API_KEY`, `GEMINI_MODEL` | Gemini API |
| Email polling | `ENABLE_EMAIL_POLLING`, `POLL_INTERVAL_MS` | Đồng bộ email |
| News scraper | `NEWS_SCRAPE_ENABLED`, `NEWS_SCRAPE_INTERVAL_MS`, `NEWS_SCRAPE_LIMIT` | Scrape tin tức |
| Uploads | `UPLOAD_DIR`, `MAX_UPLOAD_BYTES` | Thư mục & giới hạn file |
| CORS | `FRONTEND_URL` | Origin frontend được phép |

---

## Chạy với Docker

```bash
# Khởi động PostgreSQL + pgAdmin + server
docker compose up -d

# Xem log server
docker compose logs -f server
```

- PostgreSQL: `localhost:5432`
- pgAdmin: `http://localhost:8080`
- API Server: `http://localhost:3000`

## Chạy locally

```bash
cd server
cp .env.example .env   # Điền các biến môi trường
npm install
npm run dev            # Chạy với --watch (hot reload)
```

---

## Stack công nghệ

| Layer | Công nghệ |
|-------|-----------|
| Runtime | Node.js >= 24 |
| Framework | Express 4 |
| Database | PostgreSQL 15 |
| Auth | Passport.js, JWT, OAuth2 |
| AI | Google Gemini API |
| File parsing | pdf-parse, mammoth, xlsx |
| HTML scraping | cheerio |
| Container | Docker + Docker Compose |
