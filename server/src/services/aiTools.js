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
    'Với TKB lặp theo tuần (nhiều buổi cùng môn), KHÔNG dùng tool này — dùng `create_weekly_tasks` 1 lần cho cả môn.',
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
    'Tạo nhiều task lặp lại theo tuần cho 1 lớp học trong Thời Khoá Biểu (TKB). ' +
    'Mỗi tuần trong `weeks` sinh ra 1 task riêng (vd weeks=[25,26,...,32] → 8 task). ' +
    'AI nên gọi tool này 1 lần cho MỖI LỚP trong TKB (gọi parallel nhiều lần cùng turn nếu user paste TKB cả kỳ). ' +
    '\n\n' +
    'YÊU CẦU BẮT BUỘC về `week_1_start_date`: ' +
    'Đây là ngày Thứ Hai của Tuần 1 trong kỳ học hiện tại. ' +
    'CTT HUST đánh số tuần liên tục qua các kỳ (vd kỳ 20242 có thể bắt đầu từ tuần 25), ' +
    'nên không có cách nào đoán đúng nếu user không nói. ' +
    'NẾU user chưa cung cấp thông tin này (qua câu hỏi trước hoặc trong TKB họ paste), ' +
    'KHÔNG được gọi tool này — phải hỏi user trước, ví dụ: ' +
    '"Để chuyển số tuần (vd tuần 25-32) thành ngày thực, mình cần biết Tuần 1 của kỳ bắt đầu vào ngày Thứ Hai nào. ' +
    'Bạn xem giúp trên CTT mục \'Lịch học, lịch thi theo tuần\' và cho mình biết được không?" ' +
    'TUYỆT ĐỐI KHÔNG tự đoán mốc tuần 1.',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type:        'string',
        description:
          'Tên môn + loại lớp. Vd: "Tối ưu lập kế hoạch (LT+BT)", "Đồ án tốt nghiệp". ' +
          'KHÔNG nhét tuần / thứ vào title — đã có ở field khác.',
      },
      description: {
        type:        'string',
        description:
          'Mô tả gộp các info phụ: phòng, giảng viên, mã lớp, nhóm, link online, hình thức. ' +
          'Format thoải mái, vd: "Phòng D9-303 • GV: Dương Quang Huy • Mã lớp: 168498 • Nhóm: TC".',
      },
      day_of_week: {
        type:        'integer',
        description:
          'Thứ trong tuần theo convention CTT HUST: 2=Thứ 2, 3=Thứ 3, ..., 7=Thứ 7, 8=Chủ Nhật. ' +
          'Vd "Thứ 4,14h10-17h30" → day_of_week=4.',
      },
      start_time_of_day: {
        type:        'string',
        description: 'Giờ bắt đầu buổi học trong ngày, format "HH:mm" (24h, giờ VN +07:00). Vd "14:10".',
      },
      end_time_of_day: {
        type:        'string',
        description: 'Giờ kết thúc buổi học, format "HH:mm". Vd "17:30".',
      },
      weeks: {
        type:  'array',
        items: { type: 'integer' },
        description:
          'Danh sách số tuần học (theo cách CTT đánh số). ' +
          'PHẢI expand range, KHÔNG được dùng chuỗi "25-32". ' +
          'Vd "25-32,34-42" → [25,26,27,28,29,30,31,32,34,35,36,37,38,39,40,41,42] (bỏ tuần 33 thi giữa kỳ).',
      },
      week_1_start_date: {
        type:        'string',
        description:
          'Ngày Thứ Hai của Tuần 1 trong kỳ, format ISO date "YYYY-MM-DD" (giờ VN). ' +
          'Vd nếu user nói "Tuần 25 từ 17/02/2025 đến 23/02/2025" thì Tuần 1 = 17/02/2025 - 7*24 = ' +
          'cần lùi (25-1)=24 tuần để ra Tuần 1, kết quả "2024-09-02". ' +
          'TUYỆT ĐỐI không tự bịa — phải hỏi user nếu chưa biết.',
      },
      task_type: {
        type:        'string',
        enum:        ['CLASS', 'EXAM'],
        description: 'CLASS cho lịch học bình thường, EXAM cho lịch thi. Mặc định CLASS.',
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
      'title', 'day_of_week', 'start_time_of_day', 'end_time_of_day',
      'weeks', 'week_1_start_date',
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
    '  - `create_task`: tạo 1 task đơn lẻ (việc cần làm / lịch học 1 buổi / lịch thi).',
    '  - `create_weekly_tasks`: tạo nhiều task lặp tuần cho 1 lớp trong TKB.',
    `Hôm nay là ${new Date().toISOString()} (UTC). Múi giờ user: +07:00 (giờ VN).`,
    '',
    'Khi user yêu cầu "tạo task", "thêm việc", "nhắc tôi"... → `create_task`.',
    'Khi user paste TKB hoặc nói "tạo task từ TKB", "import lịch học cả kỳ"... → `create_weekly_tasks`,',
    'gọi 1 lần cho MỖI LỚP (parallel nhiều lần cùng turn được).',
    '',
    'QUAN TRỌNG về `create_weekly_tasks`:',
    '  - Param `week_1_start_date` (Thứ 2 của Tuần 1 trong kỳ) BẮT BUỘC user cung cấp.',
    '  - Nếu user paste TKB nhưng KHÔNG nói tuần 1 bắt đầu hôm nào → HỎI user trước,',
    '    giải thích "mình cần biết để chuyển số tuần (vd 25-32) thành ngày thực".',
    '  - TUYỆT ĐỐI không tự đoán mốc tuần 1 dù có biết kỳ hiện tại.',
    '  - Tuần học dạng "25-32,34-42" phải EXPAND thành array số nguyên đầy đủ, không pass nguyên chuỗi.',
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
// User profile system note   (MỚI 2026-05-24)
// ─────────────────────────────────────────────────────────────
/**
 * buildUserInfoSystemNote — sinh đoạn note mô tả user đang chat.
 *
 * Được prepend vào systemInstruction (KHÔNG nằm trong messages) nên
 * KHÔNG bao giờ hiện ở chat UI. Model thấy → có ngữ cảnh để:
 *   - Xưng hô đúng tên user.
 *   - Suy luận năm học từ "course" (vd K66 → khoá 2021 → đang năm cuối).
 *   - Gợi ý task phù hợp với chuyên ngành / trường-viện.
 *
 * QUYẾT ĐỊNH THIẾT KẾ:
 *   - CHỈ đưa field "không nhạy cảm" cho model: email, tên, MSSV, trường,
 *     ngành, lớp, khoá.
 *   - KHÔNG đưa phone, date_of_birth — không cần cho gợi ý task, tránh
 *     model vô tình lặp lại làm leak thông tin.
 *   - Bỏ field null/blank để note gọn, tiết kiệm token.
 *   - Dặn model KHÔNG lặp lại thông tin trong reply trừ khi user hỏi —
 *     tránh "Xin chào Nguyễn Văn A, MSSV 20226XXX..." ở mọi reply.
 *
 * @param {Object}  opts
 * @param {Object=} opts.userInfo   — row từ bảng user_info, có thể null
 * @param {string=} opts.userEmail  — email từ bảng users (luôn có nếu logged-in)
 * @returns {string}  — chuỗi đã format (luôn non-empty, có fallback)
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
    // User chưa đăng nhập hoặc chưa khai báo profile — báo model biết để
    // không cố cá nhân hoá khi chưa có dữ kiện.
    return 'Thông tin user đang chat: (chưa khai báo profile).';
  }

  return [
    'Thông tin user đang chat (CHỈ để hiểu ngữ cảnh — KHÔNG nhắc lại',
    'trong reply trừ khi user hỏi trực tiếp về profile của họ):',
    ...lines,
    'Ưu tiên xưng hô theo tên ngắn khi phù hợp.',
    'Tận dụng khoá học và ngành để gợi ý task chính xác hơn.',
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
      // TKB-related → ép source_type = 'CTT' nếu caller chưa cho biết source riêng
      const wkSourceType = sourceType === 'MANUAL' ? 'CTT' : sourceType;
      return await execCreateWeeklyTasks({
        args, userId,
        sourceType: wkSourceType,
        sourceId,
      });
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

/**
 * Tính ngày của buổi học từ (week_1_monday, week_num, day_of_week).
 *
 * @param {string} week1MondayIso  — "YYYY-MM-DD", Thứ Hai của Tuần 1
 * @param {number} weekNum         — số tuần (vd 25)
 * @param {number} dayOfWeek       — 2=T2 ... 7=T7, 8=CN (theo CTT HUST)
 * @returns {string|null}          — "YYYY-MM-DD" hoặc null nếu input lỗi
 */
const computeSessionDate = (week1MondayIso, weekNum, dayOfWeek) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week1MondayIso)) return null;
  if (!Number.isInteger(weekNum) || weekNum < 1) return null;
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 2 || dayOfWeek > 8) return null;

  // Parse như local date (tránh timezone shift của new Date('YYYY-MM-DD'))
  const [y, m, d] = week1MondayIso.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));  // dùng UTC để cộng ngày sạch
  const offsetDays = (weekNum - 1) * 7 + (dayOfWeek - 2);
  base.setUTCDate(base.getUTCDate() + offsetDays);

  const yy = base.getUTCFullYear();
  const mm = String(base.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(base.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
};

/** "14:10" → "14:10:00" hợp lệ; trả null nếu sai format. */
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

// ─────────────────────────────────────────────────────────────
// execCreateTask — không đổi logic, chỉ refactor dùng helper
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
// execCreateWeeklyTasks — loop tạo nhiều task trong 1 transaction
// ─────────────────────────────────────────────────────────────
const execCreateWeeklyTasks = async ({ args, userId, sourceType, sourceId }) => {
  // ---- Validate input ----
  const title = (args?.title ?? '').toString().trim();
  if (!title) return { success: false, error: 'Thiếu title.' };

  const dayOfWeek = Number(args?.day_of_week);
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 2 || dayOfWeek > 8) {
    return { success: false, error: `day_of_week không hợp lệ (cần 2..8, nhận ${args?.day_of_week})` };
  }

  const startHm = normalizeTimeOfDay(args?.start_time_of_day);
  const endHm   = normalizeTimeOfDay(args?.end_time_of_day);
  if (!startHm) return { success: false, error: `start_time_of_day không hợp lệ: ${args?.start_time_of_day}` };
  if (!endHm)   return { success: false, error: `end_time_of_day không hợp lệ: ${args?.end_time_of_day}` };

  const weeksRaw = Array.isArray(args?.weeks) ? args.weeks : [];
  const weeks = [...new Set(
    weeksRaw.map((w) => Number(w)).filter((w) => Number.isInteger(w) && w >= 1 && w <= 53),
  )].sort((a, b) => a - b);
  if (weeks.length === 0) {
    return { success: false, error: 'weeks rỗng hoặc không hợp lệ.' };
  }

  const week1 = String(args?.week_1_start_date ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week1)) {
    return { success: false, error: `week_1_start_date phải dạng YYYY-MM-DD (nhận: "${week1}").` };
  }

  const taskType = (args?.task_type ?? 'CLASS').toString().toUpperCase();
  if (!['CLASS', 'EXAM'].includes(taskType)) {
    return { success: false, error: `task_type không hợp lệ: ${taskType}` };
  }

  const description = args?.description ? String(args.description).trim() : null;
  const tagIds      = sanitizeTagIds(args?.tag_ids);

  // ---- Build session list ----
  const sessions = [];
  const skipped  = [];
  for (const w of weeks) {
    const date = computeSessionDate(week1, w, dayOfWeek);
    if (!date) { skipped.push({ week: w, reason: 'compute_date_failed' }); continue; }
    // ISO 8601 với offset +07:00 (giờ VN)
    sessions.push({
      week:       w,
      start_time: `${date}T${startHm}+07:00`,
      end_time:   `${date}T${endHm}+07:00`,
    });
  }
  if (sessions.length === 0) {
    return { success: false, error: 'Không sinh được session hợp lệ từ weeks.' };
  }

  // ---- Insert batch trong 1 transaction ----
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Bulk insert qua UNNEST (nhanh hơn loop INSERT cho 60-90 row)
    const titles       = sessions.map(() => title);
    const descriptions = sessions.map(() => description);
    const startTimes   = sessions.map((s) => s.start_time);
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

    // Attach tags (giống execCreateTask, nhưng cho NHIỀU task)
    let attachedTags = [];
    if (tagIds.length > 0 && taskRows.length > 0) {
      const valid = await client.query(
        `SELECT id, name, color_hex
         FROM tags
         WHERE id = ANY($1) AND user_id = $2 AND is_deleted = FALSE`,
        [tagIds, userId],
      );
      if (valid.rows.length > 0) {
        const taskIds = taskRows.map((r) => r.id);
        const tagIdList = valid.rows.map((r) => r.id);
        // Cross product: mỗi task × mỗi valid tag
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

    // Sort task rows theo start_time để summary đẹp
    taskRows.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
    const first = taskRows[0];
    const last  = taskRows[taskRows.length - 1];

    return {
      success: true,
      summary: {
        title,
        task_type:  taskType,
        created:    taskRows.length,
        skipped:    skipped.length,
        first_start_time: first?.start_time ?? null,
        last_start_time:  last?.start_time  ?? null,
        weeks:      weeks,            // tuần đã xử lý (sau dedupe + sort)
        day_of_week: dayOfWeek,
        tags:       attachedTags,
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
