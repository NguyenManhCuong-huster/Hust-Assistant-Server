import express from 'express';

import { requireAuth } from '../middleware/authMiddleware.js';
import { query }       from '../config/db.js';
import { syncNews }    from '../services/newsScrapeService.js';
import * as att        from '../services/attachmentService.js';

const router = express.Router();
router.use(requireAuth);

/** Helper: gắn attachments vào mỗi row của 1 list news. */
const attachAttachments = async (newsRows) => {
  if (!newsRows || newsRows.length === 0) return newsRows;
  const ids = newsRows.map((r) => r.id);
  const map = await att.listForOwnersBulk(att.OWNER_NEWS, ids);
  for (const row of newsRows) {
    row.attachments = map.get(row.id) ?? [];
  }
  return newsRows;
};

// ─────────────────────────────────────────────────────────
// GET /api/news
// ─────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { kind, tag, q, page = 1, limit = 20 } = req.query;

    const safePage  = Math.max(1, Number.parseInt(page, 10)  || 1);
    const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));
    const offset    = (safePage - 1) * safeLimit;

    const conditions = ['n.is_deleted = FALSE'];
    const params     = [];

    if (kind) {
      const k = String(kind).toUpperCase();
      if (k !== 'NEWS' && k !== 'PLAN') {
        return res.status(400).json({ success: false, message: 'kind phải là NEWS hoặc PLAN.' });
      }
      conditions.push(`n.kind = $${params.length + 1}`);
      params.push(k);
    }
    if (tag) {
      conditions.push(`n.tag = $${params.length + 1}`);
      params.push(String(tag).toUpperCase());
    }
    if (q) {
      conditions.push(
        `(n.title ILIKE $${params.length + 1} OR n.summary ILIKE $${params.length + 1})`,
      );
      params.push(`%${String(q).trim()}%`);
    }

    const where = conditions.join(' AND ');
    const [list, count] = await Promise.all([
      query(
        `SELECT
           n.id, n.kind, n.title, n.summary, n.article_url, n.image_url, n.tag,
           n.published_at, n.mod_time,
           s.name AS source_name
         FROM news n
         LEFT JOIN news_sources s ON s.id = n.source_id
         WHERE ${where}
         ORDER BY n.published_at DESC NULLS LAST, n.mod_time DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, safeLimit, offset],
      ),
      query(`SELECT COUNT(*) FROM news n WHERE ${where}`, params),
    ]);

    await attachAttachments(list.rows);

    const total     = Number.parseInt(count.rows[0].count, 10);
    const totalPage = Math.ceil(total / safeLimit);
    res.json({
      success: true,
      data:    list.rows,
      meta: {
        total,
        page:       safePage,
        limit:      safeLimit,
        total_page: totalPage,
        has_next:   safePage < totalPage,
      },
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────
// GET /api/news/:id
// ─────────────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const r = await query(
      `SELECT n.id, n.kind, n.title, n.summary, n.article_url, n.image_url, n.tag,
              n.published_at, n.mod_time,
              s.name AS source_name, s.home_url AS source_url
       FROM news n
       LEFT JOIN news_sources s ON s.id = n.source_id
       WHERE n.id = $1 AND n.is_deleted = FALSE`,
      [req.params.id],
    );
    if (!r.rows[0]) return res.status(404).json({ success: false, message: 'Không tìm thấy.' });

    const row = r.rows[0];
    row.attachments = await att.listForOwner(att.OWNER_NEWS, row.id);

    res.json({ success: true, data: row });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────
// GET /api/news/:id/attachments
// ─────────────────────────────────────────────────────────
router.get('/:id/attachments', async (req, res, next) => {
  try {
    const exists = await query(
      'SELECT 1 FROM news WHERE id = $1 AND is_deleted = FALSE',
      [req.params.id],
    );
    if (!exists.rows[0]) {
      return res.status(404).json({ success: false, message: 'News không tồn tại.' });
    }
    const rows = await att.listForOwner(att.OWNER_NEWS, req.params.id);
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────
// POST /api/news/scrape
// ─────────────────────────────────────────────────────────
router.post('/scrape', async (req, res, next) => {
  try {
    const { refetch = false, limit = 50, skipFiles = false } = req.body ?? {};
    const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 50));
    const result    = await syncNews({
      refetchExisting: !!refetch,
      limit:           safeLimit,
      skipFiles:       !!skipFiles,
    });
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

export default router;
