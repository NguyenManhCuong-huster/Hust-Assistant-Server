import { isTextExtractable } from '../attachments/attachments.text.js';
import { isInlineImageMime } from '../attachments/attachments.service.js';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

const getModel  = () => process.env.OPENROUTER_MODEL  || 'deepseek/deepseek-chat-v4-5';
const getApiKey = () => {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY chưa được set trong .env');
  return key;
};

// Chuyển internal message → OpenAI content format.
// Ảnh (nếu có) được nhúng dưới dạng image_url data URI — chỉ hoạt động với
// model hỗ trợ vision. Model text-only sẽ bỏ qua phần ảnh.
const messageToOAI = (m, inlineDataMap) => {
  const parts = [];

  if (inlineDataMap && Array.isArray(m.attachments)) {
    for (const att of m.attachments) {
      const inline = inlineDataMap.get(att.id);
      if (!inline) continue;
      parts.push({
        type:      'image_url',
        image_url: { url: `data:${inline.mimeType};base64,${inline.base64Data}` },
      });
    }
  }

  const text = String(m.content ?? '');
  if (text.length > 0 || parts.length === 0) {
    parts.push({ type: 'text', text });
  }

  // Dùng string thuần nếu chỉ có text (compat rộng hơn với các model)
  const content = parts.length === 1 && parts[0].type === 'text' ? text : parts;
  return { role: m.role === 'assistant' ? 'assistant' : 'user', content };
};

// Chuyển Gemini-style function declaration → OpenAI tool format
const toOAITool = (decl) => ({
  type:     'function',
  function: { name: decl.name, description: decl.description, parameters: decl.parameters },
});

export const chat = async ({
  messages,
  systemInstruction = null,
  model             = null,
  temperature       = 0.7,
  tools             = null,
  toolExecutor      = null,
  maxIterations     = 5,
  inlineDataMap     = null,
}) => {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('messages phải là array không rỗng');
  }

  const url      = `${OPENROUTER_BASE}/chat/completions`;
  const useModel = model || getModel();
  const oaiTools = Array.isArray(tools) && tools.length > 0 ? tools.map(toOAITool) : null;
  const useTools = oaiTools !== null && typeof toolExecutor === 'function';

  // Xây messages OpenAI: system trước, rồi history
  const oaiMessages = [];
  if (systemInstruction) {
    oaiMessages.push({ role: 'system', content: systemInstruction });
  }
  for (const m of messages) {
    oaiMessages.push(messageToOAI(m, inlineDataMap));
  }

  const usageAccum = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const toolCalls  = [];

  for (let iter = 0; iter < maxIterations; iter++) {
    const body = {
      model:       useModel,
      messages:    oaiMessages,
      temperature,
      max_tokens:  8192,
    };
    if (useTools) {
      body.tools       = oaiTools;
      body.tool_choice = 'auto';
    }

    const res = await fetch(url, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${getApiKey()}`,
        'HTTP-Referer':  process.env.SERVER_URL || 'http://localhost:3000',
        'X-Title':       'HustAssistant',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      const err = new Error(`OpenRouter ${res.status}: ${errText}`);
      // 4xx từ OpenRouter (sai model, hết quota, lỗi request) → trả 400 về client thay vì 500
      err.statusCode = res.status >= 500 ? 502 : 400;
      throw err;
    }

    const data    = await res.json();
    const choice  = data.choices?.[0];
    const message = choice?.message;
    if (!message) throw new Error('OpenRouter: phản hồi thiếu message');

    if (data.usage) {
      usageAccum.prompt_tokens     += data.usage.prompt_tokens     ?? 0;
      usageAccum.completion_tokens += data.usage.completion_tokens ?? 0;
      usageAccum.total_tokens      += data.usage.total_tokens      ?? 0;
    }

    const aiToolCalls = message.tool_calls;
    const textReply   = typeof message.content === 'string' ? message.content : '';

    // Không có tool call → xong
    if (!useTools || !aiToolCalls?.length) {
      return { reply: textReply, usage: usageAccum, toolCalls };
    }

    // Append assistant message (có chứa tool_calls) vào history
    oaiMessages.push(message);

    // Thực thi từng tool call, append kết quả dưới dạng role=tool
    for (const tc of aiToolCalls) {
      const name = tc.function?.name ?? '';
      let   args = {};
      try { args = JSON.parse(tc.function?.arguments ?? '{}'); } catch { /* model trả JSON lỗi */ }

      let result;
      try {
        result = await toolExecutor(name, args);
      } catch (err) {
        result = { success: false, error: err.message ?? String(err) };
      }
      toolCalls.push({ name, args, result });

      oaiMessages.push({
        role:         'tool',
        tool_call_id: tc.id,
        content:      JSON.stringify(result),
      });
    }
  }

  return {
    reply:     '(AI đã thực hiện hành động nhưng không kịp tổng kết — vui lòng kiểm tra danh sách task.)',
    usage:     usageAccum,
    toolCalls,
  };
};

// ─────────────────────────────────────────────────────────────
// buildAttachmentsSystemNote — UNIFIED 2026-05-31, mở rộng 2026-06.
//
// In ra 2 block (chỉ block nào có data mới render):
//
//   1. "FILE ĐÍNH KÈM"  — file text-extractable. AI đọc qua `read_attachment`.
//   2. "ẢNH ĐÍNH KÈM"  — file ảnh đã được nhúng inlineData trực tiếp vào
//                         contents. AI nhìn thấy ảnh ngay trong turn user
//                         gửi, KHÔNG cần (và KHÔNG nên) gọi read_attachment.
//                         Liệt kê tên file để AI có thể correlate "ảnh ABC.png"
//                         user đề cập với image part nhìn thấy được.
//
// `attachments` shape: [{ id, file_name, mime_type, size_bytes, is_downloaded, is_inline }]
//   - is_downloaded: FALSE → vẫn liệt kê nhưng đánh dấu "chưa tải".
//
// 2026-06 update: thêm filter `isInlineImageMime` cho block ẢNH; logic
// text-extractable giữ nguyên 100%.
// ─────────────────────────────────────────────────────────────
export const buildAttachmentsSystemNote = (attachments = []) => {
  const list = attachments || [];

  const textVisible  = list.filter((a) => isTextExtractable(a.mime_type, a.file_name));
  const imageVisible = list.filter((a) => isInlineImageMime(a.mime_type));

  const lines = [];

  if (textVisible.length > 0) {
    lines.push('═════════ FILE ĐÍNH KÈM ═════════');
    lines.push('(Khi user hỏi nội dung file, gọi tool `read_attachment` với THAM SỐ');
    lines.push(' `file_name` = tên file copy nguyên văn từ danh sách dưới đây.)');
    for (const a of textVisible) {
      const sizeKb = a.size_bytes ? `${Math.round(a.size_bytes / 1024)} KB` : '?';
      const notReady = a.is_downloaded ? '' : ' [chưa tải xong server, không đọc được]';
      lines.push(`  - "${a.file_name}" (${a.mime_type ?? '?'}, ${sizeKb})${notReady}`);
    }
  }

  if (imageVisible.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('═════════ ẢNH ĐÍNH KÈM ═════════');
    lines.push('(Các ảnh dưới đây đã được nhúng TRỰC TIẾP vào cuộc hội thoại — bạn nhìn');
    lines.push(' thấy chúng ngay trong message tương ứng. TUYỆT ĐỐI KHÔNG gọi');
    lines.push(' `read_attachment` cho ảnh: tool đó chỉ đọc text, sẽ fail.)');
    for (const a of imageVisible) {
      const sizeKb = a.size_bytes ? `${Math.round(a.size_bytes / 1024)} KB` : '?';
      const notReady = a.is_downloaded ? ' [chưa tải xong server, không hiển thị được]' : '';
      lines.push(`  - "${a.file_name}" (${a.mime_type ?? '?'}, ${sizeKb})${notReady}`);
    }
  }

  return lines.join('\n');
};

// ─────────────────────────────────────────────────────────────
// buildEmailSystemInstruction — UPDATED 2026-05-31.
//
// Giữ tương thích: dùng buildAttachmentsSystemNote bên trong cho phần file list.
// ─────────────────────────────────────────────────────────────
/**
 * @param {Object} thread        — { messages: [...] }
 * @param {Array=} attachments   — [{ id, file_name, mime_type, size_bytes, is_downloaded, is_inline }]
 */
export const buildEmailSystemInstruction = (thread, attachments = []) => {
  const lines = [];
  lines.push('Bạn là trợ lý email cho người dùng. Trả lời ngắn gọn, lịch sự, bằng tiếng Việt.');
  lines.push('Bạn đang đọc cùng người dùng cuộc hội thoại email sau:');
  lines.push('');
  lines.push('═════════ EMAIL THREAD ═════════');
  for (const m of thread.messages || []) {
    lines.push(`From: ${m.from ?? '?'}`);
    if (m.to) lines.push(`To: ${m.to}`);
    lines.push(`Date: ${m.date ?? '?'}`);
    lines.push(`Subject: ${m.subject ?? '(no subject)'}`);
    lines.push('');
    lines.push((m.body_text || m.snippet || '').trim());
    lines.push('───────────────────────────────');
  }

  const fileBlock = buildAttachmentsSystemNote(attachments);
  if (fileBlock) {
    lines.push('');
    lines.push(fileBlock);
  }

  lines.push('');
  lines.push('Khi user yêu cầu "soạn phản hồi" hoặc "viết reply", trả về thẳng nội dung email phản hồi (không giải thích thêm), bắt đầu bằng dòng "Subject: Re: ...".');
  return lines.join('\n');
};

// ─────────────────────────────────────────────────────────────
// buildNewsSystemInstruction — MỚI 2026-05-31 (move từ client).
//
// Build context cho news/plan chat. Bao gồm: nội dung article + danh sách file.
// ─────────────────────────────────────────────────────────────
/**
 * @param {Object} news          — { id, kind, title, summary, tag, source_name, published_at, ... }
 * @param {Array=} attachments
 */
export const buildNewsSystemInstruction = (news, attachments = []) => {
  if (!news) {
    return 'Bạn là trợ lý cho sinh viên Bách Khoa Hà Nội. Trả lời bằng tiếng Việt. Mặc định xưng hô bạn-tôi.';
  }
  const kind     = String(news.kind || 'NEWS').toUpperCase();
  const typeText = kind === 'PLAN' ? 'kế hoạch học tập / lịch thi' : 'tin tức / thông báo';

  const lines = [];
  lines.push('Bạn là trợ lý cho sinh viên Đại học Bách Khoa Hà Nội.');
  lines.push(`Người dùng đang đọc 1 ${typeText} từ Cổng thông tin sinh viên (HUST CTT).`);
  lines.push('');
  lines.push('═════════ NỘI DUNG BÀI VIẾT ═════════');
  lines.push(`Tiêu đề: ${news.title ?? '(không tiêu đề)'}`);
  if (news.tag)          lines.push(`Loại:    ${news.tag}`);
  if (news.published_at) lines.push(`Ngày đăng: ${news.published_at}`);
  if (news.source_name)  lines.push(`Nguồn:   ${news.source_name}`);
  lines.push('');
  lines.push((news.summary || '(Không có nội dung chi tiết)').trim());
  lines.push('───────────────────────────────');

  const fileBlock = buildAttachmentsSystemNote(attachments);
  if (fileBlock) {
    lines.push('');
    lines.push(fileBlock);
  }

  lines.push('');
  lines.push('Nếu user yêu cầu tạo task/nhắc lịch liên quan đến mốc thời gian trong bài,');
  lines.push('dùng tool create_task hoặc create_weekly_tasks với end_time/loop_*_date hợp lý.');
  return lines.join('\n');
};
