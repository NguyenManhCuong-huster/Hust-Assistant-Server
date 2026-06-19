// server/src/services/attachmentTextService.js
//
// Extract text từ attachment đã download xuống đĩa, để feed cho Gemini
// như plain text thay vì upload binary (tiết kiệm token 5-10 lần).
//
// CHANGES 2026-05-31:
//   + extractAttachmentTextByFileNameInIds(): UNIFIED resolver cho cả 3 luồng
//     chat (Email / News / Standalone). Resolve file_name → UUID trong TẬP
//     UUID đã được tổng hợp & validate từ trước (gồm: source attachments của
//     email/news + attachments do user upload qua AI Chat upload endpoint +
//     attachments user reference qua message.attachments).
//
//   + Bỏ extractAttachmentTextByFileName() cũ (dùng owner_type+ownerIds) —
//     thay bằng pattern thống nhất. aiTools.js sẽ gọi hàm mới.
//
// CHANGES 2026-06 (bug fix "AI không đọc được file đính kèm email"):
//   + isTextExtractable(mime, fileName) — helper public, đọc danh sách
//     extension từ ENV `ATTACHMENT_TEXT_EXTRACT_EXTS`. Dùng làm filter
//     trong buildAttachmentsSystemNote() / buildFileListNote() thay cho
//     `!a.is_inline` (vốn lệ thuộc cờ DB hay bị set sai do Content-ID).
//
// Hỗ trợ:
//   - PDF              → pdf-parse
//   - DOCX             → mammoth
//   - XLSX / XLS       → xlsx (SheetJS), convert sang CSV mỗi sheet
//   - CSV / TXT / MD   → đọc utf-8 thẳng
//   - HTML             → strip tag thô
//   - Các MIME khác    → trả error, AI biết bỏ qua

import fs   from 'node:fs/promises';
import path from 'node:path';

import { query } from '../../shared/database/db.js';
import {
  getAttachmentForUser,
  getUploadRoot,
} from './attachments.service.js';

// ─────────────────────────────────────────────────────────────
// Limits
// ─────────────────────────────────────────────────────────────
const MAX_TEXT_CHARS = 300_000;
const HEAD_CHARS     = 200_000;
const TAIL_CHARS     = 100_000;

// ─────────────────────────────────────────────────────────────
// Text-extractable detector — đọc env 1 lần lúc module load.
// ENV: ATTACHMENT_TEXT_EXTRACT_EXTS=pdf,docx,xlsx,xls,csv,html,htm,txt,md,json,xml,log
//
// Dùng cho filter ở aiService.buildAttachmentsSystemNote() + ai.js
// buildFileListNote() để chỉ liệt kê cho AI những file thực sự có thể
// đọc được. Tránh AI cố gắng read_attachment 1 file ảnh/video/zip rồi fail.
// ─────────────────────────────────────────────────────────────
const DEFAULT_EXTRACT_EXTS = 'pdf,docx,xlsx,xls,csv,html,htm,txt,md,json,xml,log';

const TEXT_EXTRACT_EXTS = new Set(
  (process.env.ATTACHMENT_TEXT_EXTRACT_EXTS || DEFAULT_EXTRACT_EXTS)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

// MIME keyword phụ trợ: cover trường hợp filename không có extension
// nhưng MIME đúng (vd "report" với mime "application/pdf").
const TEXT_EXTRACT_MIME_KEYWORDS = [
  'pdf', 'wordprocessingml', 'spreadsheetml', 'ms-excel', 'csv', 'html',
];

/**
 * Trả true nếu file (theo mime hoặc filename) có thể trích text qua
 * read_attachment. Logic match với extractByMime() bên dưới.
 *
 * @param {string|null} mime
 * @param {string}      fileName
 * @returns {boolean}
 */
export const isTextExtractable = (mime, fileName = '') => {
  const ext = (String(fileName).split('.').pop() || '').toLowerCase();
  if (ext && TEXT_EXTRACT_EXTS.has(ext)) return true;

  const m = String(mime || '').toLowerCase();
  if (!m) return false;
  if (m.startsWith('text/')) return true;
  return TEXT_EXTRACT_MIME_KEYWORDS.some((kw) => m.includes(kw));
};

// ─────────────────────────────────────────────────────────────
// PUBLIC: gọi từ AI tool executor (UNIFIED 2026-05-31).
// ─────────────────────────────────────────────────────────────
/**
 * Resolve file_name → attachment_id trong tập IDs cho trước rồi extract text.
 *
 * Tập `allowedIds` được build ở route layer (ai.js):
 *   1. Cho mọi message trong history: lấy message.attachments[].id rồi validate
 *      ownership qua getAttachmentsForUserBulk.
 *   2. Với /api/ai/email-chat: thêm IDs của attachments thuộc thread emails.
 *   3. Với /api/ai/news-chat:  thêm IDs của attachments thuộc news đó.
 *   4. Với /api/ai/chat (standalone): chỉ có (1).
 *
 * Vì IDs đã validate ownership trước → bước extract chỉ cần verify lần nữa
 * qua getAttachmentForUser (defense-in-depth).
 *
 * @param {Object}   opts
 * @param {string}   opts.fileName    — tên file đúng như AI thấy trong system instruction
 * @param {string[]} opts.allowedIds  — danh sách UUID attachment được phép đọc
 * @param {string}   opts.userId      — để verify ownership ở bước extract
 * @returns {Promise<Object>}
 */
export const extractAttachmentTextByFileNameInIds = async ({
  fileName,
  allowedIds,
  userId,
}) => {
  if (!fileName) return { success: false, error: 'Thiếu file_name.' };
  if (!Array.isArray(allowedIds) || allowedIds.length === 0) {
    return {
      success: false,
      error: 'Không có file đính kèm nào trong cuộc hội thoại để đọc.',
    };
  }

  // ── Fetch toàn bộ candidate filenames trong allowedIds 1 query ──
  //    Resolve trong JS để có thể normalize linh hoạt hơn so với SQL REPLACE.
  const candRes = await query(
    `SELECT id, file_name
       FROM attachments
      WHERE id = ANY($1::uuid[])
        AND is_deleted = FALSE
      ORDER BY mod_time DESC`,
    [allowedIds],
  );
  const candidates = candRes.rows;

  if (candidates.length === 0) {
    return {
      success: false,
      error:   'Không tìm thấy attachment hợp lệ trong cuộc hội thoại.',
      available_files: [],
    };
  }

  // ── Resolver: 4 tầng từ chặt → lỏng ──
  //    Layer 1: exact      — match nguyên văn (đa số case OK ở đây)
  //    Layer 2: NFC+trim   — chỉ chuẩn hoá Unicode + bỏ leading/trailing space
  //    Layer 3: case-fold  — lower-case + Unicode normalize
  //    Layer 4: aggressive — bỏ MỌI whitespace + _/-/() + lowercase
  //                          (xử lý các biến thể AI hay tạo: "code_server.txt",
  //                           "code-server.txt", "code\u00A0server.txt",
  //                           "report(2).html" vs "report (2).html"…)
  const target = String(fileName).trim();

  const layers = [
    /* L1 */ (s) => s,
    /* L2 */ (s) => s.normalize('NFC').trim(),
    /* L3 */ (s) => s.normalize('NFC').trim().toLowerCase(),
    /* L4 */ (s) => s
      .normalize('NFC')
      .toLowerCase()
      .replace(/\s+/g,  '')           // mọi whitespace (\s phủ \u00A0, \t…)
      .replace(/[_\-()]/g, '')        // _ - ( ) — AI hay thay space bằng _ hoặc -
      .replace(/[^\p{L}\p{N}.]/gu, ''), // chỉ giữ chữ/số/dấu chấm
  ];

  let hit = null;
  let matchedLayer = -1;
  for (let i = 0; i < layers.length && !hit; i++) {
    const norm = layers[i];
    const t = norm(target);
    if (!t) continue;
    hit = candidates.find((c) => norm(c.file_name) === t);
    if (hit) matchedLayer = i;
  }

  if (!hit) {
    console.warn(
      `[read_attachment] MISS fileName="${target}" ` +
      `among ${candidates.length} files: [${candidates.map((c) => c.file_name).join(', ')}]`,
    );
    return {
      success: false,
      error:   `Không tìm thấy file tên "${fileName}".`,
      available_files: candidates.map((x) => x.file_name),
    };
  }

  if (matchedLayer > 0) {
    console.log(
      `[read_attachment] FUZZY match L${matchedLayer + 1}: AI passed "${target}" → DB "${hit.file_name}"`,
    );
  } else {
    console.log(`[read_attachment] exact match "${hit.file_name}"`);
  }

  return await extractAttachmentText(hit.id, userId);
};

// ─────────────────────────────────────────────────────────────
// PUBLIC: extract text 1 attachment đã biết UUID.
// (vẫn export để code khác có thể dùng, vd debug route.)
// ─────────────────────────────────────────────────────────────
export const extractAttachmentText = async (
  attachmentId,
  userId,
  { useCache = true } = {},
) => {
  const row = await getAttachmentForUser(attachmentId, userId);
  if (!row) {
    return { success: false, error: 'Attachment không tồn tại hoặc không có quyền.' };
  }
  if (!row.storage_path) {
    return { success: false, error: 'File chưa được tải xuống server.' };
  }

  if (useCache) {
    const c = await query(
      `SELECT extracted_text FROM attachments WHERE id = $1`,
      [attachmentId],
    );
    const cached = c.rows[0]?.extracted_text;
    if (cached) {
      return {
        success:    true,
        text:       cached,
        file_name:  row.file_name,
        mime_type:  row.mime_type,
        truncated:  cached.length >= MAX_TEXT_CHARS,
        from_cache: true,
      };
    }
  }

  const abs = path.join(getUploadRoot(), row.storage_path);
  let buffer;
  try {
    buffer = await fs.readFile(abs);
  } catch (e) {
    return { success: false, error: `Không đọc được file trên đĩa: ${e.message}` };
  }

  let raw;
  try {
    raw = await extractByMime(buffer, row.mime_type, row.file_name);
  } catch (e) {
    return { success: false, error: `Parse file lỗi: ${e.message}` };
  }
  raw = (raw || '').trim();
  if (!raw) {
    return { success: false, error: 'File rỗng hoặc không trích xuất được text.' };
  }

  const text = truncateText(raw);

  if (useCache) {
    try {
      await query(
        `UPDATE attachments
            SET extracted_text = $1,
                extracted_at   = CURRENT_TIMESTAMP
          WHERE id = $2`,
        [text, attachmentId],
      );
    } catch (e) {
      console.warn(`[attachmentText] cache write failed for ${attachmentId}: ${e.message}`);
    }
  }

  return {
    success:         true,
    text,
    file_name:       row.file_name,
    mime_type:       row.mime_type,
    truncated:       raw.length > MAX_TEXT_CHARS,
    original_length: raw.length,
    from_cache:      false,
  };
};

// ─────────────────────────────────────────────────────────────
// Dispatcher + concrete extractors
// ─────────────────────────────────────────────────────────────
const extractByMime = async (buffer, mime, fileName) => {
  const m   = (mime || '').toLowerCase();
  const ext = (fileName.split('.').pop() || '').toLowerCase();

  if (m.includes('pdf') || ext === 'pdf') {
    return await extractPdf(buffer);
  }
  if (m.includes('wordprocessingml') || ext === 'docx') {
    return await extractDocx(buffer);
  }
  if (
    m.includes('spreadsheetml') ||
    m.includes('ms-excel') ||
    ['xlsx', 'xls'].includes(ext)
  ) {
    return await extractXlsx(buffer);
  }
  if (m.includes('csv') || ext === 'csv') {
    return buffer.toString('utf8');
  }
  if (m.includes('html') || ['html', 'htm'].includes(ext)) {
    return stripHtml(buffer.toString('utf8'));
  }
  if (m.startsWith('text/') || ['txt', 'md', 'json', 'xml', 'log'].includes(ext)) {
    return buffer.toString('utf8');
  }

  throw new Error(`MIME "${mime}" / ext "${ext}" chưa được hỗ trợ extract text.`);
};

const extractPdf = async (buffer) => {
  const pdfParse = (await import('pdf-parse')).default;
  const result   = await pdfParse(buffer);
  return result.text || '';
};

const extractDocx = async (buffer) => {
  const mammoth = await import('mammoth');
  const result  = await mammoth.extractRawText({ buffer });
  return result.value || '';
};

const extractXlsx = async (buffer) => {
  const XLSX = await import('xlsx');
  const wb   = XLSX.read(buffer, { type: 'buffer' });
  const out  = [];
  for (const name of wb.SheetNames) {
    out.push(`══════ Sheet: ${name} ══════`);
    out.push(XLSX.utils.sheet_to_csv(wb.Sheets[name]));
  }
  return out.join('\n');
};

const stripHtml = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi,  '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g,    ' ')
    .trim();

const truncateText = (s) => {
  if (s.length <= MAX_TEXT_CHARS) return s;
  return (
    s.slice(0, HEAD_CHARS) +
    `\n\n[...ĐÃ CẮT BỚT ${s.length - HEAD_CHARS - TAIL_CHARS} ký tự ở giữa do file quá dài...]\n\n` +
    s.slice(-TAIL_CHARS)
  );
};
