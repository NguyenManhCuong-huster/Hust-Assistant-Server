import multer from 'multer';
import { listTagsForAI }  from '../../dao/tags.dao.js';
import { getUserProfile } from '../../dao/user.dao.js';
import { getEmailAnchor, getThread } from '../../dao/emails.dao.js';
import { getNewsById } from '../../dao/news.dao.js';

import { chat, chatStream, buildEmailSystemInstruction, buildNewsSystemInstruction } from './ai.service.js';
import {
  TASK_TOOL_DECLARATIONS,
  makeTaskToolExecutor,
  buildToolSystemNote,
  buildUserInfoSystemNote,
} from './ai.tools.js';
import * as att from '../attachments/attachments.service.js';
import { isTextExtractable } from '../attachments/attachments.text.js';
import { resolveReferences } from './ai.references.js';

// ── Multer setup ──────────────────────────────────────────────────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: att.getMaxBytes() },
});

export const uploadMiddleware = upload.single('file');

// ── Helpers ───────────────────────────────────────────────────────────────────

const composeSystemInstruction = (callerInstruction, tags, profile) => {
  const userNote = buildUserInfoSystemNote(profile);
  const toolNote = buildToolSystemNote({ tags });
  const base = callerInstruction?.trim() || 'Bạn là trợ lý cá nhân, trả lời ngắn gọn và lịch sự bằng tiếng Việt.';
  return [userNote, toolNote, base].join('\n\n');
};

const normalizeMessages = (raw) => {
  if (!Array.isArray(raw) || raw.length === 0) {
    const e = new Error('messages là bắt buộc.');
    e.statusCode = 400;
    throw e;
  }
  return raw.map((m, idx) => {
    if (!m || typeof m !== 'object') {
      const e = new Error(`messages[${idx}] phải là object.`);
      e.statusCode = 400;
      throw e;
    }
    const role    = m.role === 'assistant' ? 'assistant' : 'user';
    const content = String(m.content ?? '');
    const rawAtt  = Array.isArray(m.attachments) ? m.attachments : [];
    const attachments = rawAtt
      .filter((a) => a && typeof a === 'object' && typeof a.id === 'string')
      .map((a) => ({ id: a.id.trim(), file_name: (a.file_name ?? '').toString() }));
    return { role, content, attachments };
  });
};

const collectEffectiveAttachments = async ({ messages, userId, sourceAttachments = [] }) => {
  const referencedIds = new Set();
  for (const m of messages) {
    for (const a of m.attachments || []) {
      if (a.id) referencedIds.add(a.id);
    }
  }
  const validatedMap = await att.getAttachmentsForUserBulk([...referencedIds], userId);
  const finalMap = new Map();
  for (const row of sourceAttachments) { if (row?.id) finalMap.set(row.id, row); }
  for (const [id, row] of validatedMap.entries()) { if (!finalMap.has(id)) finalMap.set(id, row); }

  const rejectedIds = [...referencedIds].filter((id) => !validatedMap.has(id));
  if (rejectedIds.length > 0) {
    console.warn(`[ai] user=${userId} rejected attachment IDs: ${rejectedIds.join(', ')}`);
  }
  return { attachmentList: [...finalMap.values()], allowedIds: [...finalMap.keys()] };
};

const prepareInlineImages = async ({ messages, attachmentList }) => {
  const inlineDataMap = await att.readInlineImagesByRows(attachmentList);
  if (inlineDataMap.size === 0) return { inlineDataMap, attachedSourceImageIds: [] };

  const referencedInMessages = new Set();
  for (const m of messages) {
    for (const a of m.attachments || []) { if (a.id) referencedInMessages.add(a.id); }
  }

  const orphanImageIds = [];
  for (const [id, info] of inlineDataMap.entries()) {
    if (!referencedInMessages.has(id)) orphanImageIds.push({ id, file_name: info.file_name });
  }

  if (orphanImageIds.length > 0) {
    const firstUserMsg = messages.find((m) => m.role === 'user');
    if (firstUserMsg) {
      firstUserMsg.attachments = [...(firstUserMsg.attachments || []), ...orphanImageIds];
    }
  }
  return { inlineDataMap, attachedSourceImageIds: orphanImageIds.map((x) => x.id) };
};

const buildFileListNote = (attachmentList) => {
  const list = attachmentList || [];
  const textVisible  = list.filter((a) => isTextExtractable(a.mime_type, a.file_name));
  const imageVisible = list.filter((a) => att.isInlineImageMime(a.mime_type));
  const lines = [];
  if (textVisible.length > 0) {
    lines.push('═════════ FILE ĐÍNH KÈM ═════════');
    lines.push('(Khi user hỏi nội dung file, gọi tool `read_attachment` với `file_name` = tên file copy nguyên văn từ danh sách dưới đây.)');
    for (const a of textVisible) {
      const sizeKb = a.size_bytes ? `${Math.round(a.size_bytes / 1024)} KB` : '?';
      lines.push(`  - "${a.file_name}" (${a.mime_type ?? '?'}, ${sizeKb})${a.is_downloaded ? '' : ' [chưa tải xong, không đọc được]'}`);
    }
  }
  if (imageVisible.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('═════════ ẢNH ĐÍNH KÈM ═════════');
    lines.push('(Các ảnh dưới đây đã được nhúng TRỰC TIẾP vào message user gửi — bạn nhìn thấy ảnh ngay trong cuộc hội thoại. TUYỆT ĐỐI KHÔNG gọi `read_attachment` cho ảnh.)');
    for (const a of imageVisible) {
      const sizeKb = a.size_bytes ? `${Math.round(a.size_bytes / 1024)} KB` : '?';
      lines.push(`  - "${a.file_name}" (${a.mime_type ?? '?'}, ${sizeKb})${a.is_downloaded ? ' [chưa tải xong, không hiển thị được]' : ''}`);
    }
  }
  return lines.join('\n');
};

const serializeAttachments = (rows) =>
  (rows || []).map((r) => ({
    id:            r.id,
    file_name:     r.file_name,
    mime_type:     r.mime_type,
    size_bytes:    r.size_bytes,
    is_downloaded: r.is_downloaded ?? !!r.storage_path,
    is_inline:     !!r.is_inline,
  }));

// ── Route handlers ────────────────────────────────────────────────────────────

export const uploadAttachment = async (req, res, next) => {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ success: false, message: 'Thiếu file (field name = "file").' });
    }
    const result = await att.saveAiChatUpload({
      userId:       req.user.id,
      originalName: req.file.originalname,
      mimeType:     req.file.mimetype,
      buffer:       req.file.buffer,
    });
    res.json({ success: true, data: { id: result.id, file_name: result.file_name, mime_type: result.mime_type, size_bytes: result.size_bytes } });
  } catch (err) {
    if (err.code === 'TOO_LARGE' || err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ success: false, message: `File quá lớn — giới hạn ${Math.round(att.getMaxBytes() / 1024 / 1024)} MB.` });
    }
    next(err);
  }
};

// ── Prepare functions ───────────────────────────────────────────────────────
//
// Mỗi prepare* gom toàn bộ logic chuẩn bị (load context, attachments, inline
// images, system instruction, tool executor) và trả về đúng bộ tham số cho
// chat()/chatStream(). Nhờ vậy 2 biến thể JSON (non-stream) và SSE (stream)
// dùng CHUNG 1 nguồn chuẩn bị → không lặp logic.
//
// Trả về: { chatArgs, extra } — chatArgs spread thẳng vào chat()/chatStream();
// extra là field phụ thêm vào response (vd effective_attachments).

const prepareStandalone = async (req) => {
  const messages          = normalizeMessages(req.body?.messages);
  const callerInstruction = req.body?.system_instruction ?? null;

  const [tags, profile, effective] = await Promise.all([
    listTagsForAI(req.user.id),
    getUserProfile(req.user.id),
    collectEffectiveAttachments({ messages, userId: req.user.id }),
  ]);

  let baseInstruction = callerInstruction || '';
  const fileNote = buildFileListNote(effective.attachmentList);
  if (fileNote) baseInstruction = baseInstruction ? `${baseInstruction}\n\n${fileNote}` : fileNote;

  const { inlineDataMap, attachedSourceImageIds } =
    await prepareInlineImages({ messages, attachmentList: effective.attachmentList });

  console.log(
    `[ai/chat] user=${req.user.id} msgs=${messages.length} effective=${effective.attachmentList.length} ` +
    `inline_images=${inlineDataMap.size} orphan_attached=${attachedSourceImageIds.length}`,
  );

  return {
    chatArgs: {
      messages,
      systemInstruction: composeSystemInstruction(baseInstruction, tags, profile),
      tools:             TASK_TOOL_DECLARATIONS,
      toolExecutor:      makeTaskToolExecutor({ userId: req.user.id, sourceType: 'MANUAL', allowedAttachmentIds: effective.allowedIds }),
      inlineDataMap,
    },
    extra: { effective_attachments: serializeAttachments(effective.attachmentList) },
  };
};

const prepareEmail = async (req) => {
  const { email_id } = req.body;
  if (!email_id) { const e = new Error('email_id là bắt buộc.'); e.statusCode = 400; throw e; }
  const messages = normalizeMessages(req.body?.messages);

  const anchor = await getEmailAnchor(email_id, req.user.id);
  if (!anchor) { const e = new Error('Email not found.'); e.statusCode = 404; throw e; }

  const threadMessages = await getThread(anchor, req.user.id);
  const thread = {
    thread_id: anchor.gmail_thread_id ?? anchor.gmail_message_id,
    messages:  threadMessages.map((m) => ({
      from: m.sender, to: m.recipient, subject: m.subject, date: m.received_at,
      snippet: m.snippet, body_text: m.body_text, body_html: m.body_html,
    })),
  };

  const threadEmailIds = threadMessages.map((m) => m.id);
  const attMap         = await att.listForOwnersBulk(att.OWNER_EMAIL, threadEmailIds);
  const sourceAtts     = [];
  for (const arr of attMap.values()) sourceAtts.push(...arr);

  const effective = await collectEffectiveAttachments({ messages, userId: req.user.id, sourceAttachments: sourceAtts });
  const { inlineDataMap, attachedSourceImageIds } = await prepareInlineImages({ messages, attachmentList: effective.attachmentList });

  console.log(
    `[ai/email-chat] anchor=${anchor.id} thread_msgs=${threadEmailIds.length} source_atts=${sourceAtts.length} ` +
    `effective=${effective.attachmentList.length} inline_images=${inlineDataMap.size} orphan_attached=${attachedSourceImageIds.length}`,
  );

  const [tags, profile] = await Promise.all([listTagsForAI(req.user.id), getUserProfile(req.user.id)]);
  return {
    chatArgs: {
      messages,
      systemInstruction: composeSystemInstruction(buildEmailSystemInstruction(thread, effective.attachmentList), tags, profile),
      tools:             TASK_TOOL_DECLARATIONS,
      toolExecutor:      makeTaskToolExecutor({ userId: req.user.id, sourceType: 'EMAIL', sourceId: anchor.id, allowedAttachmentIds: effective.allowedIds }),
      inlineDataMap,
    },
    extra: {
      thread_message_count:  thread.messages.length,
      effective_attachments: serializeAttachments(effective.attachmentList),
    },
  };
};

const prepareNews = async (req) => {
  const { news_id } = req.body;
  if (!news_id) { const e = new Error('news_id là bắt buộc.'); e.statusCode = 400; throw e; }
  const messages = normalizeMessages(req.body?.messages);

  const news = await getNewsById(news_id);
  if (!news) { const e = new Error('News not found.'); e.statusCode = 404; throw e; }

  const sourceAtts = await att.listForOwner(att.OWNER_NEWS, news.id);
  const effective  = await collectEffectiveAttachments({ messages, userId: req.user.id, sourceAttachments: sourceAtts });
  const { inlineDataMap, attachedSourceImageIds } = await prepareInlineImages({ messages, attachmentList: effective.attachmentList });

  console.log(
    `[ai/news-chat] news=${news.id} source_atts=${sourceAtts.length} effective=${effective.attachmentList.length} ` +
    `inline_images=${inlineDataMap.size} orphan_attached=${attachedSourceImageIds.length}`,
  );

  const [tags, profile] = await Promise.all([listTagsForAI(req.user.id), getUserProfile(req.user.id)]);
  return {
    chatArgs: {
      messages,
      systemInstruction: composeSystemInstruction(buildNewsSystemInstruction(news, effective.attachmentList), tags, profile),
      tools:             TASK_TOOL_DECLARATIONS,
      toolExecutor:      makeTaskToolExecutor({ userId: req.user.id, sourceType: 'NEWS', sourceId: news.id, allowedAttachmentIds: effective.allowedIds }),
      inlineDataMap,
    },
    extra: { effective_attachments: serializeAttachments(effective.attachmentList) },
  };
};

// ── Runners ─────────────────────────────────────────────────────────────────

/** Chạy 1 lượt chat non-stream (JSON), trả response 1 lần. */
const runJson = (prepareFn) => async (req, res, next) => {
  try {
    const { chatArgs, extra } = await prepareFn(req);
    const result = await chat(chatArgs);
    const { reply, references } = await resolveReferences({ reply: result.reply, userId: req.user.id });
    res.json({
      success: true,
      data: { reply, usage: result.usage, tool_calls: result.toolCalls, references, ...extra },
    });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
    next(err);
  }
};

/**
 * Chạy 1 lượt chat STREAMING qua SSE (text/event-stream). Mỗi sự kiện là 1 dòng
 * `data: <json>\n\n` với field `type`:
 *   - "delta" { text }                 — 1 đoạn text mới của câu trả lời.
 *   - "tool"  { tool_call }            — 1 tool vừa chạy xong (name, args, result).
 *   - "done"  { reply, references, usage, tool_calls, ...extra } — kết thúc.
 *   - "error" { message }             — lỗi (gửi trong stream, HTTP vẫn 200).
 *
 * Lỗi lúc CHUẨN BỊ (trước khi mở stream) vẫn trả HTTP code chuẩn như runJson.
 */
const runStream = (prepareFn) => async (req, res, next) => {
  let prepared;
  try {
    prepared = await prepareFn(req);
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
    return next(err);
  }

  res.setHeader('Content-Type',      'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control',     'no-cache, no-transform');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');   // tắt buffering của reverse proxy (nginx)
  res.flushHeaders?.();

  const send = (obj) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  // Client ngắt kết nối giữa chừng → dừng đẩy thêm.
  // QUAN TRỌNG: nghe trên `res`, KHÔNG phải `req`. Với POST có body,
  // express.json() đọc hết body khiến request stream phát 'close' NGAY sau khi
  // parse xong (chứ không phải khi client rời đi) → nếu nghe `req` thì `aborted`
  // bật sớm và chặn mất delta text + done. `res` 'close' chỉ bật khi kết nối
  // thực sự đóng.
  let aborted = false;
  res.on('close', () => { aborted = true; });

  try {
    const result = await chatStream({
      ...prepared.chatArgs,
      onDelta:    (text) => { if (!aborted) send({ type: 'delta', text }); },
      onToolCall: (tc)   => { if (!aborted) send({ type: 'tool', tool_call: tc }); },
    });
    if (aborted) return;
    const { reply, references } = await resolveReferences({ reply: result.reply, userId: req.user.id });
    send({
      type: 'done',
      reply,
      references,
      usage:      result.usage,
      tool_calls: result.toolCalls,
      ...prepared.extra,
    });
  } catch (err) {
    console.error('[ai/stream]', err);
    send({ type: 'error', message: err.message || 'AI lỗi' });
  } finally {
    if (!res.writableEnded) res.end();
  }
};

export const standaloneChat       = runJson(prepareStandalone);
export const emailChat            = runJson(prepareEmail);
export const newsChat             = runJson(prepareNews);

export const standaloneChatStream = runStream(prepareStandalone);
export const emailChatStream      = runStream(prepareEmail);
export const newsChatStream       = runStream(prepareNews);
