import { parsePagination, buildPageMeta } from '../../shared/utils/paginate.js';
import * as repo from '../../dao/news.dao.js';
import * as rec  from './news.service.js';
import * as att  from '../attachments/attachments.service.js';
import { syncNews } from './news.scraper.js';

export const listNews = async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query);
    const [list, count] = await repo.listNews(req.query, limit, offset);
    await att.attachToRows(att.OWNER_NEWS, list.rows);
    const total = Number.parseInt(count.rows[0].count, 10);
    res.json({ success: true, data: list.rows, meta: buildPageMeta(total, page, limit) });
  } catch (err) { next(err); }
};

export const getRecommendations = async (req, res, next) => {
  try {
    const limit      = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    const recomputed = await rec.ensureFresh(req.user.id);
    const rows       = await rec.getForUser(req.user.id, { limit });
    await att.attachToRows(att.OWNER_NEWS, rows);
    res.json({ success: true, data: rows, meta: { total: rows.length, recomputed } });
  } catch (err) { next(err); }
};

export const refreshRecommendations = async (req, res, next) => {
  try {
    const result = await rec.refreshForUser(req.user.id);
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
};

export const dismissRecommendation = async (req, res, next) => {
  try {
    const ok = await rec.dismissForUser(req.user.id, req.params.id);
    if (!ok) return res.status(404).json({ success: false, message: 'Không tìm thấy đề xuất.' });
    res.json({ success: true });
  } catch (err) { next(err); }
};

export const getNews = async (req, res, next) => {
  try {
    const row = await repo.getNewsById(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Không tìm thấy.' });
    row.attachments = await att.listForOwner(att.OWNER_NEWS, row.id);
    res.json({ success: true, data: row });
  } catch (err) { next(err); }
};

export const getNewsAttachments = async (req, res, next) => {
  try {
    const exists = await repo.checkNewsExists(req.params.id);
    if (!exists) return res.status(404).json({ success: false, message: 'News không tồn tại.' });
    const rows = await att.listForOwner(att.OWNER_NEWS, req.params.id);
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

export const scrapeNews = async (req, res, next) => {
  try {
    const { refetch = false, limit = 50, skipFiles = false } = req.body ?? {};
    const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 50));
    const result    = await syncNews({ refetchExisting: !!refetch, limit: safeLimit, skipFiles: !!skipFiles });
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
};
