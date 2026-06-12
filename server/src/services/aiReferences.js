// server/src/services/aiReferences.js
//
// AI reference resolver — MỚI 2026-06.
//
// Mục tiêu: khi câu trả lời của AI nhắc tới 1 email / tin tức CỤ THỂ, cho phép
// user bấm thẳng vào chỗ đó trong chat để mở đúng email / tin đó trong app.
//
// Cách hoạt động:
//   1. AI được hướng dẫn (buildReferenceSystemNote) chèn token vào reply:
//        [[email:<uuid>]]   ngay sau khi nhắc tới 1 email
//        [[news:<uuid>]]    ngay sau khi nhắc tới 1 tin tức / kế hoạch
//      <uuid> phải copy NGUYÊN VĂN từ trường id trong kết quả tool
//      (search_emails / get_email / search_news / get_news).
//
//   2. resolveReferences() chạy SAU vòng lặp chat:
//        - rút tất cả token trong reply,
//        - tra DB để (a) xác thực quyền truy cập, (b) lấy label hiển thị
//          (subject với email, title với news),
//        - GIỮ token nào resolve được (client sẽ render thành chip bấm được),
//        - XOÁ token nào không resolve (AI bịa id / không có quyền / đã xoá),
//        - trả về { reply, references } với references = [{ type, id, label }].
//
// Lưu ý bảo mật:
//   - Email: scope theo user_account_cross_ref → user chỉ link được email của
//     CHÍNH họ. AI không thể bịa 1 uuid để lộ email người khác.
//   - News: public nhưng vẫn lọc is_deleted = FALSE.
//
// Wiring:
//   - aiTools.js  : import buildReferenceSystemNote, chèn vào system note.
//   - routes/ai.js: import resolveReferences, gọi sau chat() ở cả 3 endpoint
//                   (/chat, /email-chat, /news-chat), thêm references vào response.

import { query } from '../config/db.js';

// ─────────────────────────────────────────────────────────────
// Token format & limits
// ─────────────────────────────────────────────────────────────
const UUID = '[0-9a-fA-F-]{36}';
const EMAIL_TOKEN = new RegExp(`\\[\\[email:(${UUID})\\]\\]`, 'gi');
const NEWS_TOKEN  = new RegExp(`\\[\\[news:(${UUID})\\]\\]`, 'gi');
const ANY_TOKEN   = new RegExp(`\\[\\[(email|news):(${UUID})\\]\\]`, 'gi');

const LABEL_MAX = 100; // cắt label dài để khỏi phình response / chip quá to

const clampLabel = (s, fallback) => {
  const t = String(s ?? '').trim().replace(/\s+/g, ' ');
  if (!t) return fallback;
  return t.length > LABEL_MAX ? `${t.slice(0, LABEL_MAX - 1)}…` : t;
};

// ─────────────────────────────────────────────────────────────
// System note — hướng dẫn AI chèn token trích dẫn.
// Gọi trong aiTools.buildToolSystemNote() để áp cho mọi endpoint.
// ─────────────────────────────────────────────────────────────
export const buildReferenceSystemNote = () => [
  'QUAN TRỌNG về TRÍCH DẪN email / tin tức (giúp user bấm mở trực tiếp):',
  '  - Khi câu trả lời nhắc tới 1 email CỤ THỂ (từ kết quả search_emails /',
  '    get_email, hoặc email đang xem), chèn token NGAY SAU khi nhắc tới nó:',
  '        [[email:<id>]]',
  '  - Khi nhắc tới 1 tin tức / kế hoạch CỤ THỂ (từ search_news / get_news),',
  '    chèn token NGAY SAU đó:',
  '        [[news:<id>]]',
  '  - <id> là UUID copy NGUYÊN VĂN từ trường "id" trong kết quả tool. KHÔNG bịa.',
  '  - App sẽ render token thành 1 NÚT BẤM ĐƯỢC (tự hiển thị tiêu đề/chủ đề),',
  '    nên bạn KHÔNG cần lặp lại tiêu đề dài — chỉ cần đặt token đúng chỗ.',
  '  - Mỗi email/tin chỉ chèn token 1 LẦN (ở lần đầu nhắc tới).',
  '  - KHÔNG chèn token cho kết quả web_search (web dùng link http thường).',
  '  - Token [[email:..]] / [[news:..]] xuất hiện ở các lượt trả lời TRƯỚC chính là',
  '    trích dẫn bạn đã chèn — coi như link, không phải nội dung cần đọc lại.',
  '  - Ví dụ: "Bạn có 1 email mới từ Phòng Đào tạo về lịch thi [[email:abcd...]]."',
].join('\n');

// ─────────────────────────────────────────────────────────────
// resolveReferences — chạy sau chat().
//
// @param {Object} p
// @param {string} p.reply   — reply text của AI (có thể chứa token)
// @param {string} p.userId  — id user đang chat (để scope email)
// @returns {Promise<{ reply: string, references: Array<{type,id,label}> }>}
// ─────────────────────────────────────────────────────────────
export const resolveReferences = async ({ reply, userId }) => {
  const text = String(reply ?? '');
  if (!text.includes('[[')) return { reply: text, references: [] };

  // 1) Gom id theo loại (lowercase để so khớp).
  const emailIds = new Set();
  const newsIds  = new Set();
  for (const m of text.matchAll(EMAIL_TOKEN)) emailIds.add(m[1].toLowerCase());
  for (const m of text.matchAll(NEWS_TOKEN))  newsIds.add(m[1].toLowerCase());

  if (emailIds.size === 0 && newsIds.size === 0) {
    // Có "[[" nhưng không phải token hợp lệ → dọn rác cho chắc.
    return { reply: text.replace(ANY_TOKEN, '').trimEnd(), references: [] };
  }

  // labelByKey: key = `${type}:${idLower}` → label đã clamp.
  const labelByKey = new Map();

  // 2) Email — scope theo user (bảo mật).
  if (emailIds.size > 0 && userId) {
    try {
      const r = await query(
        `SELECT e.id, e.subject
           FROM emails e
           JOIN user_account_cross_ref uac ON uac.account_id = e.account_id
          WHERE e.id = ANY($1::uuid[])
            AND uac.user_id  = $2
            AND e.is_deleted = FALSE`,
        [[...emailIds], userId],
      );
      for (const row of r.rows) {
        labelByKey.set(`email:${String(row.id).toLowerCase()}`, clampLabel(row.subject, 'Mở email'));
      }
    } catch (err) {
      console.warn('[aiReferences] resolve emails lỗi:', err?.message ?? err);
    }
  }

  // 3) News — public, chỉ lọc chưa xoá.
  if (newsIds.size > 0) {
    try {
      const r = await query(
        `SELECT id, title
           FROM news
          WHERE id = ANY($1::uuid[]) AND is_deleted = FALSE`,
        [[...newsIds]],
      );
      for (const row of r.rows) {
        labelByKey.set(`news:${String(row.id).toLowerCase()}`, clampLabel(row.title, 'Mở tin'));
      }
    } catch (err) {
      console.warn('[aiReferences] resolve news lỗi:', err?.message ?? err);
    }
  }

  // 4) Rebuild reply: giữ token resolve được, xoá token không resolve.
  const references = [];
  const seen = new Set();

  const cleaned = text.replace(ANY_TOKEN, (token, type, rawId) => {
    const key = `${type.toLowerCase()}:${rawId.toLowerCase()}`;
    const label = labelByKey.get(key);
    if (!label) return ''; // không resolve → bỏ token (tránh hiện id thô)
    if (!seen.has(key)) {
      seen.add(key);
      references.push({ type: type.toLowerCase(), id: rawId, label });
    }
    return token; // giữ nguyên cho client render chip
  });

  // 5) Dọn khoảng trắng dư do xoá token.
  const tidied = cleaned
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.,;:!?)\]])/g, '$1')
    .replace(/\(\s+\)/g, '')
    .trimEnd();

  return { reply: tidied, references };
};
