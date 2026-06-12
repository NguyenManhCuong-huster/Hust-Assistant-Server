import express from 'express';
import multer  from 'multer';

import { requireAuth } from '../middleware/authMiddleware.js';
import { query }       from '../config/db.js';
import {
  chat,
  buildEmailSystemInstruction,
  buildNewsSystemInstruction,
} from '../services/aiService.js';
import {
  TASK_TOOL_DECLARATIONS,
  makeTaskToolExecutor,
  buildToolSystemNote,
  buildUserInfoSystemNote,
} from '../services/aiTools.js';
import * as att from '../services/attachmentService.js';
import { isTextExtractable } from '../services/attachmentTextService.js';
import { resolveReferences } from '../services/aiReferences.js';

const router = express.Router();
router.use(requireAuth);

// ─────────────────────────────────────────────────────────────
// Multer config cho /upload-attachment
//   - memoryStorage: nhẹ vì sau đó saveBuffer ghi xuống đĩa qua attachmentService.
//   - fileSize cap = MAX_ATTACHMENT_BYTES (mặc định 25 MB).
// ─────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: att.getMaxBytes() },
});

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
const fetchUserTags = async (userId) => {
  const r = await query(
    `SELECT id, name, color_hex
     FROM tags
     WHERE user_id = $1 AND is_deleted = FALSE
     ORDER BY name ASC`,
    [userId],
  );
  return r.rows;
};

const fetchUserProfile = async (userId) => {
  const r = await query(
    `SELECT u.email,
            ui.student_id, ui.full_name, ui.school,
            ui.major, ui.class_name, ui.course
     FROM users u
     LEFT JOIN user_info ui ON ui.user_id = u.id
     WHERE u.id = $1`,
    [userId],
  );
  const row = r.rows[0];
  if (!row) return { userEmail: null, userInfo: null };

  const hasProfile = Boolean(
    row.student_id || row.full_name || row.school ||
    row.major || row.class_name || row.course,
  );

  return {
    userEmail: row.email ?? null,
    userInfo: hasProfile ? {
      student_id: row.student_id,
      full_name:  row.full_name,
      school:     row.school,
      major:      row.major,
      class_name: row.class_name,
      course:     row.course,
    } : null,
  };
};

const composeSystemInstruction = (callerInstruction, tags, profile) => {
  const userNote = buildUserInfoSystemNote(profile);
  const toolNote = buildToolSystemNote({ tags });
  const base =
    callerInstruction?.trim() ||
    'Bạn là trợ lý cá nhân, trả lời ngắn gọn và lịch sự bằng tiếng Việt.';
  return [userNote, toolNote, base].join('\n\n');
};

// ─────────────────────────────────────────────────────────────
// Validate `messages` shape. Trả normalized list hoặc throw.
// ─────────────────────────────────────────────────────────────
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
      .map((a) => ({
        id:        a.id.trim(),
        file_name: (a.file_name ?? '').toString(),
      }));
    return { role, content, attachments };
  });
};

// ─────────────────────────────────────────────────────────────
// collectEffectiveAttachments
//
// Gộp + validate attachments từ 2 nguồn:
//   1) message.attachments do client gửi (cần validate ownership)
//   2) source attachments (thread/news) — đã trust vì server tự fetch
//
// Trả về:
//   {
//     attachmentList: Array<row>  ← để build system instruction (file list)
//     allowedIds:     Array<id>   ← để pass cho tool executor scope
//   }
// ─────────────────────────────────────────────────────────────
const collectEffectiveAttachments = async ({
  messages,
  userId,
  sourceAttachments = [],
}) => {
  // 1) Gom mọi ID client reference qua message.attachments
  const referencedIds = new Set();
  for (const m of messages) {
    for (const a of m.attachments || []) {
      if (a.id) referencedIds.add(a.id);
    }
  }

  // 2) Validate ownership bulk → chỉ giữ ID user có quyền
  const validatedMap = await att.getAttachmentsForUserBulk(
    [...referencedIds],
    userId,
  );

  // 3) Merge với source attachments (đã trusted)
  const finalMap = new Map();
  for (const row of sourceAttachments) {
    if (row?.id) finalMap.set(row.id, row);
  }
  for (const [id, row] of validatedMap.entries()) {
    if (!finalMap.has(id)) finalMap.set(id, row);
  }

  // Log những ID client gửi mà bị reject (security signal)
  const rejectedIds = [...referencedIds].filter((id) => !validatedMap.has(id));
  if (rejectedIds.length > 0) {
    console.warn(
      `[ai] user=${userId} referenced attachment IDs bị reject (không quyền): ${rejectedIds.join(', ')}`,
    );
  }

  return {
    attachmentList: [...finalMap.values()],
    allowedIds:     [...finalMap.keys()],
  };
};

// ─────────────────────────────────────────────────────────────
// prepareInlineImages — MỚI 2026-06.
//
// Đọc bytes của các ảnh trong attachmentList → return Map<id, {mimeType, base64Data}>
// cho aiService.chat() chèn vào contents[].parts dưới dạng inlineData.
//
// Đồng thời "gắn" những ảnh chưa được message nào reference vào ATTACHMENTS
// của user message ĐẦU TIÊN — để chúng xuất hiện đúng cấu trúc turn-based
// trong contents (vd ảnh trong email signature thuộc thread context, không
// có message nào của user reference, nên cần đính vào turn đầu tiên).
//
// Mutate `messages` in-place (chỉ trường .attachments — append, không xoá).
//
// Trả về:
//   { inlineDataMap, attachedSourceImageIds }
//   - inlineDataMap: như trên (Map UUID → {mimeType, base64Data, file_name, sizeBytes})
//   - attachedSourceImageIds: list ID source ảnh đã append vào first user message
//                              (để log/debug)
// ─────────────────────────────────────────────────────────────
const prepareInlineImages = async ({ messages, attachmentList }) => {
  // 1) Đọc bytes ảnh
  const inlineDataMap = await att.readInlineImagesByRows(attachmentList);

  if (inlineDataMap.size === 0) {
    return { inlineDataMap, attachedSourceImageIds: [] };
  }

  // 2) Xác định ID nào đã được reference trong message.attachments[] sẵn
  const referencedInMessages = new Set();
  for (const m of messages) {
    for (const a of m.attachments || []) {
      if (a.id) referencedInMessages.add(a.id);
    }
  }

  // 3) Ảnh nào CÓ trong inlineDataMap mà CHƯA message nào reference
  //    → là source attachment (email signature, news image...) → đính vào first user msg.
  const orphanImageIds = [];
  for (const [id, info] of inlineDataMap.entries()) {
    if (!referencedInMessages.has(id)) {
      orphanImageIds.push({ id, file_name: info.file_name });
    }
  }

  if (orphanImageIds.length > 0) {
    const firstUserMsg = messages.find((m) => m.role === 'user');
    if (firstUserMsg) {
      firstUserMsg.attachments = [
        ...(firstUserMsg.attachments || []),
        ...orphanImageIds,
      ];
    } else {
      // Edge case: history toàn assistant message (gần như không xảy ra
      // vì chat luôn bắt đầu bằng user). Bỏ qua + log để debug.
      console.warn(
        `[inline-image] no user message to attach ${orphanImageIds.length} ` +
        `source images → AI sẽ không nhìn thấy chúng.`,
      );
    }
  }

  return {
    inlineDataMap,
    attachedSourceImageIds: orphanImageIds.map((x) => x.id),
  };
};

// ═════════════════════════════════════════════════════════════
// POST /api/ai/upload-attachment
//
// Multipart upload 1 file. Saves under owner_type='AI_CHAT', owner_id=userId.
// Trả {id, file_name, mime_type, size_bytes} để client dùng cho
// message.attachments ở lần chat tiếp theo.
// ═════════════════════════════════════════════════════════════
router.post('/upload-attachment', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ success: false, message: 'Thiếu file (field name = "file").' });
    }

    const result = await att.saveAiChatUpload({
      userId:       req.user.id,
      originalName: req.file.originalname,
      mimeType:     req.file.mimetype,
      buffer:       req.file.buffer,
    });

    res.json({
      success: true,
      data: {
        id:         result.id,
        file_name:  result.file_name,
        mime_type:  result.mime_type,
        size_bytes: result.size_bytes,
      },
    });
  } catch (err) {
    if (err.code === 'TOO_LARGE' || err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        success: false,
        message: `File quá lớn — giới hạn ${Math.round(att.getMaxBytes() / 1024 / 1024)} MB.`,
      });
    }
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// POST /api/ai/chat — Standalone chat
// ═════════════════════════════════════════════════════════════
router.post('/chat', async (req, res, next) => {
  try {
    const messages = normalizeMessages(req.body?.messages);
    const callerInstruction = req.body?.system_instruction ?? null;

    const [tags, profile, effective] = await Promise.all([
      fetchUserTags(req.user.id),
      fetchUserProfile(req.user.id),
      collectEffectiveAttachments({
        messages,
        userId: req.user.id,
        sourceAttachments: [],
      }),
    ]);

    // Standalone: dùng instruction caller truyền vào (nếu có) + auto-append
    // file list của các attachment user đã upload trong chat này.
    let baseInstruction = callerInstruction || '';
    const fileNote = buildFileListNote(effective.attachmentList);
    if (fileNote) {
      baseInstruction = baseInstruction
        ? `${baseInstruction}\n\n${fileNote}`
        : fileNote;
    }

    // ── MỚI 2026-06: đọc bytes các ảnh + append "orphan" source images vào
    //    first user message (nếu có). Standalone thường không có source
    //    attachments, nhưng vẫn gọi helper để code thống nhất.
    const { inlineDataMap, attachedSourceImageIds } =
      await prepareInlineImages({ messages, attachmentList: effective.attachmentList });

    console.log(
      `[ai/chat] user=${req.user.id} msgs=${messages.length} ` +
      `effective=${effective.attachmentList.length} ` +
      `inline_images=${inlineDataMap.size} ` +
      `orphan_attached=${attachedSourceImageIds.length} ` +
      `files=[${effective.attachmentList.map((a) => a.file_name).join(', ')}]`,
    );

    const result = await chat({
      messages,
      systemInstruction: composeSystemInstruction(baseInstruction, tags, profile),
      tools:             TASK_TOOL_DECLARATIONS,
      toolExecutor:      makeTaskToolExecutor({
        userId:               req.user.id,
        sourceType:           'MANUAL',
        allowedAttachmentIds: effective.allowedIds,
      }),
      inlineDataMap,
    });

    const { reply: replyWithRefs, references } = await resolveReferences({
      reply:  result.reply,
      userId: req.user.id,
    });

    res.json({
      success: true,
      data: {
        reply:                  replyWithRefs,
        usage:                  result.usage,
        tool_calls:             result.toolCalls,
        effective_attachments:  serializeAttachments(effective.attachmentList),
        references,
      },
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// POST /api/ai/email-chat
// ═════════════════════════════════════════════════════════════
router.post('/email-chat', async (req, res, next) => {
  try {
    const { email_id } = req.body;
    if (!email_id) {
      return res.status(400).json({ success: false, message: 'email_id là bắt buộc.' });
    }
    const messages = normalizeMessages(req.body?.messages);

    // ── 1. Fetch anchor email + thread messages ──
    const anchorRes = await query(
      `SELECT e.id, e.gmail_thread_id, e.gmail_message_id, e.received_at, e.account_id
       FROM emails e
       JOIN user_account_cross_ref uac ON uac.account_id = e.account_id
       WHERE e.id = $1 AND uac.user_id = $2`,
      [email_id, req.user.id],
    );
    const anchor = anchorRes.rows[0];
    if (!anchor) return res.status(404).json({ success: false, message: 'Email not found.' });

    let threadMessages;
    if (!anchor.gmail_thread_id) {
      const single = await query(
        `SELECT e.id, e.gmail_message_id, e.gmail_thread_id, e.sender, e.recipient,
                e.subject, e.snippet, e.body_text, e.body_html, e.received_at,
                e.deep_link_intent
         FROM emails e WHERE e.id = $1`,
        [anchor.id],
      );
      threadMessages = single.rows;
    } else {
      const t = await query(
        `SELECT e.id, e.gmail_message_id, e.gmail_thread_id, e.sender, e.recipient,
                e.subject, e.snippet, e.body_text, e.body_html, e.received_at,
                e.deep_link_intent
         FROM emails e
         JOIN user_account_cross_ref uac ON uac.account_id = e.account_id
         WHERE uac.user_id = $1
           AND e.gmail_thread_id = $2
           AND e.account_id      = $3
           AND e.received_at    <= $4
           AND e.is_deleted = FALSE
         ORDER BY e.received_at ASC`,
        [req.user.id, anchor.gmail_thread_id, anchor.account_id, anchor.received_at],
      );
      threadMessages = t.rows;
    }

    const thread = {
      thread_id: anchor.gmail_thread_id ?? anchor.gmail_message_id,
      messages:  threadMessages.map((m) => ({
        from:      m.sender,
        to:        m.recipient,
        subject:   m.subject,
        date:      m.received_at,
        snippet:   m.snippet,
        body_text: m.body_text,
        body_html: m.body_html,
      })),
    };

    // ── 2. Source attachments: TOÀN BỘ attachments của thread ──
    const threadEmailIds  = threadMessages.map((m) => m.id);
    const attMap          = await att.listForOwnersBulk(att.OWNER_EMAIL, threadEmailIds);
    const sourceAtts      = [];
    for (const arr of attMap.values()) sourceAtts.push(...arr);

    // ── 3. Effective set (source + client-referenced & validated) ──
    const effective = await collectEffectiveAttachments({
      messages,
      userId: req.user.id,
      sourceAttachments: sourceAtts,
    });

    // ── 3b. MỚI 2026-06: chuẩn bị inline images ──
    const { inlineDataMap, attachedSourceImageIds } =
      await prepareInlineImages({ messages, attachmentList: effective.attachmentList });

    console.log(
      `[ai/email-chat] anchor=${anchor.id} thread_msgs=${threadEmailIds.length} ` +
      `source_atts=${sourceAtts.length} effective=${effective.attachmentList.length} ` +
      `inline_images=${inlineDataMap.size} orphan_attached=${attachedSourceImageIds.length} ` +
      `files=[${effective.attachmentList.map((a) => a.file_name).join(', ')}]`,
    );

    // ── 4. Build system instruction + call AI ──
    const [tags, profile] = await Promise.all([
      fetchUserTags(req.user.id),
      fetchUserProfile(req.user.id),
    ]);
    const emailSysInstr = buildEmailSystemInstruction(thread, effective.attachmentList);
    const fullSysInstr  = composeSystemInstruction(emailSysInstr, tags, profile);

    const result = await chat({
      messages,
      systemInstruction: fullSysInstr,
      tools:             TASK_TOOL_DECLARATIONS,
      toolExecutor:      makeTaskToolExecutor({
        userId:               req.user.id,
        sourceType:           'EMAIL',
        sourceId:             anchor.id,
        allowedAttachmentIds: effective.allowedIds,
      }),
      inlineDataMap,
    });

    const { reply: replyWithRefs, references } = await resolveReferences({
      reply:  result.reply,
      userId: req.user.id,
    });

    res.json({
      success: true,
      data: {
        reply:                 replyWithRefs,
        thread_message_count:  thread.messages.length,
        usage:                 result.usage,
        tool_calls:            result.toolCalls,
        effective_attachments: serializeAttachments(effective.attachmentList),
        references,
      },
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// POST /api/ai/news-chat  ← MỚI 2026-05-31
// ═════════════════════════════════════════════════════════════
router.post('/news-chat', async (req, res, next) => {
  try {
    const { news_id } = req.body;
    if (!news_id) {
      return res.status(400).json({ success: false, message: 'news_id là bắt buộc.' });
    }
    const messages = normalizeMessages(req.body?.messages);

    // ── 1. Fetch news ──
    const newsRes = await query(
      `SELECT n.id, n.kind, n.title, n.summary, n.article_url, n.tag,
              n.published_at, n.mod_time,
              s.name AS source_name
       FROM news n
       LEFT JOIN news_sources s ON s.id = n.source_id
       WHERE n.id = $1 AND n.is_deleted = FALSE`,
      [news_id],
    );
    const news = newsRes.rows[0];
    if (!news) return res.status(404).json({ success: false, message: 'News not found.' });

    // ── 2. Source attachments của news ──
    const sourceAtts = await att.listForOwner(att.OWNER_NEWS, news.id);

    // ── 3. Effective set ──
    const effective = await collectEffectiveAttachments({
      messages,
      userId: req.user.id,
      sourceAttachments: sourceAtts,
    });

    // ── 3b. MỚI 2026-06: chuẩn bị inline images ──
    const { inlineDataMap, attachedSourceImageIds } =
      await prepareInlineImages({ messages, attachmentList: effective.attachmentList });

    console.log(
      `[ai/news-chat] news=${news.id} source_atts=${sourceAtts.length} ` +
      `effective=${effective.attachmentList.length} ` +
      `inline_images=${inlineDataMap.size} orphan_attached=${attachedSourceImageIds.length} ` +
      `files=[${effective.attachmentList.map((a) => a.file_name).join(', ')}]`,
    );

    // ── 4. Build system instruction + call AI ──
    const [tags, profile] = await Promise.all([
      fetchUserTags(req.user.id),
      fetchUserProfile(req.user.id),
    ]);
    const newsSysInstr = buildNewsSystemInstruction(news, effective.attachmentList);
    const fullSysInstr = composeSystemInstruction(newsSysInstr, tags, profile);

    const result = await chat({
      messages,
      systemInstruction: fullSysInstr,
      tools:             TASK_TOOL_DECLARATIONS,
      toolExecutor:      makeTaskToolExecutor({
        userId:               req.user.id,
        sourceType:           'NEWS',
        sourceId:             news.id,
        allowedAttachmentIds: effective.allowedIds,
      }),
      inlineDataMap,
    });

    const { reply: replyWithRefs, references } = await resolveReferences({
      reply:  result.reply,
      userId: req.user.id,
    });

    res.json({
      success: true,
      data: {
        reply:                 replyWithRefs,
        usage:                 result.usage,
        tool_calls:            result.toolCalls,
        effective_attachments: serializeAttachments(effective.attachmentList),
        references,
      },
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────
// Helpers nội bộ
// ─────────────────────────────────────────────────────────────

/**
 * Build mini system instruction note cho standalone chat khi user upload file.
 *
 * UPDATED 2026-06: liệt kê CẢ file text VÀ file ảnh thành 2 block riêng,
 * giống aiService.buildAttachmentsSystemNote() (logic share không được vì
 * standalone không có header email/news).
 */
const buildFileListNote = (attachmentList) => {
  const list = attachmentList || [];
  const textVisible  = list.filter((a) => isTextExtractable(a.mime_type, a.file_name));
  const imageVisible = list.filter((a) => att.isInlineImageMime(a.mime_type));

  const lines = [];

  if (textVisible.length > 0) {
    lines.push('═════════ FILE ĐÍNH KÈM ═════════');
    lines.push('(Khi user hỏi nội dung file, gọi tool `read_attachment` với `file_name`');
    lines.push(' = tên file copy nguyên văn từ danh sách dưới đây.)');
    for (const a of textVisible) {
      const sizeKb = a.size_bytes ? `${Math.round(a.size_bytes / 1024)} KB` : '?';
      const notReady = a.is_downloaded ? '' : ' [chưa tải xong, không đọc được]';
      lines.push(`  - "${a.file_name}" (${a.mime_type ?? '?'}, ${sizeKb})${notReady}`);
    }
  }

  if (imageVisible.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('═════════ ẢNH ĐÍNH KÈM ═════════');
    lines.push('(Các ảnh dưới đây đã được nhúng TRỰC TIẾP vào message user gửi —');
    lines.push(' bạn nhìn thấy ảnh ngay trong cuộc hội thoại. TUYỆT ĐỐI KHÔNG gọi');
    lines.push(' `read_attachment` cho ảnh: tool đó chỉ đọc text, sẽ fail.)');
    for (const a of imageVisible) {
      const sizeKb = a.size_bytes ? `${Math.round(a.size_bytes / 1024)} KB` : '?';
      const notReady = a.is_downloaded ? ' [chưa tải xong, không hiển thị được]' : '';
      lines.push(`  - "${a.file_name}" (${a.mime_type ?? '?'}, ${sizeKb})${notReady}`);
    }
  }

  return lines.join('\n');
};

/**
 * Trả về format gọn cho response — chỉ những field client cần để hiển thị.
 */
const serializeAttachments = (rows) =>
  (rows || []).map((r) => ({
    id:            r.id,
    file_name:     r.file_name,
    mime_type:     r.mime_type,
    size_bytes:    r.size_bytes,
    is_downloaded: r.is_downloaded ?? !!r.storage_path,
    is_inline:     !!r.is_inline,
  }));

export default router;
