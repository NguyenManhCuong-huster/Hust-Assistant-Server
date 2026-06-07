import { isTextExtractable } from './attachmentTextService.js';
import { isInlineImageMime } from './attachmentService.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const getModel  = () => process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const getApiKey = () => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY chưa được set trong .env');
  return key;
};

/**
 * Convert 1 message của ta sang 1 content của Gemini.
 *
 * MỚI 2026-06: nếu message.attachments có ID nằm trong inlineDataMap → chèn
 *   `inlineData` parts (ảnh base64) vào TRƯỚC text part. AI nhìn thấy ảnh
 *   ngay tại message đó trong lịch sử hội thoại (đúng turn user đã gửi).
 *
 * Nếu không có attachment ảnh nào & content rỗng, vẫn push 1 text part rỗng
 * để parts[] không rỗng (yêu cầu của Gemini API).
 */
const messageToContent = (m, inlineDataMap) => {
  const parts = [];

  // 1) Inline image parts (nếu có)
  if (inlineDataMap && Array.isArray(m.attachments)) {
    for (const att of m.attachments) {
      const inline = inlineDataMap.get(att.id);
      if (!inline) continue;
      parts.push({
        inlineData: {
          mimeType: inline.mimeType,
          data:     inline.base64Data,
        },
      });
    }
  }

  // 2) Text part — luôn append nếu có content; nếu chưa có part nào (vd
  //    user chỉ gửi ảnh mà không có content), push 1 text rỗng cho an toàn.
  const text = String(m.content ?? '');
  if (text.length > 0 || parts.length === 0) {
    parts.push({ text });
  }

  return {
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts,
  };
};

export const chat = async ({
  messages,
  systemInstruction = null,
  model             = null,
  temperature       = 0.7,
  tools             = null,
  toolExecutor      = null,
  maxIterations     = 5,
  inlineDataMap     = null,   // ← MỚI 2026-06: Map<attachment_id, {mimeType, base64Data}>
}) => {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('messages phải là array không rỗng');
  }

  const url = `${GEMINI_BASE}/${model || getModel()}:generateContent?key=${getApiKey()}`;

  // Convert messages → Gemini contents. Inline ảnh được nhúng theo từng
  // message; text-extractable files vẫn đi qua tool `read_attachment`
  // (xem buildAttachmentsSystemNote).
  const contents = messages.map((m) => messageToContent(m, inlineDataMap));

  const usageAccum = {
    promptTokenCount:     0,
    candidatesTokenCount: 0,
    totalTokenCount:      0,
  };
  const toolCalls = [];
  const useTools  = Array.isArray(tools) && tools.length > 0 && typeof toolExecutor === 'function';

  for (let iter = 0; iter < maxIterations; iter++) {
    const body = {
      contents,
      generationConfig: { temperature, maxOutputTokens: 2048 },
    };
    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }
    if (useTools) {
      body.tools = [{ functionDeclarations: tools }];
    }

    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API ${res.status}: ${errText}`);
    }

    const data = await res.json();

    if (data.usageMetadata) {
      usageAccum.promptTokenCount     += data.usageMetadata.promptTokenCount     ?? 0;
      usageAccum.candidatesTokenCount += data.usageMetadata.candidatesTokenCount ?? 0;
      usageAccum.totalTokenCount      += data.usageMetadata.totalTokenCount      ?? 0;
    }

    const candidate = data.candidates?.[0];
    const parts     = candidate?.content?.parts ?? [];

    const functionCalls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    const textReply     = parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join('');

    if (!useTools || functionCalls.length === 0) {
      return {
        reply:     textReply,
        usage:     data.usageMetadata ? usageAccum : null,
        toolCalls,
      };
    }

    contents.push(candidate.content);

    const responseParts = [];
    for (const fc of functionCalls) {
      let result;
      try {
        result = await toolExecutor(fc.name, fc.args ?? {});
      } catch (err) {
        result = { success: false, error: err.message ?? String(err) };
      }
      toolCalls.push({ name: fc.name, args: fc.args ?? {}, result });

      const fnResponse = {
        name:     fc.name,
        response: { result },
      };
      if (fc.id) fnResponse.id = fc.id;

      responseParts.push({ functionResponse: fnResponse });
    }
    contents.push({ role: 'user', parts: responseParts });
  }

  return {
    reply:
      '(AI đã thực hiện hành động nhưng không kịp tổng kết — vui lòng kiểm tra danh sách task.)',
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
    return 'Bạn là trợ lý cho sinh viên Bách Khoa Hà Nội. Trả lời bằng tiếng Việt.';
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
