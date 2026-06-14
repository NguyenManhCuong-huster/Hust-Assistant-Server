import { query } from '../shared/database/db.js';

export const EMAIL_LIST_FIELDS = `
  e.id, e.account_id, e.gmail_message_id, e.gmail_thread_id,
  e.sender, e.recipient, e.subject, e.snippet,
  e.deep_link_intent, e.received_at, e.is_deleted, e.mod_time,
  a.username_or_email AS account_email
`;

export const EMAIL_FULL_FIELDS = `
  ${EMAIL_LIST_FIELDS},
  e.body_text, e.body_html
`;

export const buildWhere = (userId, queryParams, startIdx = 2) => {
  const { account_id, q, from, to, include_deleted = 'false' } = queryParams;
  const conditions = ['uac.user_id = $1'];
  const params     = [userId];
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

export const listThreaded = async (built, limit, offset) => {
  let idx = built.nextIdx;
  return Promise.all([
    query(
      `SELECT * FROM (
         SELECT DISTINCT ON (COALESCE(e.gmail_thread_id, e.gmail_message_id))
                ${EMAIL_FULL_FIELDS}
         FROM emails e
         JOIN user_account_cross_ref uac ON uac.account_id = e.account_id
         JOIN accounts a ON a.id = e.account_id
         WHERE ${built.where}
         ORDER BY COALESCE(e.gmail_thread_id, e.gmail_message_id), e.received_at DESC
       ) sub ORDER BY received_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...built.params, limit, offset],
    ),
    query(
      `SELECT COUNT(*) FROM (
         SELECT DISTINCT COALESCE(e.gmail_thread_id, e.gmail_message_id) AS tid
         FROM emails e
         JOIN user_account_cross_ref uac ON uac.account_id = e.account_id
         WHERE ${built.where}
       ) sub`,
      built.params,
    ),
  ]);
};

export const listFlat = async (built, limit, offset) => {
  let idx = built.nextIdx;
  return Promise.all([
    query(
      `SELECT ${EMAIL_FULL_FIELDS}
       FROM emails e
       JOIN user_account_cross_ref uac ON uac.account_id = e.account_id
       JOIN accounts a ON a.id = e.account_id
       WHERE ${built.where}
       ORDER BY e.received_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...built.params, limit, offset],
    ),
    query(
      `SELECT COUNT(*) FROM emails e
       JOIN user_account_cross_ref uac ON uac.account_id = e.account_id
       WHERE ${built.where}`,
      built.params,
    ),
  ]);
};

export const getEmailAnchor = async (emailId, userId) => {
  const r = await query(
    `SELECT e.id, e.gmail_thread_id, e.gmail_message_id, e.received_at, e.account_id
     FROM emails e
     JOIN user_account_cross_ref uac ON uac.account_id = e.account_id
     WHERE e.id = $1 AND uac.user_id = $2`,
    [emailId, userId],
  );
  return r.rows[0] ?? null;
};

export const getThread = async (anchor, userId) => {
  if (!anchor.gmail_thread_id) {
    const r = await query(
      `SELECT ${EMAIL_FULL_FIELDS} FROM emails e JOIN accounts a ON a.id = e.account_id WHERE e.id = $1`,
      [anchor.id],
    );
    return r.rows;
  }
  const r = await query(
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
    [userId, anchor.gmail_thread_id, anchor.account_id, anchor.received_at],
  );
  return r.rows;
};

export const getEmailById = async (emailId, userId) => {
  const r = await query(
    `SELECT ${EMAIL_FULL_FIELDS}, a.provider
     FROM emails e
     JOIN accounts a ON a.id = e.account_id
     JOIN user_account_cross_ref uac ON uac.account_id = e.account_id
     WHERE e.id = $1 AND uac.user_id = $2`,
    [emailId, userId],
  );
  return r.rows[0] ?? null;
};

export const checkEmailAccess = async (emailId, userId) => {
  const r = await query(
    `SELECT 1 FROM emails e
     JOIN user_account_cross_ref uac ON uac.account_id = e.account_id
     WHERE e.id = $1 AND uac.user_id = $2`,
    [emailId, userId],
  );
  return !!r.rows[0];
};

export const softDeleteEmail = async (emailId) => {
  const r = await query(
    `UPDATE emails SET is_deleted = TRUE, mod_time = CURRENT_TIMESTAMP
     WHERE id = $1 RETURNING id, is_deleted, mod_time`,
    [emailId],
  );
  return r.rows[0];
};

export const checkAccountAccess = async (userId, accountId) => {
  const r = await query(
    'SELECT 1 FROM user_account_cross_ref WHERE user_id = $1 AND account_id = $2',
    [userId, accountId],
  );
  return !!r.rows[0];
};
