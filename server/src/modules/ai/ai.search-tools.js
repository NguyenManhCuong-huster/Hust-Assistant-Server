// server/src/services/aiSearchTools.js
//
// AI search tools — MỚI 2026-06.
//
// Thêm 5 tool để AI tự suy luận khi user hỏi chung chung (vd "có email gì
// mới từ thầy", "tin tức học bổng tuần này", "định nghĩa thuật ngữ X"):
//
//   1. search_emails(query?, from_date?, to_date?, limit?)
//        - Tìm email CỦA CHÍNH user đang chat (scope qua user_account_cross_ref).
//        - Trả tóm tắt (sender, subject, snippet, ...).
//        - query optional → bỏ qua = lấy email mới nhất không lọc.
//
//   2. get_email(email_id, include_thread?)
//        - Drill-down 1 email → trả body đầy đủ (hoặc cả thread nếu request).
//        - Body cắt nếu quá dài (cap EMAIL_BODY_MAX_CHARS, kèm cờ truncated).
//
//   3. search_news(query?, kind?, limit?)
//        - Tìm news/plan (public, không scope theo user).
//        - kind = NEWS | PLAN | unset(cả 2).
//
//   4. get_news(news_id)
//        - Drill-down 1 bài news → trả summary đầy đủ + attachments metadata.
//
//   5. web_search(query, num?)
//        - Tìm web qua Tavily Search API (https://tavily.com).
//        - Yêu cầu ENV TAVILY_API_KEY (1 key duy nhất, không cần CSE id).
//        - Nếu thiếu env → trả error có hướng dẫn (không crash).
//        - Tại sao Tavily mà không phải Google Custom Search:
//          Google đã đóng Custom Search JSON API cho user mới
//          (sunset 2027-01-01). Tavily build chuyên cho LLM, response
//          đã extract content sạch sẵn, free 1,000 query/tháng,
//          không cần credit card. Đổi provider chỉ cần đổi 1 hàm
//          ở file này — không ảnh hưởng phần còn lại của codebase.
//
// Pattern thiết kế:
//   - Tách 2 tầng `search_*` (list, snippet ngắn) + `get_*` (drill-down full).
//     Giúp model "đoán" trước rồi mới fetch chi tiết → tiết kiệm token.
//   - Tham số optional ở mức tối đa (query có thể bỏ qua) để model linh hoạt.
//   - Sort luôn theo ngày giảm dần — câu hỏi vague mặc định ưu tiên dữ liệu mới.
//   - Bảo vệ tài nguyên: cap limit, cap body length, cap snippet length.
//
// Wiring:
//   - aiTools.js import SEARCH_TOOL_DECLARATIONS và dispatchSearchTool.
//   - makeTaskToolExecutor() trong aiTools.js delegate tới dispatchSearchTool
//     nếu tên tool match.

import { query } from '../../shared/database/db.js';

// ─────────────────────────────────────────────────────────────
// Limits & helpers
// ─────────────────────────────────────────────────────────────
const MAX_SEARCH_RESULTS   = 30;
const DEFAULT_SEARCH_LIMIT = 10;
const SNIPPET_MAX_CHARS    = 220;        // tóm tắt mỗi item trong search list
const NEWS_PREVIEW_CHARS   = 320;        // tóm tắt summary news ở search list
const EMAIL_BODY_MAX_CHARS = 10_000;     // body 1 email khi get_email
const NEWS_BODY_MAX_CHARS  = 12_000;     // body 1 news khi get_news
const WEB_SNIPPET_CHARS    = 400;        // tóm tắt mỗi item từ web_search (Tavily content thường dài hơn Google snippet)

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const safeLimit = (raw, def = DEFAULT_SEARCH_LIMIT, max = MAX_SEARCH_RESULTS) => {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(n, max);
};

/** Compact 1 dòng + cắt đuôi nếu quá dài. */
const truncatePreview = (s, n = SNIPPET_MAX_CHARS) => {
  if (!s) return '';
  const t = String(s).trim().replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Cắt body giữ đầu, kèm marker. */
const truncateBody = (s, n) => {
  if (!s) return '';
  if (s.length <= n) return s;
  return `${s.slice(0, n)}\n\n[...nội dung bị cắt vì quá dài, gọi tool khác nếu cần phần sau...]`;
};

const isUuid = (s) => typeof s === 'string' && UUID_REGEX.test(s.trim());

// ═════════════════════════════════════════════════════════════
// TOOL DECLARATIONS — passed to Gemini functionDeclarations
// ═════════════════════════════════════════════════════════════

const searchEmailsDeclaration = {
  name: 'search_emails',
  description:
    'Tìm trong email của user đang chat (CHỈ email của họ, không phải toàn hệ thống). ' +
    'Trả về danh sách email khớp với từ khóa, sắp xếp theo ngày nhận giảm dần.\n\n' +
    'KHI NÀO GỌI:\n' +
    '  - User hỏi về email gần đây / email từ ai đó / có email nào về chủ đề X.\n' +
    '  - Ví dụ: "thầy nào vừa gửi email cho tôi", "có thông báo gì từ phòng đào tạo ' +
    'không", "email tuần trước về lịch thi nói gì".\n\n' +
    'KHÔNG GỌI nếu user đang chat với context EMAIL CỤ THỂ và họ chỉ hỏi về CHÍNH ' +
    'email đó (nội dung email đã có sẵn trong system instruction).\n\n' +
    'Tool chỉ trả TÓM TẮT (sender, subject, snippet ngắn). Nếu cần body đầy đủ ' +
    'của 1 email cụ thể → gọi tiếp `get_email` với `email_id` từ kết quả.\n\n' +
    'Có thể gọi KHÔNG có `query` (sẽ trả email mới nhất không lọc). ' +
    'Có thể giới hạn theo `from_date` / `to_date` (ISO date YYYY-MM-DD hoặc datetime).',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Từ khóa tìm trong sender / subject / snippet / body_text (case-insensitive, ' +
          'substring match). OPTIONAL — bỏ qua để lấy email mới nhất.',
      },
      from_date: {
        type: 'string',
        description:
          'Chỉ trả email nhận TỪ ngày này trở đi (ISO format, vd "2025-06-01" hoặc ' +
          '"2025-06-01T00:00:00+07:00"). Optional.',
      },
      to_date: {
        type: 'string',
        description: 'Chỉ trả email nhận ĐẾN ngày này (inclusive, ISO format). Optional.',
      },
      limit: {
        type: 'integer',
        description: 'Số kết quả tối đa, 1-30. Default 10.',
      },
    },
  },
};

const getEmailDeclaration = {
  name: 'get_email',
  description:
    'Lấy nội dung ĐẦY ĐỦ của 1 email (sender, recipient, subject, body, attachments).\n\n' +
    'Dùng SAU KHI `search_emails` đã trả kết quả và bạn cần đọc chi tiết 1 email cụ ' +
    'thể để trả lời user.\n\n' +
    'CHỈ gọi với `email_id` đã thấy trong kết quả `search_emails` trước đó — KHÔNG ' +
    'bịa UUID.\n\n' +
    'Đặt `include_thread=true` nếu muốn xem CẢ thread (chuỗi email reply qua lại). ' +
    'Mặc định chỉ trả email anchor. Body có thể bị cắt nếu quá dài (sẽ kèm cờ ' +
    '`truncated`).',
  parameters: {
    type: 'object',
    properties: {
      email_id: {
        type: 'string',
        description: 'UUID email, copy NGUYÊN VĂN từ kết quả search_emails.',
      },
      include_thread: {
        type: 'boolean',
        description:
          'True = trả về CẢ thread (tất cả message cùng gmail_thread_id). ' +
          'Default false (chỉ email anchor).',
      },
    },
    required: ['email_id'],
  },
};

const searchNewsDeclaration = {
  name: 'search_news',
  description:
    'Tìm tin tức / kế hoạch học tập từ Cổng thông tin sinh viên HUST (TẤT CẢ user ' +
    'đều xem được, không scope theo user). Sắp xếp theo ngày đăng giảm dần.\n\n' +
    'KHI NÀO GỌI:\n' +
    '  - User hỏi về thông báo của trường, kế hoạch thi, học bổng, lịch nghỉ, đăng ' +
    'ký học phần, học bạ, học vụ...\n' +
    '  - Ví dụ: "có học bổng nào mới không", "thi học kỳ này diễn ra khi nào", ' +
    '"có thông báo gì về đăng ký học phần", "kế hoạch tuần sinh hoạt công dân".\n\n' +
    'Tool trả TÓM TẮT (title + preview ngắn). Nếu cần nội dung đầy đủ của 1 bài cụ ' +
    'thể → gọi tiếp `get_news` với `news_id` từ kết quả.\n\n' +
    'Có thể gọi không có `query` (sẽ trả tin mới nhất).',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Từ khóa tìm trong title / summary. OPTIONAL — bỏ qua để lấy tin mới nhất.',
      },
      kind: {
        type: 'string',
        enum: ['NEWS', 'PLAN'],
        description:
          'NEWS = tin tức / thông báo. PLAN = kế hoạch học tập / lịch thi. ' +
          'Optional — bỏ qua để search CẢ 2 loại.',
      },
      limit: {
        type: 'integer',
        description: 'Số kết quả tối đa, 1-30. Default 10.',
      },
    },
  },
};

const getNewsDeclaration = {
  name: 'get_news',
  description:
    'Lấy nội dung ĐẦY ĐỦ của 1 bài tin tức / kế hoạch theo news_id.\n\n' +
    'Dùng SAU KHI `search_news` đã trả kết quả và bạn cần đọc chi tiết để trả lời ' +
    'user.\n\n' +
    'CHỈ gọi với `news_id` đã thấy trong kết quả `search_news` trước đó — KHÔNG bịa.',
  parameters: {
    type: 'object',
    properties: {
      news_id: {
        type: 'string',
        description: 'UUID news, copy NGUYÊN VĂN từ kết quả search_news.',
      },
    },
    required: ['news_id'],
  },
};

const webSearchDeclaration = {
  name: 'web_search',
  description:
    'Tìm thông tin trên web qua search engine ngoài hệ thống. Dùng khi câu hỏi ' +
    'cần thông tin THỜI SỰ / KIẾN THỨC NGOÀI mà bạn không chắc chắn — ví dụ tin ' +
    'tức ngoài HUST, định nghĩa thuật ngữ mới, sự kiện gần đây, thông tin về ' +
    'sách / phim / sự kiện / khoa học / công nghệ cập nhật.\n\n' +
    'KHÔNG gọi cho:\n' +
    '  - Email/tin nội bộ HUST → đã có `search_emails` / `search_news`.\n' +
    '  - Câu hỏi cá nhân về task / TKB / profile của user → không nằm trên web.\n' +
    '  - Toán / lập trình / kiến thức cơ bản bạn TỰ trả lời được mà không cần tra cứu.\n\n' +
    'Trả top kết quả gồm title + link + snippet (content đã extract sẵn từ trang). ' +
    'Khi trích dẫn thông tin, NÊN kèm link nguồn cho user kiểm tra.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Câu truy vấn, viết ngắn gọn như gõ vào thanh search.',
      },
      num: {
        type: 'integer',
        description: 'Số kết quả tối đa, 1-10. Default 5.',
      },
    },
    required: ['query'],
  },
};

export const SEARCH_TOOL_DECLARATIONS = [
  searchEmailsDeclaration,
  getEmailDeclaration,
  searchNewsDeclaration,
  getNewsDeclaration,
  webSearchDeclaration,
];

/** Set tên tool để dispatcher nhận diện. */
const SEARCH_TOOL_NAMES = new Set(SEARCH_TOOL_DECLARATIONS.map((d) => d.name));

export const isSearchToolName = (name) => SEARCH_TOOL_NAMES.has(name);

// ═════════════════════════════════════════════════════════════
// EXECUTORS
// ═════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────
// search_emails
// ─────────────────────────────────────────────────────────────
const execSearchEmails = async ({ userId, args }) => {
  if (!userId) return { success: false, error: 'Thiếu user context.' };

  const q        = String(args?.query     ?? '').trim();
  const fromDate = String(args?.from_date ?? '').trim();
  const toDate   = String(args?.to_date   ?? '').trim();
  const limit    = safeLimit(args?.limit);

  const conditions = ['uac.user_id = $1', 'e.is_deleted = FALSE'];
  const params     = [userId];
  let i = 2;

  if (q) {
    conditions.push(
      `(e.sender ILIKE $${i} OR e.subject ILIKE $${i} OR e.snippet ILIKE $${i} OR e.body_text ILIKE $${i})`,
    );
    params.push(`%${q}%`);
    i++;
  }
  if (fromDate) {
    conditions.push(`e.received_at >= $${i++}`);
    params.push(fromDate);
  }
  if (toDate) {
    conditions.push(`e.received_at <= $${i++}`);
    params.push(toDate);
  }

  params.push(limit);

  try {
    const r = await query(
      `SELECT e.id, e.sender, e.subject, e.snippet, e.received_at, e.gmail_thread_id,
              (SELECT COUNT(*)::int FROM attachments a
                 WHERE a.owner_type = 'EMAIL'
                   AND a.owner_id   = e.id
                   AND a.is_deleted = FALSE
              ) AS attachment_count
         FROM emails e
         JOIN user_account_cross_ref uac ON uac.account_id = e.account_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY e.received_at DESC NULLS LAST
        LIMIT $${i}`,
      params,
    );

    return {
      success: true,
      query:   q || null,
      count:   r.rows.length,
      results: r.rows.map((row) => ({
        id:               row.id,
        from:             row.sender,
        subject:          row.subject,
        snippet:          truncatePreview(row.snippet),
        received_at:      row.received_at,
        thread_id:        row.gmail_thread_id,
        attachment_count: row.attachment_count ?? 0,
      })),
    };
  } catch (err) {
    return { success: false, error: err.message ?? String(err) };
  }
};

// ─────────────────────────────────────────────────────────────
// get_email
// ─────────────────────────────────────────────────────────────
const execGetEmail = async ({ userId, args }) => {
  if (!userId) return { success: false, error: 'Thiếu user context.' };

  const emailId = String(args?.email_id ?? '').trim();
  if (!isUuid(emailId)) {
    return {
      success: false,
      error:   'email_id không hợp lệ — phải là UUID lấy từ kết quả search_emails.',
    };
  }
  const includeThread = args?.include_thread === true;

  try {
    // Anchor email + ownership check (qua user_account_cross_ref)
    const anchorRes = await query(
      `SELECT e.id, e.gmail_thread_id, e.gmail_message_id, e.account_id,
              e.sender, e.recipient, e.subject, e.snippet, e.body_text,
              e.received_at
         FROM emails e
         JOIN user_account_cross_ref uac ON uac.account_id = e.account_id
        WHERE e.id = $1 AND uac.user_id = $2 AND e.is_deleted = FALSE`,
      [emailId, userId],
    );
    const anchor = anchorRes.rows[0];
    if (!anchor) {
      return {
        success: false,
        error:   'Email không tồn tại hoặc không có quyền truy cập.',
      };
    }

    // Attachments metadata của anchor email (chỉ tên + mime, không đọc nội dung)
    const attRes = await query(
      `SELECT file_name, mime_type, size_bytes
         FROM attachments
        WHERE owner_type = 'EMAIL' AND owner_id = $1 AND is_deleted = FALSE
        ORDER BY created_at ASC`,
      [anchor.id],
    );
    const attachments = attRes.rows.map((a) => ({
      file_name: a.file_name,
      mime_type: a.mime_type,
    }));

    if (!includeThread || !anchor.gmail_thread_id) {
      const body = anchor.body_text || anchor.snippet || '';
      return {
        success: true,
        email: {
          id:          anchor.id,
          from:        anchor.sender,
          to:          anchor.recipient,
          subject:     anchor.subject,
          date:        anchor.received_at,
          body:        truncateBody(body, EMAIL_BODY_MAX_CHARS),
          truncated:   body.length > EMAIL_BODY_MAX_CHARS,
          attachments,
        },
      };
    }

    // include_thread = true → fetch toàn bộ message cùng gmail_thread_id
    const tRes = await query(
      `SELECT e.id, e.sender, e.recipient, e.subject, e.snippet, e.body_text, e.received_at
         FROM emails e
         JOIN user_account_cross_ref uac ON uac.account_id = e.account_id
        WHERE uac.user_id = $1
          AND e.gmail_thread_id = $2
          AND e.account_id      = $3
          AND e.is_deleted      = FALSE
        ORDER BY e.received_at ASC`,
      [userId, anchor.gmail_thread_id, anchor.account_id],
    );

    const messages = tRes.rows.map((m) => {
      const body = m.body_text || m.snippet || '';
      return {
        id:        m.id,
        from:      m.sender,
        to:        m.recipient,
        subject:   m.subject,
        date:      m.received_at,
        body:      truncateBody(body, EMAIL_BODY_MAX_CHARS),
        truncated: body.length > EMAIL_BODY_MAX_CHARS,
      };
    });

    return {
      success:               true,
      thread_id:             anchor.gmail_thread_id,
      message_count:         messages.length,
      messages,
      attachments_in_anchor: attachments,
    };
  } catch (err) {
    return { success: false, error: err.message ?? String(err) };
  }
};

// ─────────────────────────────────────────────────────────────
// search_news
// ─────────────────────────────────────────────────────────────
const execSearchNews = async ({ args }) => {
  const q       = String(args?.query ?? '').trim();
  const kindRaw = String(args?.kind  ?? '').toUpperCase().trim();
  const limit   = safeLimit(args?.limit);

  const conditions = ['n.is_deleted = FALSE'];
  const params     = [];
  let i = 1;

  if (q) {
    conditions.push(`(n.title ILIKE $${i} OR n.summary ILIKE $${i})`);
    params.push(`%${q}%`);
    i++;
  }
  if (kindRaw === 'NEWS' || kindRaw === 'PLAN') {
    conditions.push(`n.kind = $${i++}`);
    params.push(kindRaw);
  }

  params.push(limit);

  try {
    const r = await query(
      `SELECT n.id, n.kind, n.title, n.summary, n.tag, n.published_at, n.article_url,
              s.name AS source_name
         FROM news n
         LEFT JOIN news_sources s ON s.id = n.source_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY n.published_at DESC NULLS LAST, n.mod_time DESC
        LIMIT $${i}`,
      params,
    );

    return {
      success: true,
      query:   q || null,
      kind:    kindRaw || null,
      count:   r.rows.length,
      results: r.rows.map((row) => ({
        id:           row.id,
        kind:         row.kind,
        title:        row.title,
        tag:          row.tag,
        published_at: row.published_at,
        source:       row.source_name,
        preview:      truncatePreview(row.summary, NEWS_PREVIEW_CHARS),
      })),
    };
  } catch (err) {
    return { success: false, error: err.message ?? String(err) };
  }
};

// ─────────────────────────────────────────────────────────────
// get_news
// ─────────────────────────────────────────────────────────────
const execGetNews = async ({ args }) => {
  const newsId = String(args?.news_id ?? '').trim();
  if (!isUuid(newsId)) {
    return {
      success: false,
      error:   'news_id không hợp lệ — phải là UUID lấy từ kết quả search_news.',
    };
  }

  try {
    const r = await query(
      `SELECT n.id, n.kind, n.title, n.summary, n.article_url, n.tag, n.published_at,
              s.name AS source_name
         FROM news n
         LEFT JOIN news_sources s ON s.id = n.source_id
        WHERE n.id = $1 AND n.is_deleted = FALSE`,
      [newsId],
    );
    const news = r.rows[0];
    if (!news) return { success: false, error: 'News không tồn tại.' };

    const attRes = await query(
      `SELECT file_name, mime_type, size_bytes
         FROM attachments
        WHERE owner_type = 'NEWS' AND owner_id = $1 AND is_deleted = FALSE
        ORDER BY created_at ASC`,
      [news.id],
    );

    const summary = news.summary || '';
    return {
      success: true,
      news: {
        id:           news.id,
        kind:         news.kind,
        title:        news.title,
        tag:          news.tag,
        published_at: news.published_at,
        source:       news.source_name,
        article_url:  news.article_url,
        body:         truncateBody(summary, NEWS_BODY_MAX_CHARS),
        truncated:    summary.length > NEWS_BODY_MAX_CHARS,
        attachments:  attRes.rows.map((a) => ({
          file_name: a.file_name,
          mime_type: a.mime_type,
        })),
      },
    };
  } catch (err) {
    return { success: false, error: err.message ?? String(err) };
  }
};

// ─────────────────────────────────────────────────────────────
// web_search — Tavily Search API
//
// Doc: https://docs.tavily.com/documentation/api-reference/endpoint/search
// Tạo key: https://app.tavily.com → sign up email/Google/GitHub →
//          dashboard hiện ngay API key dạng `tvly-...`.
// Free tier: 1,000 query/tháng, không cần credit card.
//
// Request: POST /search với Authorization: Bearer <key> + JSON body.
// Response: {
//   query, answer?, results: [{title, url, content, score}], response_time
// }
//
// LƯU Ý field map:
//   - Tavily `url`     → ta đặt tên `link`    (giữ shape cũ, không phải sửa client).
//   - Tavily `content` → ta đặt tên `snippet` (giữ shape cũ).
//   Nhờ vậy Kotlin mapper không cần biết đang dùng provider nào.
// ─────────────────────────────────────────────────────────────
const TAVILY_SEARCH_ENDPOINT = 'https://api.tavily.com/search';
const DEFAULT_WEB_NUM        = 5;
const MAX_WEB_NUM            = 10;
// Timeout cho Tavily — search engine bên ngoài có thể chậm 5-10s khi load
// nặng. Đặt 15s để không treo cả tool loop của Gemini.
const TAVILY_TIMEOUT_MS      = 15_000;

const execWebSearch = async ({ args }) => {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    return {
      success: false,
      error:
        'Web Search chưa được cấu hình trên server (thiếu TAVILY_API_KEY). ' +
        'Báo user là tính năng tra web chưa khả dụng và thử trả lời bằng ' +
        'kiến thức sẵn có.',
    };
  }

  const q = String(args?.query ?? '').trim();
  if (!q) return { success: false, error: 'Thiếu query.' };

  const numRaw = Number.parseInt(args?.num, 10);
  const num    = Number.isFinite(numRaw)
    ? Math.min(MAX_WEB_NUM, Math.max(1, numRaw))
    : DEFAULT_WEB_NUM;

  // AbortController để không treo nếu Tavily chậm bất thường.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TAVILY_TIMEOUT_MS);

  try {
    const res = await fetch(TAVILY_SEARCH_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query:         q,
        max_results:   num,
        // 'basic' = 1 credit/query, đủ dùng cho phần lớn câu hỏi.
        // Chuyển sang 'advanced' (2 credit) nếu user phàn nàn kết quả nông.
        search_depth:  'basic',
        // Có thể bật include_answer: true để Tavily generate sẵn 1 câu
        // trả lời — bỏ qua để tiết kiệm credit + để Gemini tự suy luận.
        include_answer: false,
      }),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      // 401 = key sai/hết hạn, 429 = vượt quota tháng, 432 = vượt rate limit
      // ngắn hạn. Trả message gọn để model biết gracefully fallback.
      return {
        success: false,
        error:
          `Tavily API ${res.status}: ${(errText || res.statusText).slice(0, 200)}`,
      };
    }

    const data    = await res.json();
    const results = Array.isArray(data?.results) ? data.results : [];

    return {
      success: true,
      query:   q,
      count:   results.length,
      results: results.map((it) => ({
        title:   it.title  ?? '',
        link:    it.url    ?? '',
        snippet: truncatePreview(it.content ?? '', WEB_SNIPPET_CHARS),
      })),
    };
  } catch (err) {
    if (err?.name === 'AbortError') {
      return { success: false, error: 'Web Search timeout (>15s).' };
    }
    return {
      success: false,
      error:   `Web Search lỗi: ${err.message ?? String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
};

// ═════════════════════════════════════════════════════════════
// Dispatcher — aiTools.js gọi vào đây.
//
// Return:
//   - { handled: false }       → tool không phải search tool, gọi tiếp router cũ
//   - { handled: true, result }→ đã xử lý, dùng result làm function response
// ═════════════════════════════════════════════════════════════
export const dispatchSearchTool = async (toolName, args, { userId }) => {
  switch (toolName) {
    case 'search_emails':
      return { handled: true, result: await execSearchEmails({ userId, args }) };
    case 'get_email':
      return { handled: true, result: await execGetEmail({ userId, args }) };
    case 'search_news':
      return { handled: true, result: await execSearchNews({ args }) };
    case 'get_news':
      return { handled: true, result: await execGetNews({ args }) };
    case 'web_search':
      return { handled: true, result: await execWebSearch({ args }) };
    default:
      return { handled: false };
  }
};
