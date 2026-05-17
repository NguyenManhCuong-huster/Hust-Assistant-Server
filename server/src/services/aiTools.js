/**
 * src/services/aiTools.js
 *
 * Khai báo các tool (function declarations) mà AI có thể gọi, và hàm
 * tạo executor cho từng user.
 *
 * THAY ĐỔI 2025-05-04 (v2):
 *   - `create_task` thêm parameter `tag_ids` (array<UUID>) để phân loại.
 *   - System note nhận `tags` của user và liệt kê id+name+color cho model
 *     biết. Model tự pick tag nào phù hợp với title/description.
 *
 * Cách dùng từ route handler:
 *
 *   const tags = await fetchUserTags(req.user.id);    // [{ id, name, color_hex }]
 *
 *   const executor = makeTaskToolExecutor({
 *     userId: req.user.id,
 *     sourceType: 'EMAIL',
 *     sourceId:   email.id,
 *   });
 *
 *   const result = await chat({
 *     messages,
 *     systemInstruction:
 *       buildToolSystemNote({ tags }) + '\n\n' + (callerSysInstr ?? ''),
 *     tools:        TASK_TOOL_DECLARATIONS,
 *     toolExecutor: executor,
 *   });
 */

import { getClient } from '../config/db.js';

// ─────────────────────────────────────────────────────────────
// Function declarations
// ─────────────────────────────────────────────────────────────
const createTaskDeclaration = {
  name: 'create_task',
  description:
    'Tạo một task mới (việc cần làm / lịch học / lịch thi) cho người dùng đang chat. ' +
    'Chỉ gọi khi user thực sự yêu cầu lưu/tạo/thêm task hoặc nhắc nhở. ' +
    'KHÔNG gọi khi user chỉ hỏi thông tin hoặc tóm tắt. ' +
    'Nếu user nói thời gian dạng tương đối ("ngày mai 9h", "thứ 6 tuần sau"), ' +
    'hãy convert thành ISO 8601 với timezone +07:00 dựa trên thời điểm hiện tại. ' +
    'Nếu thiếu thông tin về thời gian thì cứ bỏ qua start_time/end_time, không tự bịa.',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type:        'string',
        description: 'Tiêu đề ngắn gọn của task (≤ 120 ký tự). Ví dụ: "Nộp báo cáo môn AI", "Đi khám răng".',
      },
      description: {
        type:        'string',
        description: 'Mô tả chi tiết. Có thể trống. Dùng để ghi chú thêm về task.',
      },
      start_time: {
        type:        'string',
        description:
          'Thời gian bắt đầu, ISO 8601 với timezone, ví dụ "2025-05-10T09:00:00+07:00". ' +
          'Bỏ qua nếu user không nêu.',
      },
      end_time: {
        type:        'string',
        description:
          'Thời gian kết thúc / hạn chót, ISO 8601 với timezone. ' +
          'Với task TODO không có khoảng thời gian, đặt end_time = deadline. ' +
          'Bỏ qua nếu không có thông tin.',
      },
      task_type: {
        type:        'string',
        enum:        ['TODO', 'CLASS', 'EXAM'],
        description:
          'Loại task: TODO (việc cần làm), CLASS (lịch học/buổi học), EXAM (lịch thi). ' +
          'Mặc định TODO nếu không rõ.',
      },
      tag_ids: {
        type:  'array',
        items: { type: 'string' },
        description:
          'Danh sách UUID của tag để phân loại task. CHỈ dùng các UUID có trong "Danh sách tag" ' +
          'của system instruction. Nếu không có tag nào phù hợp, bỏ qua tham số này hoặc để mảng rỗng. ' +
          'Tuyệt đối KHÔNG bịa UUID.',
      },
    },
    required: ['title'],
  },
};

export const TASK_TOOL_DECLARATIONS = [createTaskDeclaration];

// ─────────────────────────────────────────────────────────────
// System note — gắn kèm system instruction để model biết tool & tag
// ─────────────────────────────────────────────────────────────
/**
 * @param {Object}  opts
 * @param {Array=}  opts.tags  — [{ id, name, color_hex }, ...] của user
 */
export const buildToolSystemNote = ({ tags = [] } = {}) => {
  const lines = [
    'Bạn có khả năng tạo task cho user thông qua tool `create_task`.',
    `Hôm nay là ${new Date().toISOString()} (UTC).`,
    'Khi user yêu cầu "tạo task", "thêm việc", "nhắc tôi", "lưu vào todo"... → gọi tool `create_task`.',
    'Sau khi tool chạy xong, trả lời user bằng tiếng Việt, ngắn gọn, xác nhận task đã tạo (hoặc báo lỗi nếu fail).',
    'Tuyệt đối KHÔNG nói "tôi đã tạo task" nếu chưa thực sự gọi tool.',
  ];

  if (tags.length > 0) {
    lines.push('');
    lines.push('Danh sách tag user đã tạo (truyền vào tag_ids để phân loại task):');
    for (const t of tags) {
      const color = t.color_hex ? ` ${t.color_hex}` : '';
      lines.push(`  - ${t.id}: "${t.name}"${color}`);
    }
    lines.push('Pick 1 hoặc nhiều tag PHÙ HỢP với nội dung task (tag học → task học, tag công việc → task work...).');
    lines.push('Không phù hợp tag nào? Bỏ qua tag_ids — KHÔNG ép gán bừa, KHÔNG bịa UUID mới.');
  } else {
    lines.push('');
    lines.push('User chưa tạo tag nào — không pass tag_ids khi tạo task.');
  }

  return lines.join('\n');
};

// ─────────────────────────────────────────────────────────────
// Executor factory
// ─────────────────────────────────────────────────────────────
/**
 * @param {Object}  ctx
 * @param {string}  ctx.userId
 * @param {string=} ctx.sourceType  — 'MANUAL' | 'EMAIL' | 'NEWS' | 'CTT'  (mặc định 'MANUAL')
 * @param {string=} ctx.sourceId    — UUID của source khi sourceType != 'MANUAL'
 * @returns {Function}  async (toolName, args) => result
 */
export const makeTaskToolExecutor = ({
  userId,
  sourceType = 'MANUAL',
  sourceId   = null,
}) => {
  if (!userId) throw new Error('makeTaskToolExecutor: userId là bắt buộc');

  return async (toolName, args) => {
    if (toolName === 'create_task') {
      return await execCreateTask({ args, userId, sourceType, sourceId });
    }
    return { success: false, error: `Tool "${toolName}" không được hỗ trợ.` };
  };
};

// ─────────────────────────────────────────────────────────────
// Implementations
// ─────────────────────────────────────────────────────────────
const execCreateTask = async ({ args, userId, sourceType, sourceId }) => {
  // Validate
  const title = (args?.title ?? '').toString().trim();
  if (!title) {
    return { success: false, error: 'Thiếu title — không thể tạo task.' };
  }

  const taskType = (args?.task_type ?? 'TODO').toString().toUpperCase();
  if (!['TODO', 'CLASS', 'EXAM'].includes(taskType)) {
    return { success: false, error: `task_type không hợp lệ: ${taskType}` };
  }

  const normalizeTs = (v) => {
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    if (!s || s.toLowerCase() === 'null') return null;
    return s;
  };

  const description = args?.description ? String(args.description).trim() : null;
  const startTime   = normalizeTs(args?.start_time);
  const endTime     = normalizeTs(args?.end_time);

  // Sanitize tag_ids — chỉ giữ string UUID-ish, dedupe
  const rawTagIds = Array.isArray(args?.tag_ids) ? args.tag_ids : [];
  const tagIds = [...new Set(
    rawTagIds.filter((x) => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim()),
  )];

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const { rows: taskRows } = await client.query(
      `INSERT INTO tasks
         (user_id, title, description, start_time, end_time, task_type, source_type, source_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, title, description, start_time, end_time, task_type, is_completed,
                 source_type, source_id, mod_time`,
      [userId, title, description, startTime, endTime, taskType, sourceType, sourceId],
    );
    const task = taskRows[0];

    // Attach tags — chỉ tag thuộc user (security) và còn sống
    let attachedTags = [];
    if (tagIds.length > 0) {
      const valid = await client.query(
        `SELECT id, name, color_hex
         FROM tags
         WHERE id = ANY($1) AND user_id = $2 AND is_deleted = FALSE`,
        [tagIds, userId],
      );
      for (const t of valid.rows) {
        await client.query(
          `INSERT INTO task_tag_cross_ref (task_id, tag_id, is_deleted)
           VALUES ($1, $2, FALSE)
           ON CONFLICT (task_id, tag_id)
             DO UPDATE SET is_deleted = FALSE, mod_time = CURRENT_TIMESTAMP`,
          [task.id, t.id],
        );
      }
      attachedTags = valid.rows;
    }

    await client.query('COMMIT');

    return {
      success: true,
      task: {
        id:         task.id,
        title:      task.title,
        start_time: task.start_time,
        end_time:   task.end_time,
        task_type:  task.task_type,
        tags:       attachedTags,         // [{ id, name, color_hex }]
      },
    };
  } catch (err) {
    await client.query('ROLLBACK');
    return { success: false, error: err.message ?? String(err) };
  } finally {
    client.release();
  }
};
