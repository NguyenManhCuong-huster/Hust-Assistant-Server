import { query, getClient }              from '../../shared/database/db.js';
import { decrypt, encrypt }              from '../../infrastructure/crypto.js';
import { fetchNewEmails, refreshAccessToken,
         extractTokens, getAttachmentBytes } from './emails.gmail.js';
import * as att                          from '../attachments/attachments.service.js';

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
 * Trả mảng `{ emailId, gmailMessageId, attachments }` cho TẤT CẢ message
 * (cả mới insert lẫn update) — để caller decide có download attachment hay không.
 * Hiện tại: download ngay nếu attachment row chưa có storage_path.
 */
const upsertEmails = async (client, accountId, messages) => {
  const out = [];
  for (const msg of messages) {
    const {
      gmail_message_id, gmail_thread_id,
      sender, recipient, subject, snippet,
      body_text, body_html,
      deep_link_intent, received_at,
      attachments,
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
    out.push({
      emailId:          res.rows[0].id,
      inserted:         res.rows[0].inserted,
      gmailMessageId:   gmail_message_id,
      attachments:      attachments ?? [],
    });
  }
  return out;
};

/**
 * Cho mỗi attachment trong email, kiểm tra DB:
 *   • Đã có row + đã có storage_path → bỏ qua (đã download trước đó).
 *   • Chưa có / chưa download → fetch bytes từ Gmail + lưu đĩa + upsert.
 *
 * Resilient: 1 file fail → log warn, không throw.
 */
const downloadAttachments = async (accessToken, items) => {
  let downloaded = 0;
  let skipped    = 0;
  let failed     = 0;

  for (const it of items) {
    if (!it.attachments || it.attachments.length === 0) continue;

    for (const a of it.attachments) {
      try {
        // Upsert metadata trước (có attachments id cho UI ngay cả khi
        // download fail). storage_path để null lúc đầu.
        await att.upsertMetadata({
          ownerType:         att.OWNER_EMAIL,
          ownerId:           it.emailId,
          fileName:          a.filename,
          mimeType:          a.mimeType,
          sizeBytes:         a.sizeBytes,
          gmailAttachmentId: a.gmailAttachmentId,
          isInline:          a.isInline,
        });

        // Check: đã có file trên đĩa chưa?
        const existing = await query(
          `SELECT storage_path FROM attachments
            WHERE owner_type = 'EMAIL' AND owner_id = $1
              AND gmail_attachment_id = $2 AND is_deleted = FALSE`,
          [it.emailId, a.gmailAttachmentId],
        );
        if (existing.rows[0]?.storage_path) { skipped++; continue; }

        // Cap nhanh theo declared size
        if (a.sizeBytes && a.sizeBytes > att.getMaxBytes()) {
          console.warn(`[EmailSync] skip large attachment ${a.filename} (${a.sizeBytes}b)`);
          skipped++; continue;
        }

        const buf = await getAttachmentBytes(accessToken, it.gmailMessageId, a.gmailAttachmentId);
        await att.saveBuffer({
          ownerType:         att.OWNER_EMAIL,
          ownerId:           it.emailId,
          fileName:          a.filename,
          mimeType:          a.mimeType,
          buffer:            buf,
          gmailAttachmentId: a.gmailAttachmentId,
          isInline:          a.isInline,
        });
        downloaded++;
      } catch (e) {
        console.warn(`[EmailSync] attachment fail ${a.filename}: ${e.message}`);
        failed++;
      }
    }
  }
  return { downloaded, skipped, failed };
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
      let upserted;
      try {
        await client.query('BEGIN');
        upserted = await upsertEmails(client, account.id, emails);
        await client.query('COMMIT');
        result.status     = 'ok';
        result.new_emails = upserted.filter((u) => u.inserted).length;
        result.since      = sinceDate.toISOString();
      } catch (dbErr) {
        await client.query('ROLLBACK');
        throw dbErr;
      } finally {
        client.release();
      }

      // ── Attachments: download SAU khi commit email rows ──
      // Quan trọng: ngoài transaction để 1 file fail không rollback email.
      if (upserted && upserted.length > 0) {
        const attRes = await downloadAttachments(accessToken, upserted);
        result.attachments_downloaded = attRes.downloaded;
        result.attachments_failed     = attRes.failed;
        result.attachments_skipped    = attRes.skipped;
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
      const files = r.accounts.reduce((s, a) => s + (a.attachments_downloaded ?? 0), 0);
      if (total > 0 || files > 0) {
        console.log(`[EmailSync] ${total} new email(s), ${files} attachment(s) fetched`);
      }
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
