/**
 * src/services/emailSyncService.js
 *
 * THAY ĐỔI 2025-05-02: 1 row = 1 message. Insert mỗi message thành 1 row.
 */

import { query, getClient }              from '../config/db.js';
import { decrypt, encrypt }              from '../config/crypto.js';
import { fetchNewEmails, refreshAccessToken,
         extractTokens }                 from './gmailService.js';

const DEFAULT_SINCE_FALLBACK_DAYS = 7;

const getLinkedGmailAccounts = async (userId) => {
  const sql = userId
    ? `SELECT a.id, a.username_or_email, a.access_token, a.status
       FROM accounts a
       JOIN user_account_cross_ref uac ON uac.account_id = a.id
       WHERE uac.user_id = $1 AND a.provider = 'GMAIL' AND a.status = 'ACTIVE'`
    : `SELECT a.id, a.username_or_email, a.access_token, a.status
       FROM accounts a
       WHERE a.provider = 'GMAIL' AND a.status = 'ACTIVE'`;
  const res = await query(sql, userId ? [userId] : []);
  return res.rows;
};

const getLastSyncTime = async (accountId) => {
  const res = await query(
    `SELECT MAX(received_at) AS last_time FROM emails
     WHERE account_id = $1 AND is_deleted = FALSE`,
    [accountId],
  );
  if (res.rows[0]?.last_time) return new Date(res.rows[0].last_time);
  const fallback = new Date();
  fallback.setDate(fallback.getDate() - DEFAULT_SINCE_FALLBACK_DAYS);
  return fallback;
};

/**
 * upsertEmails: 1 row = 1 message Gmail.
 *
 * ON CONFLICT (account_id, gmail_message_id) → message đã tồn tại, update
 * các field có thể đổi (vd subject thường không đổi, nhưng body_text có thể
 * đã được Gmail update sau cùng — refresh để chắc).
 */
const upsertEmails = async (client, accountId, messages) => {
  const inserted = [];
  for (const msg of messages) {
    const {
      gmail_message_id, gmail_thread_id,
      sender, recipient, subject, snippet,
      body_text, body_html,
      deep_link_intent, received_at,
    } = msg;

    const res = await client.query(
      `INSERT INTO emails
         (account_id, gmail_message_id, gmail_thread_id,
          sender, recipient, subject, snippet,
          body_text, body_html,
          deep_link_intent, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (account_id, gmail_message_id) DO UPDATE SET
         gmail_thread_id  = COALESCE(EXCLUDED.gmail_thread_id, emails.gmail_thread_id),
         sender           = COALESCE(EXCLUDED.sender, emails.sender),
         recipient        = COALESCE(EXCLUDED.recipient, emails.recipient),
         subject          = COALESCE(EXCLUDED.subject, emails.subject),
         snippet          = COALESCE(EXCLUDED.snippet, emails.snippet),
         body_text        = EXCLUDED.body_text,
         body_html        = EXCLUDED.body_html,
         deep_link_intent = EXCLUDED.deep_link_intent,
         received_at      = COALESCE(EXCLUDED.received_at, emails.received_at)
       RETURNING id, (xmax = 0) AS inserted`,
      [
        accountId, gmail_message_id, gmail_thread_id,
        sender, recipient, subject, snippet,
        body_text, body_html,
        deep_link_intent, received_at,
      ],
    );
    if (res.rows[0]?.inserted) inserted.push(res.rows[0].id);
  }
  return inserted;
};

const updateAccessToken = async (accountId, oldBlob, newAccessToken) => {
  let existingRefreshToken = null;
  try {
    existingRefreshToken = JSON.parse(oldBlob).refresh_token ?? null;
  } catch { /* legacy */ }

  const newBlob = encrypt(JSON.stringify({
    access_token:  newAccessToken,
    refresh_token: existingRefreshToken,
  }));
  await query(
    `UPDATE accounts SET access_token = $1, status = 'ACTIVE' WHERE id = $2`,
    [newBlob, accountId],
  );
};

const markAccountExpired = (accountId) =>
  query("UPDATE accounts SET status='EXPIRED' WHERE id=$1", [accountId]);

export const syncEmailsForUser = async (userId = null) => {
  const accounts = await getLinkedGmailAccounts(userId);
  if (accounts.length === 0) {
    return { synced: 0, accounts: [], message: 'No active Gmail accounts found.' };
  }

  const summary = [];

  for (const account of accounts) {
    const result = { account_id: account.id, email: account.username_or_email };

    try {
      const decryptedBlob           = decrypt(account.access_token);
      let   { accessToken, refreshToken } = extractTokens(decryptedBlob);
      const sinceDate               = await getLastSyncTime(account.id);

      let emails;
      try {
        emails = await fetchNewEmails(accessToken, sinceDate);
      } catch (err) {
        if (err.code !== 'TOKEN_EXPIRED') throw err;
        if (!refreshToken) {
          await markAccountExpired(account.id);
          result.status     = 'token_expired';
          result.new_emails = 0;
          result.message    = 'Access token expired and no refresh token stored.';
          summary.push(result);
          continue;
        }
        let refreshed;
        try {
          refreshed = await refreshAccessToken(refreshToken);
        } catch (refreshErr) {
          await markAccountExpired(account.id);
          result.status     = 'refresh_failed';
          result.new_emails = 0;
          result.message    = refreshErr.message;
          summary.push(result);
          continue;
        }
        await updateAccessToken(account.id, decryptedBlob, refreshed.access_token);
        accessToken = refreshed.access_token;
        emails      = await fetchNewEmails(accessToken, sinceDate);
      }

      const client = await getClient();
      try {
        await client.query('BEGIN');
        const inserted = await upsertEmails(client, account.id, emails);
        await client.query('COMMIT');
        result.status     = 'ok';
        result.new_emails = inserted.length;
        result.since      = sinceDate.toISOString();
      } catch (dbErr) {
        await client.query('ROLLBACK');
        throw dbErr;
      } finally {
        client.release();
      }

    } catch (err) {
      console.error(`[EmailSync] account ${account.id}:`, err.message);
      result.status = 'error';
      result.error  = err.message;
    }

    summary.push(result);
  }

  return {
    synced:   summary.filter((s) => s.status === 'ok').length,
    accounts: summary,
  };
};

let _pollingTimer = null;

export const startPolling = (intervalMs = 5 * 60 * 1000) => {
  if (_pollingTimer) return;
  console.log(`[EmailSync] Polling every ${intervalMs / 1000}s`);
  const tick = async () => {
    try {
      const r = await syncEmailsForUser(null);
      const total = r.accounts.reduce((s, a) => s + (a.new_emails ?? 0), 0);
      if (total > 0) console.log(`[EmailSync] ${total} new email(s) fetched`);
    } catch (err) {
      console.error('[EmailSync] Poll error:', err.message);
    }
  };
  tick();
  _pollingTimer = setInterval(tick, intervalMs);
  _pollingTimer.unref?.();
};

export const stopPolling = () => {
  if (_pollingTimer) { clearInterval(_pollingTimer); _pollingTimer = null; }
};
