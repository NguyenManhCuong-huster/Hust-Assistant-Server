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

/** Decode base64url thành Buffer (cho bytes file). */
const decodeBase64UrlToBuffer = (b64) => {
  if (!b64) return Buffer.alloc(0);
  const standard = b64.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(standard, 'base64');
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
 * Tìm header "Content-Disposition" hoặc "Content-ID" của 1 part.
 * Trả về { isInline: bool } — true nếu part có Content-Disposition: inline
 * hoặc có Content-ID (= image embed trong HTML).
 */
const partDisposition = (part) => {
  const headers = part.headers ?? [];
  const disp = headers.find((h) => h.name.toLowerCase() === 'content-disposition')?.value ?? '';
  const cid  = headers.find((h) => h.name.toLowerCase() === 'content-id')?.value;
  const isInline = /inline/i.test(disp) || !!cid;
  return { isInline };
};

/**
 * Walk payload, thu thập attachments. 1 part được coi là attachment khi:
 *   • `filename` không rỗng — Gmail set thuộc tính này cho mọi part có file name
 *     trong Content-Disposition.
 *   • `body.attachmentId` tồn tại — Gmail dùng để fetch bytes (không inline data).
 *
 * KHÔNG decode bytes ở đây. Bytes được fetch sau qua [getAttachmentBytes].
 */
const extractAttachments = (payload) => {
  const out = [];
  const walk = (parts) => {
    if (!parts) return;
    for (const p of parts) {
      if (p.parts && p.parts.length > 0) walk(p.parts);
      const filename       = p.filename;
      const attachmentId   = p.body?.attachmentId;
      if (!filename || !attachmentId) continue;
      const { isInline } = partDisposition(p);
      out.push({
        filename,
        mimeType:          p.mimeType ?? null,
        sizeBytes:         p.body?.size ?? null,
        gmailAttachmentId: attachmentId,
        isInline,
      });
    }
  };
  if (payload?.parts) walk(payload.parts);
  // Edge case: payload không có parts nhưng có filename (rare — single-part attachment)
  if (payload && payload.filename && payload.body?.attachmentId) {
    const { isInline } = partDisposition(payload);
    out.push({
      filename:          payload.filename,
      mimeType:          payload.mimeType ?? null,
      sizeBytes:         payload.body?.size ?? null,
      gmailAttachmentId: payload.body.attachmentId,
      isInline,
    });
  }
  return out;
};

/**
 * parseFullMessage — trả shape khớp với cột DB + attachments.
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
    attachments:      extractAttachments(msg.payload),
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
 * Fetch bytes của 1 attachment. Trả Buffer.
 *
 * Endpoint Gmail: GET /messages/{id}/attachments/{attId}
 *   → response.data = base64url string.
 */
export const getAttachmentBytes = async (accessToken, messageId, attachmentId) => {
  const data = await gmailFetch(
    accessToken,
    `/messages/${messageId}/attachments/${attachmentId}`,
    {},
  );
  return decodeBase64UrlToBuffer(data.data);
};

/**
 * fetchNewEmails — pull mọi message mới từ sau sinceDate, KÈM body + attachments
 * metadata. Bytes attachment KHÔNG download ở đây.
 *
 * Cost: 50 message = 50 + 1 = 51 API call.
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
