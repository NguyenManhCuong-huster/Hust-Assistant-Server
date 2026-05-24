const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const getModel  = () => process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const getApiKey = () => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY chưa được set trong .env');
  return key;
};

// ─────────────────────────────────────────────────────────────
// chat — hàm chính
// ─────────────────────────────────────────────────────────────
/**
 * @param {Object}   opts
 * @param {Array}    opts.messages           — [{ role: 'user'|'assistant', content }, ...]
 * @param {string=}  opts.systemInstruction  — instruction cố định
 * @param {string=}  opts.model              — override model
 * @param {number=}  opts.temperature        — mặc định 0.7
 * @param {Array=}   opts.tools              — function declarations (OpenAPI-style)
 * @param {Function=}opts.toolExecutor       — async (name, args) => result
 * @param {number=}  opts.maxIterations      — số vòng tool-loop tối đa, mặc định 5
 *
 * @returns {Promise<{
 *   reply: string,
 *   usage: object|null,
 *   toolCalls: Array<{ name, args, result }>
 * }>}
 */
export const chat = async ({
  messages,
  systemInstruction = null,
  model             = null,
  temperature       = 0.7,
  tools             = null,
  toolExecutor      = null,
  maxIterations     = 5,
}) => {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('messages phải là array không rỗng');
  }

  const url = `${GEMINI_BASE}/${model || getModel()}:generateContent?key=${getApiKey()}`;

  // Map role 'assistant' → 'model' (Gemini convention)
  const contents = messages.map((m) => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content ?? '') }],
  }));

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

    // Accumulate usage
    if (data.usageMetadata) {
      usageAccum.promptTokenCount     += data.usageMetadata.promptTokenCount     ?? 0;
      usageAccum.candidatesTokenCount += data.usageMetadata.candidatesTokenCount ?? 0;
      usageAccum.totalTokenCount      += data.usageMetadata.totalTokenCount      ?? 0;
    }

    const candidate = data.candidates?.[0];
    const parts     = candidate?.content?.parts ?? [];

    // Tách functionCall vs text trong các parts
    const functionCalls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    const textReply     = parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join('');

    // Không có tool call → kết thúc, trả text
    if (!useTools || functionCalls.length === 0) {
      return {
        reply:     textReply,
        usage:     data.usageMetadata ? usageAccum : null,
        toolCalls,
      };
    }

    // Có tool call → append model turn vào conversation
    contents.push(candidate.content);

    // Execute từng function call (tuần tự cho đơn giản; Gemini không yêu cầu thứ tự)
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
      // Gemini 3 luôn trả `id`; Gemini 1.5 thì không. Chỉ pass khi có.
      if (fc.id) fnResponse.id = fc.id;

      responseParts.push({ functionResponse: fnResponse });
    }
    contents.push({ role: 'user', parts: responseParts });
  }

  // Quá maxIterations — model vẫn chỉ gọi tool, không text. Trả thông báo.
  return {
    reply:
      '(AI đã thực hiện hành động nhưng không kịp tổng kết — vui lòng kiểm tra danh sách task.)',
    usage:     usageAccum,
    toolCalls,
  };
};

// ─────────────────────────────────────────────────────────────
// buildEmailSystemInstruction — không đổi
// ─────────────────────────────────────────────────────────────
export const buildEmailSystemInstruction = (thread) => {
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
  lines.push('');
  lines.push('Khi user yêu cầu "soạn phản hồi" hoặc "viết reply", trả về thẳng nội dung email phản hồi (không giải thích thêm), bắt đầu bằng dòng "Subject: Re: ...".');
  return lines.join('\n');
};
