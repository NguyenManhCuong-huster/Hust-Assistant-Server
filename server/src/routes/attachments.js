import express from 'express';

import { requireAuth }       from '../middleware/authMiddleware.js';
import { query }             from '../config/db.js';
import * as att              from '../services/attachmentService.js';

const router = express.Router();
router.use(requireAuth);

const fileNameForHeader = (raw) =>
  encodeURIComponent(raw || 'file').replace(/['()]/g, escape);

// ─── GET /api/attachments/:id/meta ──────────────────────
router.get('/:id/meta', async (req, res, next) => {
  try {
    const row = await att.getAttachmentForUser(req.params.id, req.user.id);
    if (!row) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy hoặc không có quyền.' });
    }
    res.json({
      success: true,
      data: {
        id:            row.id,
        owner_type:    row.owner_type,
        owner_id:      row.owner_id,
        file_name:     row.file_name,
        mime_type:     row.mime_type,
        size_bytes:    row.size_bytes,
        is_downloaded: !!row.storage_path,
      },
    });
  } catch (err) { next(err); }
});

// ─── GET /api/attachments/:id/download ──────────────────
router.get('/:id/download', async (req, res, next) => {
  try {
    const row = await att.getAttachmentForUser(req.params.id, req.user.id);
    if (!row) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy hoặc không có quyền.' });
    }
    if (!row.storage_path) {
      return res.status(404).json({
        success: false,
        message: 'File chưa được tải xuống. Vui lòng thử lại sau.',
      });
    }

    let stream;
    try {
      ({ stream } = att.openReadStream(row.storage_path));
    } catch (e) {
      console.warn(`[attachments] missing file on disk for ${row.id}: ${e.message}`);
      return res.status(404).json({ success: false, message: 'File không còn trên server.' });
    }

    res.setHeader('Content-Type',        row.mime_type || 'application/octet-stream');
    if (row.size_bytes) res.setHeader('Content-Length', row.size_bytes);
    // Inline preview nếu là image / PDF, attachment cho phần còn lại.
    const isPreviewable = /^(image\/|application\/pdf)/.test(row.mime_type || '');
    const disposition   = isPreviewable ? 'inline' : 'attachment';
    res.setHeader(
      'Content-Disposition',
      `${disposition}; filename*=UTF-8''${fileNameForHeader(row.file_name)}`,
    );

    stream.on('error', (err) => {
      console.error(`[attachments] stream error for ${row.id}:`, err.message);
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    stream.pipe(res);
  } catch (err) { next(err); }
});

// ─── GET /api/attachments/by-owner ──────────────────────
// Optional helper cho client: list theo owner_type + owner_id (không qua
// /api/emails/:id/attachments). Hữu ích khi client biết id email/news rồi.
router.get('/by-owner', async (req, res, next) => {
  try {
    const { owner_type, owner_id } = req.query;
    if (!owner_type || !owner_id) {
      return res.status(400).json({ success: false, message: 'owner_type + owner_id required.' });
    }
    if (owner_type !== att.OWNER_EMAIL && owner_type !== att.OWNER_NEWS) {
      return res.status(400).json({ success: false, message: 'owner_type must be EMAIL or NEWS.' });
    }
    // Quyền: NEWS public với mọi user-logged-in; EMAIL chỉ chủ.
    if (owner_type === att.OWNER_EMAIL) {
      const ok = await query(
        `SELECT 1 FROM emails e
           JOIN user_account_cross_ref uac ON uac.account_id = e.account_id
          WHERE e.id = $1 AND uac.user_id = $2`,
        [owner_id, req.user.id],
      );
      if (!ok.rows[0]) {
        return res.status(404).json({ success: false, message: 'Email không tồn tại hoặc không có quyền.' });
      }
    }
    const rows = await att.listForOwner(owner_type, owner_id);
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

export default router;
