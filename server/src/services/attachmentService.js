import fs       from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path     from 'node:path';

import { query } from '../config/db.js';

const UPLOAD_ROOT = process.env.UPLOAD_ROOT ?? '/app/uploads';
const MAX_BYTES   = Number.parseInt(process.env.MAX_ATTACHMENT_BYTES, 10) || 25 * 1024 * 1024;

// Giới hạn cho 1 ảnh khi nhúng inline vào request Gemini.
// Gemini API có hard limit ~20MB cho TOÀN BỘ payload (text + media). Một
// conversation có thể có nhiều ảnh + thread email dài → đặt cap khá thấp.
// Override qua ENV `AI_INLINE_IMAGE_MAX_BYTES`.
const INLINE_IMAGE_MAX_BYTES = Number.parseInt(
  process.env.AI_INLINE_IMAGE_MAX_BYTES,
  10,
) || 7 * 1024 * 1024; // 7 MB

export const OWNER_EMAIL   = 'EMAIL';
export const OWNER_NEWS    = 'NEWS';
export const OWNER_AI_CHAT = 'AI_CHAT';

// ─────────────────────────────────────────────────────────────
// Image detection — UNIFIED 2026-06.
//
// Whitelist các MIME ảnh mà Gemini multimodal hỗ trợ inline.
// Tham khảo: https://ai.google.dev/gemini-api/docs/vision
// (Cap cũng phụ thuộc model — Gemini 1.5+ rộng hơn 1.0.)
//
// SVG cố tình bỏ qua: là XML/text, Gemini không tự render, và `pdf-parse`/
// `mammoth`/... cũng không xử lý SVG. Người dùng cần SVG hãy lưu PNG.
// ─────────────────────────────────────────────────────────────
const INLINE_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',   // non-standard alias, một số mail relay vẫn dùng
  'image/webp',
  'image/heic',
  'image/heif',
  'image/gif',
]);

/**
 * True nếu MIME thuộc danh sách ảnh có thể nhúng inline vào Gemini.
 * Dùng ở aiService + routes/ai.js để filter rows trước khi đọc bytes.
 */
export const isInlineImageMime = (mime) => {
  if (!mime) return false;
  return INLINE_IMAGE_MIMES.has(String(mime).toLowerCase().trim());
};

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

/**
 * Sanitize tên file để an toàn cho filesystem.
 * Giữ chữ cái Unicode (tiếng Việt), số, dấu chấm, gạch dưới, gạch ngang, ngoặc, space.
 * Thay phần còn lại bằng `_`. Cắt extension max 10 ký tự.
 */
export const sanitizeFileName = (raw) => {
  if (!raw) return 'unnamed';
  const trimmed = String(raw).normalize('NFC').trim();
  // Lấy basename, bỏ leading dots (tránh `.htaccess` style)
  const base = path.basename(trimmed).replace(/^\.+/, '');
  // Allow Unicode letters/digits + một số ký tự an toàn
  const safe = base.replace(/[^\p{L}\p{N}._\-()\s]/gu, '_');
  // Cap chiều dài tổng (Linux ext4 max filename = 255 bytes)
  return safe.slice(0, 200) || 'unnamed';
};

const ownerDir = (ownerType, ownerId) =>
  path.join(UPLOAD_ROOT, ownerType, ownerId);

const ensureDir = async (dir) => {
  await fs.mkdir(dir, { recursive: true });
};

const fileSizeOf = async (absPath) => {
  try {
    const stat = await fs.stat(absPath);
    return stat.size;
  } catch {
    return null;
  }
};

// ─────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────

/**
 * Upsert metadata row (chưa download). Trả id của row.
 */
export const upsertMetadata = async ({
  ownerType, ownerId,
  fileName, mimeType = null,
  sizeBytes = null,
  storagePath = null,
  sourceUrl = null,
  gmailAttachmentId = null,
  isInline = false,
}) => {
  const safe = sanitizeFileName(fileName);
  const r = await query(
    `INSERT INTO attachments
       (owner_type, owner_id, file_name, mime_type, size_bytes,
        storage_path, source_url, gmail_attachment_id, is_inline, mod_time)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
     ON CONFLICT (owner_type, owner_id, file_name) DO UPDATE SET
       mime_type           = COALESCE(EXCLUDED.mime_type, attachments.mime_type),
       size_bytes          = COALESCE(EXCLUDED.size_bytes, attachments.size_bytes),
       storage_path        = COALESCE(EXCLUDED.storage_path, attachments.storage_path),
       source_url          = COALESCE(EXCLUDED.source_url, attachments.source_url),
       gmail_attachment_id = COALESCE(EXCLUDED.gmail_attachment_id, attachments.gmail_attachment_id),
       is_inline           = EXCLUDED.is_inline,
       mod_time            = CURRENT_TIMESTAMP,
       is_deleted          = FALSE
     RETURNING id`,
    [ownerType, ownerId, safe, mimeType, sizeBytes, storagePath, sourceUrl, gmailAttachmentId, isInline],
  );
  return r.rows[0].id;
};

/**
 * Lưu buffer xuống đĩa + upsert DB. Trả { id, storagePath, sizeBytes }.
 */
export const saveBuffer = async ({
  ownerType, ownerId,
  fileName, mimeType = null, buffer,
  sourceUrl = null,
  gmailAttachmentId = null,
  isInline = false,
}) => {
  if (!buffer || buffer.length === 0) {
    throw new Error('empty buffer');
  }
  if (buffer.length > MAX_BYTES) {
    const err = new Error(`file too large (${buffer.length} > ${MAX_BYTES} bytes)`);
    err.code = 'TOO_LARGE';
    throw err;
  }

  const safe = sanitizeFileName(fileName);
  const dir  = ownerDir(ownerType, ownerId);
  await ensureDir(dir);
  const absPath = path.join(dir, safe);
  await fs.writeFile(absPath, buffer);

  const sizeBytes   = buffer.length;
  const storagePath = path.relative(UPLOAD_ROOT, absPath);  // store relative

  const id = await upsertMetadata({
    ownerType, ownerId,
    fileName: safe, mimeType, sizeBytes,
    storagePath, sourceUrl, gmailAttachmentId, isInline,
  });
  return { id, storagePath, sizeBytes };
};

// ═════════════════════════════════════════════════════════
// AI_CHAT upload (MỚI 2026-05-31)
// ═════════════════════════════════════════════════════════

/**
 * Resolve tên file unique cho 1 user trong AI Chat.
 *
 * Vd: user đã có "report.pdf" → upload thêm "report.pdf" → trả "report (2).pdf".
 *     Upload tiếp lần 3 → "report (3).pdf". v.v.
 *
 * Lý do: unique constraint (owner_type, owner_id, file_name) sẽ làm upsertMetadata
 * GHI ĐÈ row cũ (đồng nghĩa overwrite file cũ trên đĩa). Trong context AI Chat,
 * user có thể attach NHIỀU file cùng tên qua nhiều lượt upload → cần giữ riêng.
 */
const buildUniqueAiChatFileName = async (userId, requestedName) => {
  const safeBase  = sanitizeFileName(requestedName);
  const dotIdx    = safeBase.lastIndexOf('.');
  const stem      = dotIdx > 0 ? safeBase.slice(0, dotIdx) : safeBase;
  const ext       = dotIdx > 0 ? safeBase.slice(dotIdx)    : '';

  // Lấy danh sách tên đang tồn tại để check nhanh trong vòng lặp
  const existing = await query(
    `SELECT file_name
       FROM attachments
      WHERE owner_type = 'AI_CHAT'
        AND owner_id   = $1
        AND is_deleted = FALSE`,
    [userId],
  );
  const used = new Set(existing.rows.map((r) => r.file_name));

  if (!used.has(safeBase)) return safeBase;

  // Tìm suffix nhỏ nhất chưa dùng. Cap 999 để không loop vô hạn.
  for (let i = 2; i <= 999; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!used.has(candidate)) return candidate;
  }
  // Fallback cực hiếm: timestamp suffix
  return `${stem}_${Date.now()}${ext}`;
};

/**
 * Upload 1 file user vào AI Chat (owner_type = 'AI_CHAT', owner_id = userId).
 *
 * @returns {Promise<{id, file_name, mime_type, size_bytes, storage_path}>}
 */
export const saveAiChatUpload = async ({ userId, originalName, mimeType, buffer }) => {
  if (!userId) throw new Error('userId là bắt buộc');
  if (!buffer || buffer.length === 0) throw new Error('empty buffer');
  if (buffer.length > MAX_BYTES) {
    const err = new Error(`file too large (${buffer.length} > ${MAX_BYTES} bytes)`);
    err.code = 'TOO_LARGE';
    throw err;
  }

  const fileName = await buildUniqueAiChatFileName(userId, originalName || 'unnamed');

  const { id, storagePath, sizeBytes } = await saveBuffer({
    ownerType: OWNER_AI_CHAT,
    ownerId:   userId,
    fileName,
    mimeType,
    buffer,
  });

  return {
    id,
    file_name:   fileName,
    mime_type:   mimeType,
    size_bytes:  sizeBytes,
    storage_path: storagePath,
  };
};

// ═════════════════════════════════════════════════════════
// Download URL public → lưu xuống đĩa + DB.
// ═════════════════════════════════════════════════════════
export const downloadAndSave = async ({
  ownerType, ownerId,
  fileName, sourceUrl,
  headers = {},
}) => {
  const safe = sanitizeFileName(fileName);

  // Metadata-only fallback (sẽ override sau nếu download OK)
  const baseRow = { ownerType, ownerId, fileName: safe, sourceUrl };

  let res;
  try {
    res = await fetch(sourceUrl, { headers });
  } catch (e) {
    await upsertMetadata(baseRow);
    throw new Error(`fetch failed ${sourceUrl}: ${e.message}`);
  }
  if (!res.ok) {
    await upsertMetadata(baseRow);
    throw new Error(`HTTP ${res.status} ${sourceUrl}`);
  }

  const lenHeader = res.headers.get('content-length');
  const declared  = lenHeader ? Number.parseInt(lenHeader, 10) : null;
  if (declared && declared > MAX_BYTES) {
    await upsertMetadata({ ...baseRow, sizeBytes: declared,
      mimeType: res.headers.get('content-type')?.split(';')[0] });
    const err = new Error(`file too large per Content-Length (${declared})`);
    err.code = 'TOO_LARGE';
    throw err;
  }

  const arrayBuf = await res.arrayBuffer();
  const buffer   = Buffer.from(arrayBuf);
  if (buffer.length > MAX_BYTES) {
    await upsertMetadata({ ...baseRow, sizeBytes: buffer.length,
      mimeType: res.headers.get('content-type')?.split(';')[0] });
    const err = new Error(`file too large (${buffer.length})`);
    err.code = 'TOO_LARGE';
    throw err;
  }

  const mimeType = res.headers.get('content-type')?.split(';')[0] || null;
  return saveBuffer({
    ownerType, ownerId,
    fileName: safe, mimeType, buffer, sourceUrl,
  });
};

/**
 * List metadata cho 1 owner (KHÔNG include rows đã soft-delete).
 */
export const listForOwner = async (ownerType, ownerId) => {
  const r = await query(
    `SELECT id, owner_type, owner_id, file_name, mime_type, size_bytes,
            storage_path IS NOT NULL AS is_downloaded,
            source_url, is_inline, mod_time, created_at
       FROM attachments
      WHERE owner_type = $1 AND owner_id = $2 AND is_deleted = FALSE
      ORDER BY created_at ASC`,
    [ownerType, ownerId],
  );
  return r.rows;
};

/**
 * Bulk list cho NHIỀU owner cùng loại. Trả Map<owner_id, Array<row>>.
 */
export const listForOwnersBulk = async (ownerType, ownerIds) => {
  if (!ownerIds || ownerIds.length === 0) return new Map();
  const r = await query(
    `SELECT id, owner_type, owner_id, file_name, mime_type, size_bytes,
            storage_path IS NOT NULL AS is_downloaded,
            source_url, is_inline, mod_time, created_at
       FROM attachments
      WHERE owner_type = $1 AND owner_id = ANY($2::uuid[]) AND is_deleted = FALSE
      ORDER BY created_at ASC`,
    [ownerType, ownerIds],
  );
  const map = new Map();
  for (const row of r.rows) {
    if (!map.has(row.owner_id)) map.set(row.owner_id, []);
    map.get(row.owner_id).push(row);
  }
  return map;
};

/**
 * Lấy attachment by id + check ownership.
 *
 *  - NEWS attachment    : ai cũng có thể tải (news public).
 *  - EMAIL attachment   : chỉ user link với account đó được tải.
 *  - AI_CHAT attachment : chỉ chính user đã upload mới được tải.
 *
 * Trả null nếu không tìm thấy / không có quyền.
 */
export const getAttachmentForUser = async (attachmentId, userId) => {
  const r = await query(
    `SELECT a.id, a.owner_type, a.owner_id, a.file_name, a.mime_type,
            a.size_bytes, a.storage_path, a.is_deleted
       FROM attachments a
      WHERE a.id = $1 AND a.is_deleted = FALSE`,
    [attachmentId],
  );
  const row = r.rows[0];
  if (!row) return null;

  if (row.owner_type === OWNER_NEWS) return row;                  // public

  if (row.owner_type === OWNER_AI_CHAT) {
    return row.owner_id === userId ? row : null;
  }

  // EMAIL: cần check user_account_cross_ref
  const ok = await query(
    `SELECT 1 FROM emails e
       JOIN user_account_cross_ref uac ON uac.account_id = e.account_id
      WHERE e.id = $1 AND uac.user_id = $2`,
    [row.owner_id, userId],
  );
  return ok.rows[0] ? row : null;
};

/**
 * Bulk version của getAttachmentForUser — filter các ID user có quyền.
 *
 * Dùng cho /api/ai/* khi validate IDs nhận từ message.attachments do client gửi.
 * Trả về Map<id, row> chỉ chứa những ID hợp lệ.
 */
export const getAttachmentsForUserBulk = async (attachmentIds, userId) => {
  const result = new Map();
  if (!Array.isArray(attachmentIds) || attachmentIds.length === 0) return result;

  // Dedupe + lọc UUID hợp lệ (Postgres reject mismatched UUID literal)
  const ids = [...new Set(attachmentIds.filter(
    (x) => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x.trim()),
  ).map((x) => x.trim()))];
  if (ids.length === 0) return result;

  const r = await query(
    `SELECT a.id, a.owner_type, a.owner_id, a.file_name, a.mime_type,
            a.size_bytes, a.storage_path, a.is_deleted, a.is_inline,
            a.storage_path IS NOT NULL AS is_downloaded
       FROM attachments a
      WHERE a.id = ANY($1::uuid[]) AND a.is_deleted = FALSE`,
    [ids],
  );

  // Group theo owner_type để batch check ownership
  const newsRows  = [];
  const aiRows    = [];
  const emailRows = [];
  for (const row of r.rows) {
    if (row.owner_type === OWNER_NEWS)         newsRows.push(row);
    else if (row.owner_type === OWNER_AI_CHAT) aiRows.push(row);
    else                                       emailRows.push(row);
  }

  // NEWS: public, mọi user OK
  for (const row of newsRows) result.set(row.id, row);

  // AI_CHAT: chỉ chính owner
  for (const row of aiRows) {
    if (row.owner_id === userId) result.set(row.id, row);
  }

  // EMAIL: cần JOIN với user_account_cross_ref
  if (emailRows.length > 0) {
    const emailOwnerIds = emailRows.map((x) => x.owner_id);
    const okRes = await query(
      `SELECT e.id
         FROM emails e
         JOIN user_account_cross_ref uac ON uac.account_id = e.account_id
        WHERE e.id = ANY($1::uuid[]) AND uac.user_id = $2`,
      [emailOwnerIds, userId],
    );
    const okSet = new Set(okRes.rows.map((x) => x.id));
    for (const row of emailRows) {
      if (okSet.has(row.owner_id)) result.set(row.id, row);
    }
  }

  return result;
};

/**
 * Trả absolute path + tạo read stream. Throw nếu file thiếu trên đĩa.
 */
export const openReadStream = (storagePath) => {
  if (!storagePath) throw new Error('storage_path is null (file not yet downloaded)');
  const abs = path.join(UPLOAD_ROOT, storagePath);
  // Bảo vệ path-traversal: abs phải nằm dưới UPLOAD_ROOT
  if (!abs.startsWith(path.resolve(UPLOAD_ROOT) + path.sep) && abs !== path.resolve(UPLOAD_ROOT)) {
    const resolved = path.resolve(abs);
    const root     = path.resolve(UPLOAD_ROOT);
    if (!resolved.startsWith(root + path.sep)) {
      throw new Error('path traversal detected');
    }
  }
  return { absPath: abs, stream: createReadStream(abs) };
};

// ─────────────────────────────────────────────────────────────
// MỚI 2026-06: Inline image reader cho AI multimodal.
//
// Trả về Map<attachment_id, {mimeType, base64Data, file_name, sizeBytes}>
// cho NHỮNG ROW LÀ ẢNH HỖ TRỢ. Rows không phải ảnh hoặc thiếu storage_path
// sẽ bị skip. File quá lớn (> INLINE_IMAGE_MAX_BYTES) cũng bị skip + log
// cảnh báo — caller có thể quyết định nói gì với user.
//
// Path-traversal guard: dùng cùng logic với openReadStream().
//
// Input rows là output từ collectEffectiveAttachments (đã validate ownership).
// Tức là KHÔNG cần check quyền lần nữa — caller đã làm.
//
// Lý do tách thành 1 hàm: gọi từ aiService/routes/ai.js mỗi turn chat, muốn
// 1 chỗ duy nhất kiểm tra MIME + size + đọc disk.
// ─────────────────────────────────────────────────────────────
/**
 * @param {Array<{id, mime_type, storage_path, file_name, size_bytes}>} rows
 * @returns {Promise<Map<string, {mimeType: string, base64Data: string, file_name: string, sizeBytes: number}>>}
 */
export const readInlineImagesByRows = async (rows) => {
  const out = new Map();
  if (!Array.isArray(rows) || rows.length === 0) return out;

  const rootResolved = path.resolve(UPLOAD_ROOT);

  // Đọc song song để giảm latency nếu có nhiều ảnh
  await Promise.all(rows.map(async (row) => {
    if (!row || !row.id) return;
    if (!isInlineImageMime(row.mime_type)) return;
    if (!row.storage_path) return;

    const abs = path.resolve(path.join(UPLOAD_ROOT, row.storage_path));
    // Path-traversal guard (DB chỉ chứa data từ chính server, nhưng vẫn defense-in-depth)
    if (!abs.startsWith(rootResolved + path.sep) && abs !== rootResolved) {
      console.warn(`[inline-image] path traversal blocked: ${row.storage_path}`);
      return;
    }

    // Pre-check size (có thể null trong DB → đành đọc rồi check)
    if (typeof row.size_bytes === 'number' && row.size_bytes > INLINE_IMAGE_MAX_BYTES) {
      console.warn(
        `[inline-image] skip "${row.file_name}" (${row.size_bytes} > ${INLINE_IMAGE_MAX_BYTES} bytes cap)`,
      );
      return;
    }

    let buffer;
    try {
      buffer = await fs.readFile(abs);
    } catch (e) {
      console.warn(`[inline-image] read failed for "${row.file_name}": ${e.message}`);
      return;
    }
    if (buffer.length > INLINE_IMAGE_MAX_BYTES) {
      console.warn(
        `[inline-image] skip "${row.file_name}" after-read (${buffer.length} > ${INLINE_IMAGE_MAX_BYTES} bytes cap)`,
      );
      return;
    }

    out.set(row.id, {
      mimeType:   String(row.mime_type).toLowerCase().trim(),
      base64Data: buffer.toString('base64'),
      file_name:  row.file_name,
      sizeBytes:  buffer.length,
    });
  }));

  return out;
};

export const getUploadRoot       = () => UPLOAD_ROOT;
export const getMaxBytes         = () => MAX_BYTES;
export const getInlineImageMaxBytes = () => INLINE_IMAGE_MAX_BYTES;
export const getFileSize         = fileSizeOf;
