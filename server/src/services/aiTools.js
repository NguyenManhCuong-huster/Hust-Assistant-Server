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
    'Nếu thiếu thông tin về thời gian thì cứ bỏ qua start_time/end_time, không tự bịa. ' +
    'Với task LẶP HẰNG TUẦN (TKB, gym mỗi T3, uống thuốc mỗi sáng...), ' +
    'KHÔNG dùng tool này — dùng `create_weekly_tasks`.',
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

const createWeeklyTasksDeclaration = {
  name: 'create_weekly_tasks',
  description:
    'Tạo nhiều task LẶP HẰNG TUẦN trong một khoảng thời gian. ' +
    'Mỗi ngày trong [loop_start_date .. loop_end_date] (inclusive) rơi vào `day_of_week` ' +
    'sẽ sinh ra 1 task riêng. ' +
    'Dùng cho mọi loại task lặp tuần: lịch học (TKB), lịch thi định kỳ, đi gym, uống thuốc, ' +
    'họp định kỳ, học nhóm hằng tuần, đi chợ cuối tuần, v.v.' +
    '\n\n' +
    'AI PHẢI tự tính `loop_start_date` và `loop_end_date` thành ngày cụ thể (YYYY-MM-DD) ' +
    'trước khi gọi tool — server KHÔNG hiểu mô tả tương đối. ' +
    'Dùng ngày hôm nay (đã có ở system note) làm mốc. ' +
    'Ví dụ: "gym mỗi Thứ 3 trong 1 tháng tới" → loop_start_date = hôm nay, loop_end_date = hôm nay + 30 ngày. ' +
    'Ví dụ TKB HUST: user paste "Thứ 4, tuần 25-32" + nói "Tuần 1 bắt đầu 02/09/2024" → ' +
    'AI tự tính loop_start_date = 02/09/2024 + 24*7 = 2025-02-17, ' +
    'loop_end_date = loop_start_date + (32-25)*7 + 6 = 2025-04-13.' +
    '\n\n' +
    'GỌI NHIỀU LẦN khi:' +
    '\n' +
    '  - Nhiều khoảng không liên tục (vd TKB "tuần 25-32, 34-42" — bỏ tuần 33 thi giữa kỳ): ' +
    'gọi 2 lần, mỗi khoảng 1 lần.' +
    '\n' +
    '  - Nhiều thứ khác nhau (vd "gym mỗi T3 và T5"): gọi 2 lần với day_of_week khác nhau.' +
    '\n' +
    '  - Nhiều lớp khác nhau trong cùng TKB: gọi N lần (parallel cùng turn được).',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type:        'string',
        description:
          'Tiêu đề ngắn gọn (≤ 120 ký tự). ' +
          'Vd: "Tối ưu lập kế hoạch (LT+BT)", "Đi gym buổi sáng", "Họp dự án X", "Uống thuốc huyết áp".',
      },
      description: {
        type:        'string',
        description:
          'Mô tả chi tiết (optional). Vd với TKB: "Phòng D9-303 • GV: Dương Quang Huy • Mã lớp: 168498". ' +
          'Vd với gym: "Tập chân + lưng theo lịch coach".',
      },
      day_of_week: {
        type:        'integer',
        description:
          'Thứ trong tuần theo ISO 8601: 1=Thứ 2 (Mon), 2=Thứ 3, 3=Thứ 4, 4=Thứ 5, ' +
          '5=Thứ 6, 6=Thứ 7, 7=Chủ Nhật (Sun). ' +
          'CHỈ 1 thứ duy nhất mỗi lần gọi. Nếu user nói "T3 và T5" thì gọi tool 2 lần.',
      },
      start_time_of_day: {
        type:        'string',
        description:
          'Giờ bắt đầu mỗi buổi, format "HH:mm" (24h, giờ VN +07:00). Vd "14:10". ' +
          'OPTIONAL — bỏ qua nếu task không có giờ cụ thể (vd "uống thuốc mỗi T3"). ' +
          'Nếu cung cấp `start_time_of_day` thì BẮT BUỘC cung cấp `end_time_of_day`.',
      },
      end_time_of_day: {
        type:        'string',
        description:
          'Giờ kết thúc mỗi buổi, format "HH:mm". OPTIONAL (theo cặp với start_time_of_day).',
      },
      loop_start_date: {
        type:        'string',
        description:
          'Ngày bắt đầu lặp (inclusive), format "YYYY-MM-DD" (giờ VN). ' +
          'Task đầu tiên là ngày `day_of_week` đầu tiên >= loop_start_date. ' +
          'Vd loop_start_date="2025-02-17" (T2), day_of_week=4 (Thứ 5) → task đầu = 2025-02-20.',
      },
      loop_end_date: {
        type:        'string',
        description:
          'Ngày kết thúc lặp (inclusive), format "YYYY-MM-DD". ' +
          'Task cuối là ngày `day_of_week` cuối cùng <= loop_end_date.',
      },
      task_type: {
        type:        'string',
        enum:        ['TODO', 'CLASS', 'EXAM'],
        description:
          'TODO = việc cần làm lặp lại (gym, uống thuốc, đi chợ, họp định kỳ...). ' +
          'CLASS = lịch học/buổi học định kỳ (TKB). ' +
          'EXAM = lịch thi (hiếm khi lặp tuần, nhưng có thể). ' +
          'Mặc định TODO nếu không rõ.',
      },
      tag_ids: {
        type:  'array',
        items: { type: 'string' },
        description:
          'Danh sách UUID tag (chỉ dùng UUID có trong system instruction, không bịa). ' +
          'Tất cả task sinh ra sẽ được gán cùng bộ tag này.',
      },
    },
    required: [
      'title', 'day_of_week', 'loop_start_date', 'loop_end_date',
    ],
  },
};

export const TASK_TOOL_DECLARATIONS = [
  createTaskDeclaration,
  createWeeklyTasksDeclaration,
];

// ─────────────────────────────────────────────────────────────
// System note — gắn kèm system instruction để model biết tool & tag
// ─────────────────────────────────────────────────────────────
/**
 * @param {Object}  opts
 * @param {Array=}  opts.tags  — [{ id, name, color_hex }, ...] của user
 */
export const buildToolSystemNote = ({ tags = [] } = {}) => {
  const lines = [
    'Bạn có các tool sau để thao tác task cho user:',
    '  - `create_task`: tạo 1 task đơn lẻ.',
    '  - `create_weekly_tasks`: tạo nhiều task LẶP HẰNG TUẦN trong 1 khoảng thời gian.',
    `Hôm nay là ${new Date().toISOString()} (UTC). Múi giờ user: +07:00 (giờ VN).`,
    '',
    'Khi user yêu cầu "tạo task", "thêm việc", "nhắc tôi"... cho 1 sự kiện đơn → `create_task`.',
    'Khi user yêu cầu task LẶP HẰNG TUẦN (TKB, gym mỗi T3, uống thuốc mỗi sáng,',
    'họp định kỳ thứ 6, v.v.) → `create_weekly_tasks`. Mỗi (thứ × khoảng) gọi 1 lần.',
    'KHÔNG dùng `create_task` rồi loop tay nhiều lần — tốn token và sai design.',
    '',
    'QUAN TRỌNG về `create_weekly_tasks`:',
    '  - Server chỉ nhận NGÀY CỤ THỂ: `loop_start_date` và `loop_end_date` (YYYY-MM-DD).',
    '  - AI tự convert mô tả thời gian thành ngày trước khi gọi tool.',
    '    Vd "trong 1 tháng tới" → loop_start = hôm nay, loop_end = hôm nay + 30 ngày.',
    '    Vd "đến hết tháng 6" → AI tự tính ra loop_end = ngày cuối tháng 6.',
    '  - Convention `day_of_week`: ISO 8601 (1=Thứ 2 ... 7=Chủ Nhật). KHÔNG nhầm với CTT HUST (2..8).',
    '  - Trường hợp TKB HUST (user paste "tuần 25-32"): AI cần biết Tuần 1 của kỳ bắt đầu hôm nào',
    '    để convert ra ngày thực. Nếu user CHƯA cho biết → HỎI trước, TUYỆT ĐỐI không tự đoán.',
    '  - Khoảng không liên tục ("tuần 25-32, 34-42") → gọi tool NHIỀU LẦN, mỗi khoảng 1 lần.',
    '  - Nhiều thứ trong tuần ("gym T3 và T5") → gọi NHIỀU LẦN, mỗi thứ 1 lần.',
    '',
    'Sau khi tool chạy xong, trả lời user bằng tiếng Việt, ngắn gọn, xác nhận đã tạo (hoặc báo lỗi).',
    'Tuyệt đối KHÔNG nói "tôi đã tạo task" nếu chưa thực sự gọi tool.',
  ];

  if (tags.length > 0) {
    lines.push('');
    lines.push('Danh sách tag user đã tạo (truyền vào tag_ids để phân loại task):');
    for (const t of tags) {
      const color = t.color_hex ? ` ${t.color_hex}` : '';
      lines.push(`  - ${t.id}: "${t.name}"${color}`);
    }
    lines.push('Pick 1 hoặc nhiều tag PHÙ HỢP với nội dung task.');
    lines.push('Không phù hợp tag nào? Bỏ qua tag_ids — KHÔNG ép gán bừa, KHÔNG bịa UUID mới.');
  } else {
    lines.push('');
    lines.push('User chưa tạo tag nào — không pass tag_ids khi tạo task.');
  }

  return lines.join('\n');
};

// ─────────────────────────────────────────────────────────────
// User profile system note
// ─────────────────────────────────────────────────────────────
/**
 * buildUserInfoSystemNote — sinh đoạn note mô tả user đang chat.
 * Được prepend vào systemInstruction (KHÔNG nằm trong messages) nên
 * KHÔNG bao giờ hiện ở chat UI.
 *
 * @param {Object}  opts
 * @param {Object=} opts.userInfo   — row từ bảng user_info, có thể null
 * @param {string=} opts.userEmail  — email từ bảng users
 * @returns {string}
 */
export const buildUserInfoSystemNote = ({ userInfo = null, userEmail = null } = {}) => {
  const lines = [];

  if (userInfo?.full_name)  lines.push(`  - Tên: ${userInfo.full_name}`);
  if (userInfo?.student_id) lines.push(`  - MSSV: ${userInfo.student_id}`);
  if (userEmail)            lines.push(`  - Email: ${userEmail}`);
  if (userInfo?.school)     lines.push(`  - Trường/Viện: ${userInfo.school}`);
  if (userInfo?.major)      lines.push(`  - Ngành: ${userInfo.major}`);
  if (userInfo?.class_name) lines.push(`  - Lớp: ${userInfo.class_name}`);
  if (userInfo?.course)     lines.push(`  - Khoá: ${userInfo.course}`);

  if (lines.length === 0) {
    return 'Thông tin user đang chat: (chưa khai báo profile).';
  }

  return [
    'Thông tin user đang chat (CHỈ để hiểu ngữ cảnh — KHÔNG nhắc lại',
    'trong reply trừ khi user hỏi trực tiếp về profile của họ):',
    ...lines,
    'Ưu tiên xưng hô theo tên ngắn khi phù hợp.',
    'Tận dụng khoá học (vd K66 → năm 4, K68 → năm 2) và ngành để gợi ý task chính xác hơn.',
  ].join('\n');
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
    if (toolName === 'create_weekly_tasks') {
      // KHÔNG còn auto-override source_type='CTT' nữa — tool đã tổng quát,
      // không nhất thiết là TKB. Caller (route handler) quyết định source.
      return await execCreateWeeklyTasks({ args, userId, sourceType, sourceId });
    }
    return { success: false, error: `Tool "${toolName}" không được hỗ trợ.` };
  };
};

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
const normalizeTs = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s || s.toLowerCase() === 'null') return null;
  return s;
};

const sanitizeTagIds = (raw) => {
  const arr = Array.isArray(raw) ? raw : [];
  return [...new Set(
    arr.filter((x) => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim()),
  )];
};

/** "14:10" → "14:10:00"; trả null nếu sai format. */
const normalizeTimeOfDay = (v) => {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const h  = Number(m[1]);
  const mi = Number(m[2]);
  const s  = m[3] ? Number(m[3]) : 0;
  if (h > 23 || mi > 59 || s > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

/**
 * "YYYY-MM-DD" → epoch ms tại 00:00 UTC của ngày đó.
 * Trả null nếu format sai hoặc ngày không tồn tại (vd "2025-02-30").
 */
const parseDateIso = (iso) => {
  if (typeof iso !== 'string') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(dt.getTime())) return null;
  // Roundtrip check: bắt được "2025-02-30" → JS sẽ overflow thành 2025-03-02.
  if (formatDateIso(dt) !== iso) return null;
  return dt.getTime();
};

/** Date → "YYYY-MM-DD" (UTC parts). */
const formatDateIso = (dt) => {
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

/** ISO 8601 weekday: 1=Mon ... 7=Sun. */
const isoWeekday = (dt) => {
  const j = dt.getUTCDay(); // 0=Sun..6=Sat
  return j === 0 ? 7 : j;
};

// ─────────────────────────────────────────────────────────────
// execCreateTask — không đổi
// ─────────────────────────────────────────────────────────────
const execCreateTask = async ({ args, userId, sourceType, sourceId }) => {
  const title = (args?.title ?? '').toString().trim();
  if (!title) {
    return { success: false, error: 'Thiếu title — không thể tạo task.' };
  }

  const taskType = (args?.task_type ?? 'TODO').toString().toUpperCase();
  if (!['TODO', 'CLASS', 'EXAM'].includes(taskType)) {
    return { success: false, error: `task_type không hợp lệ: ${taskType}` };
  }

  const description = args?.description ? String(args.description).trim() : null;
  const startTime   = normalizeTs(args?.start_time);
  const endTime     = normalizeTs(args?.end_time);
  const tagIds      = sanitizeTagIds(args?.tag_ids);

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
        tags:       attachedTags,
      },
    };
  } catch (err) {
    await client.query('ROLLBACK');
    return { success: false, error: err.message ?? String(err) };
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────────────────────
// execCreateWeeklyTasks — TỔNG QUÁT (v5)
//
// Iterate ngày trong [loop_start_date .. loop_end_date], chọn những
// ngày rơi vào day_of_week, sinh 1 task/ngày trong 1 transaction.
// ─────────────────────────────────────────────────────────────
const execCreateWeeklyTasks = async ({ args, userId, sourceType, sourceId }) => {
  // ---- Validate title ----
  const title = (args?.title ?? '').toString().trim();
  if (!title) return { success: false, error: 'Thiếu title.' };

  // ---- Validate day_of_week (ISO 1..7) ----
  const dayOfWeek = Number(args?.day_of_week);
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 1 || dayOfWeek > 7) {
    return {
      success: false,
      error: `day_of_week không hợp lệ (cần 1..7 theo ISO 8601: 1=Thứ 2 ... 7=Chủ Nhật, ` +
             `nhận: ${args?.day_of_week}).`,
    };
  }

  // ---- Validate loop range ----
  const loopStart = String(args?.loop_start_date ?? '').trim();
  const loopEnd   = String(args?.loop_end_date ?? '').trim();
  const startMs   = parseDateIso(loopStart);
  const endMs     = parseDateIso(loopEnd);
  if (startMs === null) {
    return { success: false, error: `loop_start_date phải dạng YYYY-MM-DD và là ngày hợp lệ (nhận: "${loopStart}").` };
  }
  if (endMs === null) {
    return { success: false, error: `loop_end_date phải dạng YYYY-MM-DD và là ngày hợp lệ (nhận: "${loopEnd}").` };
  }
  if (startMs > endMs) {
    return { success: false, error: `loop_start_date (${loopStart}) phải <= loop_end_date (${loopEnd}).` };
  }

  // ---- Validate times of day (BOTH hoặc NEITHER) ----
  const rawStart = args?.start_time_of_day;
  const rawEnd   = args?.end_time_of_day;
  const startHm  = rawStart ? normalizeTimeOfDay(rawStart) : null;
  const endHm    = rawEnd   ? normalizeTimeOfDay(rawEnd)   : null;
  if (rawStart && !startHm) return { success: false, error: `start_time_of_day không hợp lệ: "${rawStart}"` };
  if (rawEnd && !endHm)     return { success: false, error: `end_time_of_day không hợp lệ: "${rawEnd}"` };
  if (Boolean(startHm) !== Boolean(endHm)) {
    return {
      success: false,
      error: 'Phải cung cấp CẢ start_time_of_day và end_time_of_day, hoặc bỏ qua cả hai.',
    };
  }
  const hasTime = Boolean(startHm && endHm);

  // ---- Validate task_type ----
  const taskType = (args?.task_type ?? 'TODO').toString().toUpperCase();
  if (!['TODO', 'CLASS', 'EXAM'].includes(taskType)) {
    return { success: false, error: `task_type không hợp lệ: "${taskType}". Phải là TODO, CLASS, hoặc EXAM.` };
  }

  const description = args?.description ? String(args.description).trim() : null;
  const tagIds      = sanitizeTagIds(args?.tag_ids);

  // ─────────────────────────────────────────────────
  // Build session date list
  // ─────────────────────────────────────────────────
  // Tìm ngày đầu tiên >= loop_start_date mà rơi vào day_of_week.
  // Sau đó cộng dồn 7 ngày cho đến khi vượt loop_end_date.
  const startDt    = new Date(startMs);
  const startDow   = isoWeekday(startDt);                 // 1..7
  const advance    = (dayOfWeek - startDow + 7) % 7;      // 0..6 days to advance

  const dates = [];
  const cursor = new Date(startMs);
  cursor.setUTCDate(cursor.getUTCDate() + advance);
  while (cursor.getTime() <= endMs) {
    dates.push(formatDateIso(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }

  if (dates.length === 0) {
    return {
      success: false,
      error: `Không có ngày nào trong khoảng ${loopStart} → ${loopEnd} rơi vào day_of_week=${dayOfWeek}.`,
    };
  }

  // Build start_time / end_time ISO 8601 với offset +07:00 (giờ VN).
  //   - Có time-of-day: dùng giờ AI cung cấp.
  //   - Không có: start_time = null, end_time = ngày đó lúc 23:59 (deadline cuối ngày).
  const sessions = dates.map((d) => ({
    start_time: hasTime ? `${d}T${startHm}+07:00` : null,
    end_time:   hasTime ? `${d}T${endHm}+07:00`   : `${d}T23:59:00+07:00`,
  }));

  // ─────────────────────────────────────────────────
  // Insert batch trong 1 transaction
  // ─────────────────────────────────────────────────
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const titles       = sessions.map(() => title);
    const descriptions = sessions.map(() => description);
    const startTimes   = sessions.map((s) => s.start_time);   // text[] có thể chứa null
    const endTimes     = sessions.map((s) => s.end_time);

    const { rows: taskRows } = await client.query(
      `INSERT INTO tasks
         (user_id, title, description, start_time, end_time, task_type, source_type, source_id)
       SELECT $1, t.title, t.description, t.start_time::timestamptz, t.end_time::timestamptz,
              $2, $3, $4
       FROM UNNEST($5::text[], $6::text[], $7::text[], $8::text[])
         AS t(title, description, start_time, end_time)
       RETURNING id, start_time, end_time`,
      [
        userId, taskType, sourceType, sourceId,
        titles, descriptions, startTimes, endTimes,
      ],
    );

    // Attach tags: cross product mỗi task × mỗi valid tag
    let attachedTags = [];
    if (tagIds.length > 0 && taskRows.length > 0) {
      const valid = await client.query(
        `SELECT id, name, color_hex
         FROM tags
         WHERE id = ANY($1) AND user_id = $2 AND is_deleted = FALSE`,
        [tagIds, userId],
      );
      if (valid.rows.length > 0) {
        const taskIds   = taskRows.map((r) => r.id);
        const tagIdList = valid.rows.map((r) => r.id);
        await client.query(
          `INSERT INTO task_tag_cross_ref (task_id, tag_id, is_deleted)
           SELECT t.task_id, g.tag_id, FALSE
           FROM UNNEST($1::uuid[]) AS t(task_id)
           CROSS JOIN UNNEST($2::uuid[]) AS g(tag_id)
           ON CONFLICT (task_id, tag_id)
             DO UPDATE SET is_deleted = FALSE, mod_time = CURRENT_TIMESTAMP`,
          [taskIds, tagIdList],
        );
        attachedTags = valid.rows;
      }
    }

    await client.query('COMMIT');

    // Sort task rows theo start_time (fallback end_time nếu start null)
    taskRows.sort((a, b) => {
      const ka = new Date(a.start_time ?? a.end_time).getTime();
      const kb = new Date(b.start_time ?? b.end_time).getTime();
      return ka - kb;
    });
    const first = taskRows[0];
    const last  = taskRows[taskRows.length - 1];

    return {
      success: true,
      summary: {
        title,
        task_type:        taskType,
        created:          taskRows.length,
        skipped:          0,                 // Logic mới không có gì để skip
        day_of_week:      dayOfWeek,         // ISO 1..7
        loop_start_date:  loopStart,
        loop_end_date:    loopEnd,
        // Có thể null khi không có time-of-day. Mapper client fall back về end_time.
        first_start_time: first?.start_time ?? null,
        last_start_time:  last?.start_time  ?? null,
        first_end_time:   first?.end_time   ?? null,
        last_end_time:    last?.end_time    ?? null,
        tags:             attachedTags,
      },
      task_ids: taskRows.map((r) => r.id),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    return { success: false, error: err.message ?? String(err) };
  } finally {
    client.release();
  }
};
