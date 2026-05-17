/**
 * src/routes/emails.js
 *
 * THAY ĐỔI 2025-05-02:
 *  - GET /api/emails: list dedup theo thread (UI list).
 *  - GET /api/emails/all: trả TẤT CẢ messages (không dedup) — dành cho client
 *    sync về Room. Sau khi cache full, click email render thread instant.
 *  - GET /api/emails/:id/thread: query messages cùng thread, time <= anchor.
 */

import express                       from 'express';
import { requireAuth }               from '../middleware/authMiddleware.js';
import { query }                     from '../config/db.js';
import { syncEmailsForUser }         from '../services/emailSyncService.js';

const router = express.Router();

const EMAIL_LIST_FIELDS = `
  e.id, e.account_id, e.gmail_message_id, e.gmail_thread_id,
  e.sender, e.recipient, e.subject, e.snippet,
  e.deep_link_intent, e.received_at, e.is_deleted, e.mod_time,
  a.username_or_email AS account_email
`;

const EMAIL_FULL_FIELDS = `
  ${EMAIL_LIST_FIELDS},
  e.body_text, e.body_html
`;

// Helper: build WHERE từ query params
const buildWhereClauses = (req, startIdx) => {
  const { account_id, q, from, to, include_deleted = 'false' } = req.query;
  const conditions = ['uac.user_id = $1'];
  const params     = [req.user.id];
  let   idx        = startIdx;

  if (include_deleted !== 'true') conditions.push('e.is_deleted = FALSE');
  if (account_id) { conditions.push(`e.account_id = $${idx++}`); params.push(account_id); }
  if (from)       { conditions.push(`e.received_at >= $${idx++}`); params.push(from); }
  if (to)         { conditions.push(`e.received_at <= $${idx++}`); params.push(to); }
  if (q) {
    conditions.push(`(e.sender ILIKE $${idx} OR e.subject ILIKE $${idx} OR e.snippet ILIKE $${idx})`);
    params.push(`%${q}%`);
    idx++;
  }
  return { where: conditions.join(' AND '), params, nextIdx: idx };
};

// ─── GET /api/emails — UI list, dedup theo thread ──────
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const safePage  = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const safeLimit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    const offset    = (safePage - 1) * safeLimit;

    const built = buildWhereClauses(req, 2);
    let idx = built.nextIdx;
    const dataParams  = [...built.params, safeLimit, offset];

    // Postgres DISTINCT ON: với mỗi (thread_id), giữ row có ORDER BY đầu tiên
    // (= received_at DESC → message mới nhất). COALESCE để email không có
    // thread_id thì coi mỗi message là thread riêng.
    const dataSql = `
      SELECT * FROM (
        SELECT DISTINCT ON (COALESCE(e.gmail_thread_id, e.gmail_message_id))
               ${EMAIL_FULL_FIELDS}
        FROM emails e
        JOIN user_account_cross_ref uac ON uac.account_id = e.account_id
        JOIN accounts a ON a.id = e.account_id
        WHERE ${built.where}
        ORDER BY COALESCE(e.gmail_thread_id, e.gmail_message_id),
                 e.received_at DESC
      ) sub
      ORDER BY received_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `;

    const countSql = `
      SELECT COUNT(*) FROM (
        SELECT DISTINCT COALESCE(e.gmail_thread_id, e.gmail_message_id) AS tid
        FROM emails e
        JOIN user_account_cross_ref uac ON uac.account_id = e.account_id
        WHERE ${built.where}
      ) sub
    `;

    const [dataRes, countRes] = await Promise.all([
      query(dataSql, dataParams),
      query(countSql, built.params),
    ]);

    const total     = Number.parseInt(countRes.rows[0].count, 10);
    const totalPage = Math.ceil(total / safeLimit);

    res.json({
      success: true,
      data:    dataRes.rows,
      meta: { total, page: safePage, limit: safeLimit, total_page: totalPage, has_next: safePage < totalPage },
    });
  } catch (err) { next(err); }
});

// ─── GET /api/emails/all — KHÔNG dedup, dùng cho client sync ──
router.get('/all', requireAuth, async (req, res, next) => {
  try {
    const safePage  = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const safeLimit = Math.min(500, Math.max(1, Number.parseInt(req.query.limit, 10) || 200));
    const offset    = (safePage - 1) * safeLimit;

    const built = buildWhereClauses(req, 2);
    let idx = built.nextIdx;

    const [dataRes, countRes] = await Promise.all([
      query(
        `SELECT ${EMAIL_FULL_FIELDS}
         FROM emails e
         JOIN user_account_cross_ref uac ON uac.account_id = e.account_id
         JOIN accounts a ON a.id = e.account_id
         WHERE ${built.where}
         ORDER BY e.received_at DESC
         LIMIT $${idx++} OFFSET $${idx++}`,
        [...built.params, safeLimit, offset],
      ),
      query(
        `SELECT COUNT(*) FROM emails e
         JOIN user_account_cross_ref uac ON uac.account_id = e.account_id
         WHERE ${built.where}`,
        built.params,
      ),
    ]);

    const total     = Number.parseInt(countRes.rows[0].count, 10);
    const totalPage = Math.ceil(total / safeLimit);

    res.json({
      success: true,
      data:    dataRes.rows,
      meta: { total, page: safePage, limit: safeLimit, total_page: totalPage, has_next: safePage < totalPage },
    });
  } catch (err) { next(err); }
});

// ─── GET /api/emails/:id/thread ────────────────────────
router.get('/:id/thread', requireAuth, async (req, res, next) => {
  try {
    const anchorRes = await query(
      `SELECT e.id, e.gmail_thread_id, e.gmail_message_id, e.received_at, e.account_id
       FROM emails e
       JOIN user_account_cross_ref uac ON uac.account_id = e.account_id
       WHERE e.id = $1 AND uac.user_id = $2`,
      [req.params.id, req.user.id],
    );
    const anchor = anchorRes.rows[0];
    if (!anchor) return res.status(404).json({ success: false, message: 'Email not found.' });

    if (!anchor.gmail_thread_id) {
      const single = await query(
        `SELECT ${EMAIL_FULL_FIELDS}
         FROM emails e
         JOIN accounts a ON a.id = e.account_id
         WHERE e.id = $1`,
        [anchor.id],
      );
      return res.json({
        success: true,
        data: {
          thread_id: anchor.gmail_message_id,
          messages:  single.rows,
        },
      });
    }

    const threadRes = await query(
      `SELECT ${EMAIL_FULL_FIELDS}
       FROM emails e
       JOIN accounts a ON a.id = e.account_id
       JOIN user_account_cross_ref uac ON uac.account_id = e.account_id
       WHERE uac.user_id = $1
         AND e.gmail_thread_id = $2
         AND e.account_id      = $3
         AND e.received_at    <= $4
         AND e.is_deleted = FALSE
       ORDER BY e.received_at ASC`,
      [req.user.id, anchor.gmail_thread_id, anchor.account_id, anchor.received_at],
    );

    res.json({
      success: true,
      data: {
        thread_id: anchor.gmail_thread_id,
        messages:  threadRes.rows,
      },
    });
  } catch (err) { next(err); }
});

// ─── GET /api/emails/:id ───────────────────────────────
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const r = await query(
      `SELECT ${EMAIL_FULL_FIELDS}, a.provider
       FROM emails e
       JOIN accounts a ON a.id = e.account_id
       JOIN user_account_cross_ref uac ON uac.account_id = e.account_id
       WHERE e.id = $1 AND uac.user_id = $2`,
      [req.params.id, req.user.id],
    );
    if (!r.rows[0]) return res.status(404).json({ success: false, message: 'Email not found.' });
    res.json({ success: true, data: r.rows[0] });
  } catch (err) { next(err); }
});

router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const check = await query(
      `SELECT e.id FROM emails e
       JOIN user_account_cross_ref uac ON uac.account_id = e.account_id
       WHERE e.id = $1 AND uac.user_id = $2`,
      [req.params.id, req.user.id],
    );
    if (!check.rows[0]) return res.status(404).json({ success: false, message: 'Email not found.' });

    const r = await query(
      `UPDATE emails SET is_deleted = TRUE, mod_time = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING id, is_deleted, mod_time`,
      [req.params.id],
    );
    res.json({ success: true, data: r.rows[0] });
  } catch (err) { next(err); }
});

router.post('/sync', requireAuth, async (req, res, next) => {
  try {
    const { account_id } = req.body;
    if (account_id) {
      const check = await query(
        `SELECT 1 FROM user_account_cross_ref WHERE user_id = $1 AND account_id = $2`,
        [req.user.id, account_id],
      );
      if (!check.rows[0]) {
        return res.status(403).json({ success: false, message: 'Account not found or does not belong to you.' });
      }
    }
    const result = await syncEmailsForUser(req.user.id);
    const total  = result.accounts?.reduce((s, a) => s + (a.new_emails ?? 0), 0) ?? 0;
    res.json({
      success: true,
      message: `Sync complete. ${total} new email(s) fetched.`,
      data:    result,
    });
  } catch (err) { next(err); }
});

export default router;
