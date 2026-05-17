/**
 * src/services/gmailService.js
 *
 * THAY ĐỔI 2025-05-02:
 *  - Schema: 1 row email = 1 message → fetchNewEmails trả về MỌI message
 *    (không dedup theo thread).
 *  - parseFullMessage shape khớp cột DB: gmail_message_id, gmail_thread_id,
 *    sender, recipient, subject, body_text, body_html, ...
 */

import { query }            from '../config/db.js';
import { encrypt, decrypt } from '../config/crypto.js';

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

// ─── Token blob helpers ───────────────────────────────────────
export const extractTokens = (decryptedBlob) => {
  try {
    const parsed = JSON.parse(decryptedBlob);
    return {
      accessToken:  parsed.access_token  ?? null,
      refreshToken: parsed.refresh_token ?? null,
    };
  } catch {
    return { accessToken: decryptedBlob, refreshToken: null };
  }
};

const gmailFetch = async (accessToken, path, params = {}) => {
  const url = new URL(`${GMAIL_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) url.searchParams.append(k, item);
    } else {
      url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 401) {
    const err = new Error('Gmail access token expired or revoked.');
    err.code  = 'TOKEN_EXPIRED';
    throw err;
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gmail API error ${res.status}: ${body}`);
  }
  return res.json();
};

const headerOf = (msg, name) => {
  const h = msg.payload?.headers ?? [];
  return h.find((x) => x.name.toLowerCase() === name.toLowerCase())?.value ?? null;
};

const buildGmailWebLink = (id) => `https://mail.google.com/mail/u/0/#all/${id}`;

const decodeBase64Url = (b64) => {
  if (!b64) return '';
  const standard = b64.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(standard, 'base64').toString('utf-8');
};

const extractBody = (payload) => {
  if (!payload) return { text: '', html: '' };
  if (!payload.parts || payload.parts.length === 0) {
    const data = decodeBase64Url(payload.body?.data);
    if (payload.mimeType === 'text/html') return { text: '', html: data };
    return { text: data, html: '' };
  }
  let text = '';
  let html = '';
  const walk = (parts) => {
    for (const p of parts) {
      if (p.parts && p.parts.length > 0) walk(p.parts);
      const data = decodeBase64Url(p.body?.data);
      if (!data) continue;
      if (p.mimeType === 'text/plain' && !text) text = data;
      else if (p.mimeType === 'text/html' && !html) html = data;
    }
  };
  walk(payload.parts);
  return { text, html };
};

/**
 * parseFullMessage — trả shape khớp với cột DB. Dùng cả lúc sync và lúc
 * fetch thread cho route /thread (giờ đọc DB nên route không gọi nữa,
 * nhưng giữ nguyên cho future use case).
 */
const parseFullMessage = (msg) => {
  const { text, html } = extractBody(msg.payload);
  const dateHeader = headerOf(msg, 'Date');
  const receivedAt = dateHeader
    ? new Date(dateHeader).toISOString()
    : msg.internalDate
      ? new Date(Number(msg.internalDate)).toISOString()
      : null;
  const linkId = msg.threadId ?? msg.id;
  return {
    gmail_message_id: msg.id,
    gmail_thread_id:  msg.threadId ?? null,
    sender:           headerOf(msg, 'From'),
    recipient:        headerOf(msg, 'To'),
    subject:          headerOf(msg, 'Subject'),
    snippet:          msg.snippet ?? null,
    body_text:        text,
    body_html:        html,
    deep_link_intent: buildGmailWebLink(linkId),
    received_at:      receivedAt,
  };
};

// ─── Public API ───────────────────────────────────────────────

export const listMessageIds = async (accessToken, sinceDate, maxResults = 50) => {
  const afterEpoch = Math.floor(new Date(sinceDate).getTime() / 1000);
  const data = await gmailFetch(accessToken, '/messages', {
    q:          `after:${afterEpoch}`,
    maxResults,
    fields:     'messages(id),nextPageToken',
  });
  return data.messages ?? [];
};

export const getFullMessage = async (accessToken, messageId) => {
  const msg = await gmailFetch(accessToken, `/messages/${messageId}`, {
    format: 'full',
  });
  return parseFullMessage(msg);
};

/**
 * fetchNewEmails — pull mọi message mới từ sau sinceDate, KÈM body.
 *
 * 1 message = 1 row sau khi upsertEmails. Server không dedup theo thread —
 * khi list email, route /api/emails sẽ dedup ở SQL.
 *
 * Cost: 50 message = 50 + 1 = 51 API call. Free quota Gmail rất rộng.
 */
export const fetchNewEmails = async (accessToken, sinceDate, maxResults = 50) => {
  const ids = await listMessageIds(accessToken, sinceDate, maxResults);
  if (ids.length === 0) return [];

  const results = await Promise.allSettled(
    ids.map(({ id }) => getFullMessage(accessToken, id)),
  );

  const emails = [];
  const errors = [];
  for (const r of results) {
    if (r.status === 'fulfilled') emails.push(r.value);
    else                          errors.push(r.reason?.message);
  }
  if (errors.length > 0) console.warn('[Gmail] Partial fetch errors:', errors);
  return emails;
};

export const refreshAccessToken = async (refreshToken) => {
  if (!refreshToken) throw new Error('No refresh_token available. User must re-link account.');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    const err  = new Error(`Token refresh failed: ${body}`);
    err.code   = 'REFRESH_FAILED';
    throw err;
  }
  return res.json();
};

export const refreshAndPersistAccessToken = async (accountId, refreshToken) => {
  const refreshed = await refreshAccessToken(refreshToken);
  const newBlob = encrypt(JSON.stringify({
    access_token:  refreshed.access_token,
    refresh_token: refreshToken,
  }));
  await query(
    `UPDATE accounts SET access_token = $1, status = 'ACTIVE' WHERE id = $2`,
    [newBlob, accountId],
  );
  return refreshed.access_token;
};
