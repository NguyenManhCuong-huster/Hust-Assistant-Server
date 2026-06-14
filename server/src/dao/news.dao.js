import { query } from '../shared/database/db.js';
import { AppError } from '../shared/utils/AppError.js';

const NEWS_FIELDS = `
  n.id, n.kind, n.title, n.summary, n.article_url, n.image_url, n.tag,
  n.published_at, n.mod_time, s.name AS source_name
`;

export const listNews = async (queryParams, limit, offset) => {
  const { kind, tag, q } = queryParams;
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
  return Promise.all([
    query(
      `SELECT ${NEWS_FIELDS}
       FROM news n
       LEFT JOIN news_sources s ON s.id = n.source_id
       WHERE ${where}
       ORDER BY n.published_at DESC NULLS LAST, n.mod_time DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    ),
    query(`SELECT COUNT(*) FROM news n WHERE ${where}`, params),
  ]);
};

export const getNewsById = async (newsId) => {
  const r = await query(
    `SELECT ${NEWS_FIELDS}, s.home_url AS source_url
     FROM news n
     LEFT JOIN news_sources s ON s.id = n.source_id
     WHERE n.id = $1 AND n.is_deleted = FALSE`,
    [newsId],
  );
  return r.rows[0] ?? null;
};

export const checkNewsExists = async (newsId) => {
  const r = await query('SELECT 1 FROM news WHERE id = $1 AND is_deleted = FALSE', [newsId]);
  return !!r.rows[0];
};
