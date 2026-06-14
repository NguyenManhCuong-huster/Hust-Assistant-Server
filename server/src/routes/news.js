import express from 'express';

import { requireAuth }                   from '../middleware/authMiddleware.js';
import { query }                         from '../config/db.js';
import { syncNews }                      from '../services/newsScrapeService.js';
import * as att                          from '../services/attachmentService.js';
import * as rec                          from '../services/newsRecommendationService.js';
import { parsePagination, buildPageMeta } from '../utils/paginate.js';
import { AppError }                      from '../utils/AppError.js';

const router = express.Router();
router.use(requireAuth);

// GET /api/news
router.get('/', async (req, res, next) => {
  try {
    const { kind, tag, q } = req.query;
    const { page, limit, offset } = parsePagination(req.query);

    const conditions = ['n.is_deleted = FALSE'];
    const params     = [];

    if (kind) {
      const k = String(kind).toUpperCase();
      if (k !== 'NEWS' && k !== 'PLAN') throw new AppError('kind phải là NEWS hoặc PLAN.', 400);
      conditions.push(`n.kind = $${params.length + 1}`);
      params.push(k);
    }
    if (tag) {
      conditions.push(`n.tag = $${params.length + 1}`);
      params.push(String(tag).toUpperCase());
    }
    if (q) {
      conditions.push(`(n.title ILIKE $${params.length + 1} OR n.summary ILIKE $${params.length + 1})`);
      params.push(`%${String(q).trim()}%`);
    }

    const where = conditions.join(' AND ');
    const [list, count] = await Promise.all([
      query(
        `SELECT n.id, n.kind, n.title, n.summary, n.article_url, n.image_url, n.tag,
                n.published_at, n.mod_time, s.name AS source_name
         FROM news n
         LEFT JOIN news_sources s ON s.id = n.source_id
         WHERE ${where}
         ORDER BY n.published_at DESC NULLS LAST, n.mod_time DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      ),
      query(`SELECT COUNT(*) FROM news n WHERE ${where}`, params),
    ]);

    await att.attachToRows(att.OWNER_NEWS, list.rows);
    const total = Number.parseInt(count.rows[0].count, 10);
    res.json({ success: true, data: list.rows, meta: buildPageMeta(total, page, limit) });
  } catch (err) { next(err); }
});

// GET /api/news/recommendations  — must be before /:id
router.get('/recommendations', async (req, res, next) => {
  try {
    const limit      = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    const recomputed = await rec.ensureFresh(req.user.id);
    const rows       = await rec.getForUser(req.user.id, { limit });
    await att.attachToRows(att.OWNER_NEWS, rows);
    res.json({ success: true, data: rows, meta: { total: rows.length, recomputed } });
  } catch (err) { next(err); }
});

// POST /api/news/recommendations/refresh
router.post('/recommendations/refresh', async (req, res, next) => {
  try {
    const result = await rec.refreshForUser(req.user.id);
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

// POST /api/news/recommendations/:id/dismiss
router.post('/recommendations/:id/dismiss', async (req, res, next) => {
  try {
    const ok = await rec.dismissForUser(req.user.id, req.params.id);
    if (!ok) return res.status(404).json({ success: false, message: 'Không tìm thấy đề xuất.' });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /api/news/:id
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
    r.rows[0].attachments = await att.listForOwner(att.OWNER_NEWS, r.rows[0].id);
    res.json({ success: true, data: r.rows[0] });
  } catch (err) { next(err); }
});

// GET /api/news/:id/attachments
router.get('/:id/attachments', async (req, res, next) => {
  try {
    const exists = await query('SELECT 1 FROM news WHERE id = $1 AND is_deleted = FALSE', [req.params.id]);
    if (!exists.rows[0]) return res.status(404).json({ success: false, message: 'News không tồn tại.' });
    const rows = await att.listForOwner(att.OWNER_NEWS, req.params.id);
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// POST /api/news/scrape
router.post('/scrape', async (req, res, next) => {
  try {
    const { refetch = false, limit = 50, skipFiles = false } = req.body ?? {};
    const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 50));
    const result    = await syncNews({ refetchExisting: !!refetch, limit: safeLimit, skipFiles: !!skipFiles });
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

export default router;
