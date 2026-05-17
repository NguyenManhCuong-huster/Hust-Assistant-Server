/**
 * src/routes/ai.js
 *
 * THAY ĐỔI 2025-05-04 (v2):
 *   - Trước khi gọi chat(), fetch list tag của user → đưa vào
 *     buildToolSystemNote({ tags }) để model biết tag nào tồn tại.
 *   - Response trả `tool_calls` để client (Kotlin) hiển thị từng bước
 *     AI đã làm trong chat UI.
 */

import express from 'express';

import { requireAuth } from '../middleware/authMiddleware.js';
import { query }       from '../config/db.js';
import { chat, buildEmailSystemInstruction } from '../services/aiService.js';
import {
  TASK_TOOL_DECLARATIONS,
  makeTaskToolExecutor,
  buildToolSystemNote,
} from '../services/aiTools.js';

const router = express.Router();
router.use(requireAuth);

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

/**
 * Ghép system instruction của caller với tool note.
 * Tool note (gồm tag list) đặt TRƯỚC để model thấy tool spec ngay đầu.
 */
const composeSystemInstruction = (callerInstruction, tags) => {
  const toolNote = buildToolSystemNote({ tags });
  const base =
    callerInstruction?.trim() ||
    'Bạn là trợ lý cá nhân, trả lời ngắn gọn và lịch sự bằng tiếng Việt.';
  return `${toolNote}\n\n${base}`;
};

// ─────────────────────────────────────────────────────────────
// POST /api/ai/chat
// ─────────────────────────────────────────────────────────────
router.post('/chat', async (req, res, next) => {
  try {
    const { messages, system_instruction } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ success: false, message: 'messages là bắt buộc.' });
    }

    const tags = await fetchUserTags(req.user.id);

    const result = await chat({
      messages,
      systemInstruction: composeSystemInstruction(system_instruction, tags),
      tools:             TASK_TOOL_DECLARATIONS,
      toolExecutor:      makeTaskToolExecutor({ userId: req.user.id }),
    });

    res.json({
      success: true,
      data: {
        reply:      result.reply,
        usage:      result.usage,
        tool_calls: result.toolCalls,
      },
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// POST /api/ai/email-chat
// ─────────────────────────────────────────────────────────────
router.post('/email-chat', async (req, res, next) => {
  try {
    const { email_id, messages } = req.body;
    if (!email_id) {
      return res.status(400).json({ success: false, message: 'email_id là bắt buộc.' });
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ success: false, message: 'messages là bắt buộc.' });
    }

    // Anchor email
    const anchorRes = await query(
      `SELECT e.id, e.gmail_thread_id, e.gmail_message_id, e.received_at, e.account_id
       FROM emails e
       JOIN user_account_cross_ref uac ON uac.account_id = e.account_id
       WHERE e.id = $1 AND uac.user_id = $2`,
      [email_id, req.user.id],
    );
    const anchor = anchorRes.rows[0];
    if (!anchor) return res.status(404).json({ success: false, message: 'Email not found.' });

    // Pull thread messages (cùng filter logic với /emails/:id/thread)
    let threadMessages;
    if (!anchor.gmail_thread_id) {
      const single = await query(
        `SELECT e.gmail_message_id, e.gmail_thread_id, e.sender, e.recipient,
                e.subject, e.snippet, e.body_text, e.body_html, e.received_at,
                e.deep_link_intent
         FROM emails e WHERE e.id = $1`,
        [anchor.id],
      );
      threadMessages = single.rows;
    } else {
      const t = await query(
        `SELECT e.gmail_message_id, e.gmail_thread_id, e.sender, e.recipient,
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

    // Fetch tag song song với việc đã có thread
    const tags         = await fetchUserTags(req.user.id);
    const emailSysInstr = buildEmailSystemInstruction(thread);
    const fullSysInstr  = composeSystemInstruction(emailSysInstr, tags);

    const result = await chat({
      messages,
      systemInstruction: fullSysInstr,
      tools:             TASK_TOOL_DECLARATIONS,
      toolExecutor:      makeTaskToolExecutor({
        userId:     req.user.id,
        sourceType: 'EMAIL',
        sourceId:   anchor.id,
      }),
    });

    res.json({
      success: true,
      data: {
        reply:                result.reply,
        thread_message_count: thread.messages.length,
        usage:                result.usage,
        tool_calls:           result.toolCalls,
      },
    });
  } catch (err) { next(err); }
});

export default router;
