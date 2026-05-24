import fs       from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path     from 'node:path';

import { query } from '../config/db.js';

const UPLOAD_ROOT = process.env.UPLOAD_ROOT ?? '/app/uploads';
const MAX_BYTES   = Number.parseInt(process.env.MAX_ATTACHMENT_BYTES, 10) || 25 * 1024 * 1024;

export const OWNER_EMAIL = 'EMAIL';
export const OWNER_NEWS  = 'NEWS';

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
 *
 * Dùng khi: ta đã biết file tồn tại nhưng chưa kịp / không muốn download
 * (vd file quá lớn). UI sẽ thấy chip "có file" nhưng tap → server trả 404
 * cho đến khi background job fill `storage_path`.
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
 *
 * Buffer > MAX_BYTES → throw, caller sẽ catch và chỉ ghi metadata (không
 * có storage_path).
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

/**
 * Download URL public → lưu xuống đĩa + DB.
 *
 * Resilient: HTTP error / size cap exceeded → ghi metadata-only (không
 * storage_path). Caller (newsScrapeService) tự log warning.
 */
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
 * Trả về shape khớp UI / DTO bên client.
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
 * Bulk list cho NHIỀU owner cùng loại (giảm N+1 khi list trang email/news).
 * Trả Map<owner_id, Array<row>>.
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
 *  - NEWS attachment: ai cũng có thể tải (news là public).
 *  - EMAIL attachment: chỉ user link với account đó được tải.
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

  if (row.owner_type === OWNER_NEWS) return row;     // public

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
 * Trả absolute path + tạo read stream. Throw nếu file thiếu trên đĩa.
 */
export const openReadStream = (storagePath) => {
  if (!storagePath) throw new Error('storage_path is null (file not yet downloaded)');
  const abs = path.join(UPLOAD_ROOT, storagePath);
  // Bảo vệ path-traversal: abs phải nằm dưới UPLOAD_ROOT
  if (!abs.startsWith(path.resolve(UPLOAD_ROOT) + path.sep) && abs !== path.resolve(UPLOAD_ROOT)) {
    // path.join sẽ tự resolve '..', nhưng double-check phòng case sanitize miss.
    const resolved = path.resolve(abs);
    const root     = path.resolve(UPLOAD_ROOT);
    if (!resolved.startsWith(root + path.sep)) {
      throw new Error('path traversal detected');
    }
  }
  return { absPath: abs, stream: createReadStream(abs) };
};

export const getUploadRoot   = () => UPLOAD_ROOT;
export const getMaxBytes     = () => MAX_BYTES;
export const getFileSize     = fileSizeOf;
