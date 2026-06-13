import { getClient } from '../config/db.js';
import { extractAttachmentTextByFileNameInIds } from './attachmentTextService.js';
// MỚI 2026-06: 5 tool tra cứu (email/news/web) cho AI suy luận khi user
// hỏi chung chung. Declarations + executors tách file riêng để aiTools.js
// không phình thêm.
import {
  SEARCH_TOOL_DECLARATIONS,
  isSearchToolName,
  dispatchSearchTool,
} from './aiSearchTools.js';
import { buildReferenceSystemNote } from './aiReferences.js';

// ─────────────────────────────────────────────────────────────
// Function declarations
// ─────────────────────────────────────────────────────────────
const createTaskDeclaration = {
  name: 'create_task',
  description:
    'Tạo một task mới (việc cần làm / lịch học / lịch thi) cho người dùng đang chat. ' +
    'Chỉ gọi khi user thực sự yêu cầu lưu/tạo/thêm task hoặc nhắc nhở. ' +
    'KHÔNG gọi khi user chỉ hỏi thông tin hoặc tóm tắt. ' +
    'Nếu user nói thời gian dạng tương đối (Ví dụ: "ngày mai 9h", "thứ 6 tuần sau"), ' +
    'hãy convert thành ISO 8601 với timezone +07:00 dựa trên thời điểm hiện tại. ' +
    'Nếu thiếu thông tin về thời gian thì hỏi lại người dùng' +
    'Nếu đã hỏi mà người dùng vẫn muốn tạo thì cứ bỏ qua start_time/end_time, không tự bịa. ' +
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
    'Không được đoán bừa, nếu người dùng không nói rõ, không chắc chắn thì phải hỏi lại các thông tin cần thiết. ' +
    'Có thể dùng ngày hôm nay (đã có ở system note) để hỗ trợ tính toán. ' +
    'Đây là các ví dụ hướng dẫn, không phải thực tế' +
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
          'Task đầu tiên là ngày `day_of_week` đầu tiên >= loop_start_date.',
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
          'TODO = việc cần làm lặp lại. CLASS = lịch học/buổi học định kỳ (TKB). ' +
          'EXAM = lịch thi. Mặc định TODO nếu không rõ.',
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

// ─────────────────────────────────────────────────────────────
// read_attachment — UNIFIED 2026-05-31: dùng file_name + allowedAttachmentIds
//                — UPDATED 2026-06: ảnh giờ đi inlineData trực tiếp, KHÔNG
//                  qua tool này nữa.
// ─────────────────────────────────────────────────────────────
const readAttachmentDeclaration = {
  name: 'read_attachment',
  description:
    'Đọc nội dung VĂN BẢN của 1 file đính kèm (PDF / Word / Excel / CSV / TXT / HTML) ' +
    'có trong cuộc hội thoại hiện tại — bao gồm file từ email/news context HOẶC ' +
    'file user đã upload trực tiếp vào AI Chat. ' +
    'Server đã extract text trước, KHÔNG upload binary nên rẻ token. ' +
    'CHỈ gọi khi user thực sự cần thông tin từ FILE TEXT (vd "tóm tắt file PDF", ' +
    '"file Excel có sheet gì", "trong file plan nói gì"). ' +
    'KHÔNG gọi nếu user chỉ hỏi về nội dung email/news — phần đó đã có sẵn trong context. ' +
    'TUYỆT ĐỐI KHÔNG gọi với file ẢNH — ảnh đã được nhúng inline ngay trong message, ' +
    'bạn nhìn thấy được trực tiếp, không cần tool. Gọi tool với ảnh sẽ luôn fail. ' +
    'KHÔNG gọi với file video/audio (chưa hỗ trợ). ' +
    'Có thể gọi nhiều lần cho nhiều file khác nhau trong cùng turn. ' +
    'Nếu kết quả có `truncated: true` thì cảnh báo user là file đã bị cắt bớt.',
  parameters: {
    type: 'object',
    properties: {
      file_name: {
        type:        'string',
        description:
          'TÊN file đính kèm — copy CHÍNH XÁC từ mục "FILE ĐÍNH KÈM" trong system instruction, ' +
          'bao gồm cả phần mở rộng (.pdf, .xlsx, ...). ' +
          'Vd: "lich_thi.pdf", "report_slides (2).html". ' +
          'TUYỆT ĐỐI không bịa tên hay UUID — chỉ dùng tên đã liệt kê. ' +
          'KHÔNG truyền tên file ảnh từ mục "ẢNH ĐÍNH KÈM" (sai mục tiêu của tool). ' +
          'Nếu instruction không có file text nào → KHÔNG gọi tool này, ' +
          'trả lời user là không có file text đính kèm.',
      },
    },
    required: ['file_name'],
  },
};

// ─────────────────────────────────────────────────────────────
// MỚI 2026-06: 2 tool ghi KẾT QUẢ HỌC TẬP (điểm từng học phần).
// AI CHỈ được set 6 trường: semester, course_code, course_name,
// course_name_en, credits, letter_grade. Các trường khác (id, user_id,
// mod_time, is_deleted) do server tự quản. Ghi theo upsert: trùng
// (học kỳ + mã HP) thì CẬP NHẬT thay vì tạo bản trùng.
// ─────────────────────────────────────────────────────────────
const gradeItemProperties = {
  semester: {
    type:        'string',
    description:
      'Mã học kỳ HUST dạng "<năm><kỳ>", ví dụ "20251" = năm học 2025-2026 kỳ 1, ' +
      '"20242" = năm 2024-2025 kỳ 2, "20253" = kỳ hè. Bắt buộc.',
  },
  course_code: {
    type:        'string',
    description: 'Mã học phần, ví dụ "IT4785", "PE2501". Bắt buộc. Sẽ được viết HOA.',
  },
  course_name: {
    type:        'string',
    description: 'Tên học phần tiếng Việt, ví dụ "Phát triển ứng dụng cho thiết bị di động". Bắt buộc.',
  },
  course_name_en: {
    type:        'string',
    description: 'Tên học phần tiếng Anh, ví dụ "Mobile Programming". Không bắt buộc — bỏ qua nếu không có.',
  },
  credits: {
    type:        'integer',
    description:
      'Số tín chỉ (TC), số nguyên 0..30. Ví dụ 2, 3. Học phần điều kiện/GDTC có thể 0 TC. ' +
      'Bỏ qua thì mặc định 0. Chỉ học phần có TC > 0 mới được tính vào GPA/CPA.',
  },
  letter_grade: {
    type:        'string',
    enum:        ['A+', 'A', 'B+', 'B', 'C+', 'C', 'D+', 'D', 'F'],
    description:
      'Điểm chữ theo thang HUST. Bỏ qua (hoặc để trống) nếu học phần CHƯA có điểm. ' +
      'Giá trị ngoài danh sách sẽ bị coi như chưa có điểm.',
  },
};

const createGradeDeclaration = {
  name: 'create_grade',
  description:
    'Ghi KẾT QUẢ HỌC TẬP của MỘT học phần cho người dùng đang chat. ' +
    'Chỉ gọi khi user thực sự yêu cầu lưu/nhập/thêm điểm của 1 môn. ' +
    'Nếu user đưa BẢNG ĐIỂM nhiều môn (paste danh sách, ảnh bảng điểm...) → KHÔNG gọi tool này ' +
    'nhiều lần, hãy dùng `create_grades` (1 lần, mảng nhiều môn). ' +
    'Server ghi theo upsert: nếu đã có điểm cùng (học kỳ + mã HP) thì CẬP NHẬT, ' +
    'không tạo bản trùng. KHÔNG tự bịa mã HP, tên môn, số TC hay điểm — thiếu thì hỏi lại user.',
  parameters: {
    type:       'object',
    properties: gradeItemProperties,
    required:   ['semester', 'course_code', 'course_name'],
  },
};

const createGradesDeclaration = {
  name: 'create_grades',
  description:
    'Ghi KẾT QUẢ HỌC TẬP của NHIỀU học phần trong MỘT lần gọi (ghi cả bảng điểm). ' +
    'Dùng khi user paste danh sách điểm, gửi ảnh/bảng điểm, hoặc liệt kê nhiều môn cùng lúc. ' +
    'Mỗi phần tử trong `grades` là 1 học phần với đúng 6 trường cho phép. ' +
    'Các môn có thể thuộc nhiều học kỳ khác nhau (mỗi phần tử tự khai `semester` riêng). ' +
    'Server ghi theo upsert từng môn theo (học kỳ + mã HP). ' +
    'KHÔNG tự bịa dữ liệu; chỉ ghi những gì user cung cấp.',
  parameters: {
    type:       'object',
    properties: {
      grades: {
        type:        'array',
        description: 'Danh sách học phần cần ghi điểm (≥ 1 phần tử).',
        items: {
          type:       'object',
          properties: gradeItemProperties,
          required:   ['semester', 'course_code', 'course_name'],
        },
      },
    },
    required: ['grades'],
  },
};

// MỚI 2026-06: gộp tool tra cứu (5 tool) cùng với tool task/file.
// Tên biến giữ `TASK_TOOL_DECLARATIONS` để không phải đổi import ở routes/ai.js
// — vẫn tương thích ngược.
export const TASK_TOOL_DECLARATIONS = [
  createTaskDeclaration,
  createWeeklyTasksDeclaration,
  createGradeDeclaration,
  createGradesDeclaration,
  readAttachmentDeclaration,
  ...SEARCH_TOOL_DECLARATIONS,
];

// ─────────────────────────────────────────────────────────────
// System note — gắn kèm system instruction để model biết tool & tag
// ─────────────────────────────────────────────────────────────
export const buildToolSystemNote = ({ tags = [] } = {}) => {
  const lines = [
    'Bạn có các tool sau:',
    '  - `create_task`: tạo 1 task đơn lẻ.',
    '  - `create_weekly_tasks`: tạo nhiều task LẶP HẰNG TUẦN.',
    '  - `create_grade`: ghi điểm 1 học phần (kết quả học tập).',
    '  - `create_grades`: ghi điểm NHIỀU học phần trong 1 lần (cả bảng điểm).',
    '  - `read_attachment`: đọc TEXT file đính kèm theo TÊN FILE (chỉ gọi khi user hỏi về file text).',
    // MỚI 2026-06 — 5 tool tra cứu để model suy luận khi user hỏi chung chung:
    '  - `search_emails` + `get_email`: tra email CỦA CHÍNH user. Search trả list',
    '    tóm tắt, get_email lấy body đầy đủ 1 email cụ thể.',
    '  - `search_news` + `get_news`: tra tin tức / kế hoạch từ HUST CTT (public).',
    '  - `web_search`: tra web (search engine ngoài) cho thông tin THỜI SỰ / NGOÀI hệ thống.',
    `Hôm nay là ${new Date().toISOString()} (UTC). Múi giờ user: +07:00 (giờ VN).`,
    '',
    'Khi user yêu cầu "tạo task", "thêm việc", "nhắc tôi"... cho 1 sự kiện đơn → `create_task`.',
    'Khi user yêu cầu task LẶP HẰNG TUẦN → `create_weekly_tasks`.',
    'KHÔNG dùng `create_task` rồi loop tay nhiều lần — tốn token và sai design.',
    '',
    'QUAN TRỌNG về ẢNH:',
    '  - Ảnh user gửi được nhúng TRỰC TIẾP vào message — bạn nhìn thấy ảnh ngay trong context.',
    '  - Có thể mô tả, OCR, phân tích nội dung ảnh mà KHÔNG cần gọi bất kỳ tool nào.',
    '  - TUYỆT ĐỐI KHÔNG gọi `read_attachment` cho file ảnh — tool đó chỉ đọc text, sẽ fail.',
    '',
    'QUAN TRỌNG về `read_attachment`:',
    '  - Tham số là TÊN FILE (file_name) — copy NGUYÊN VĂN từ phần "FILE ĐÍNH KÈM".',
    '  - KHÔNG truyền UUID hay id giả định nào.',
    '  - KHÔNG truyền tên file từ mục "ẢNH ĐÍNH KÈM" (sai mục tiêu).',
    '  - Nếu phần "FILE ĐÍNH KÈM" không xuất hiện hoặc rỗng → không có file text → KHÔNG gọi tool.',
    '',
    'QUAN TRỌNG về `create_weekly_tasks`:',
    '  - Server chỉ nhận NGÀY CỤ THỂ: `loop_start_date` và `loop_end_date` (YYYY-MM-DD).',
    '  - AI tự convert mô tả thời gian thành ngày trước khi gọi tool.',
    '  - Convention `day_of_week`: ISO 8601 (1=Thứ 2 ... 7=Chủ Nhật).',
    '  - Trường hợp TKB HUST: nếu user CHƯA cho biết Tuần 1 → HỎI trước, KHÔNG đoán.',
    '',
    'QUAN TRỌNG về `create_grade` / `create_grades` (kết quả học tập):',
    '  - 1 môn → `create_grade`. NHIỀU môn (bảng điểm, paste danh sách, ảnh bảng điểm)',
    '    → `create_grades` GỌI 1 LẦN với mảng `grades`. KHÔNG loop `create_grade` nhiều lần.',
    '  - Mỗi môn chỉ gồm 6 trường: semester, course_code, course_name, course_name_en,',
    '    credits, letter_grade. KHÔNG truyền id/user_id — server tự gán.',
    '  - `semester` là mã kỳ HUST "<năm><kỳ>" (vd "20251"). `letter_grade` thuộc',
    '    {A+,A,B+,B,C+,C,D+,D,F}; môn chưa có điểm thì bỏ trống.',
    '  - Server tự upsert theo (học kỳ + mã HP): trùng thì cập nhật, không tạo bản trùng.',
    '  - TUYỆT ĐỐI không bịa mã HP / số TC / điểm. Thiếu thông tin thì hỏi lại user.',
    '',
    // MỚI 2026-06 — hướng dẫn dùng các tool tra cứu:
    'QUAN TRỌNG về `search_emails` / `search_news` / `web_search`:',
    '  - Mục tiêu: cho user hỏi CHUNG CHUNG ("có email gì từ thầy không", "tin học',
    '    bổng mới"), bạn dùng tool để TRA dữ liệu thực rồi mới trả lời — KHÔNG bịa.',
    '  - Pattern 2 bước: `search_*` trả list tóm tắt → đọc qua → nếu cần chi tiết 1',
    '    item cụ thể thì gọi `get_email` / `get_news` với id từ kết quả search.',
    '  - `search_emails` CHỈ trả email của CHÍNH user — không lo leak email người khác.',
    '  - `search_news` trả tin PUBLIC từ HUST CTT — mọi user đều xem được.',
    '  - `web_search` cho câu hỏi NGOÀI hệ thống (định nghĩa, tin thời sự thế giới,',
    '    kiến thức cập nhật). KHÔNG dùng cho câu hỏi nội bộ HUST.',
    '  - Câu hỏi mơ hồ ("dạo này có gì mới không") → search với query rỗng để lấy',
    '    item mới nhất.',
    '  - KHÔNG bịa email_id / news_id — chỉ dùng id từ kết quả search liền trước đó.',
    '  - Nếu đang ở context email-chat / news-chat và user chỉ hỏi về CHÍNH email/news',
    '    đó (đã có trong system instruction) → KHÔNG cần search.',
    '',
    'Sau khi tool chạy xong, trả lời user bằng tiếng Việt, ngắn gọn.',
    'Nếu nội dung trả về từ tool DÀI (email body, file text, kết quả search nhiều item...) →',
    '  TÓM TẮT ý chính trước, KHÔNG dump nguyên văn toàn bộ nội dung vào câu trả lời.',
    '  Chỉ trích dẫn đoạn cụ thể khi user hỏi rõ hoặc cần dẫn chứng.',
    'TUYỆT ĐỐI không nói "đã tạo/đã đọc/đã tìm" nếu chưa thực sự gọi tool.',
    '',
    buildReferenceSystemNote(),
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
// User profile system note (giữ nguyên)
// ─────────────────────────────────────────────────────────────
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
    'Tận dụng khoá học và ngành để gợi ý task chính xác hơn.',
  ].join('\n');
};

// ─────────────────────────────────────────────────────────────
// Executor factory — UNIFIED 2026-05-31, mở rộng 2026-06 (search tools).
// ─────────────────────────────────────────────────────────────
/**
 * @param {Object}   ctx
 * @param {string}   ctx.userId
 * @param {string=}  ctx.sourceType            — 'MANUAL' | 'EMAIL' | 'NEWS' | 'CTT'
 * @param {string=}  ctx.sourceId              — UUID source (cho task tracking)
 * @param {string[]=}ctx.allowedAttachmentIds  — UUID attachments user được phép đọc
 *                                                trong cuộc hội thoại này
 * @returns {Function}
 */
export const makeTaskToolExecutor = ({
  userId,
  sourceType            = 'MANUAL',
  sourceId              = null,
  allowedAttachmentIds  = [],
}) => {
  if (!userId) throw new Error('makeTaskToolExecutor: userId là bắt buộc');

  return async (toolName, args) => {
    // MỚI 2026-06: ưu tiên check 5 search tool trước (email/news/web).
    // dispatcher trả handled=false thì rơi xuống switch task/file cũ.
    if (isSearchToolName(toolName)) {
      const r = await dispatchSearchTool(toolName, args, { userId });
      if (r.handled) return r.result;
    }

    if (toolName === 'create_task') {
      return await execCreateTask({ args, userId, sourceType, sourceId });
    }
    if (toolName === 'create_weekly_tasks') {
      return await execCreateWeeklyTasks({ args, userId, sourceType, sourceId });
    }
    if (toolName === 'create_grade') {
      return await execCreateGrade({ args, userId });
    }
    if (toolName === 'create_grades') {
      return await execCreateGrades({ args, userId });
    }
    if (toolName === 'read_attachment') {
      const fileName = (args?.file_name ?? '').toString().trim();
      if (!fileName) return { success: false, error: 'Thiếu file_name.' };
      if (!Array.isArray(allowedAttachmentIds) || allowedAttachmentIds.length === 0) {
        return {
          success: false,
          error:   'Không có file đính kèm nào trong cuộc hội thoại để đọc.',
        };
      }
      return await extractAttachmentTextByFileNameInIds({
        fileName,
        allowedIds: allowedAttachmentIds,
        userId,
      });
    }
    return { success: false, error: `Tool "${toolName}" không được hỗ trợ.` };
  };
};

// ─────────────────────────────────────────────────────────────
// Helpers — không đổi
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

const parseDateIso = (iso) => {
  if (typeof iso !== 'string') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(dt.getTime())) return null;
  if (formatDateIso(dt) !== iso) return null;
  return dt.getTime();
};

const formatDateIso = (dt) => {
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const isoWeekday = (dt) => {
  const j = dt.getUTCDay();
  return j === 0 ? 7 : j;
};

// ─────────────────────────────────────────────────────────────
// execCreateTask + execCreateWeeklyTasks — không đổi
// ─────────────────────────────────────────────────────────────
const execCreateTask = async ({ args, userId, sourceType, sourceId }) => {
  const title = (args?.title ?? '').toString().trim();
  if (!title) return { success: false, error: 'Thiếu title — không thể tạo task.' };

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

const execCreateWeeklyTasks = async ({ args, userId, sourceType, sourceId }) => {
  const title = (args?.title ?? '').toString().trim();
  if (!title) return { success: false, error: 'Thiếu title.' };

  const dayOfWeek = Number(args?.day_of_week);
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 1 || dayOfWeek > 7) {
    return {
      success: false,
      error: `day_of_week không hợp lệ (cần 1..7 ISO, nhận: ${args?.day_of_week}).`,
    };
  }

  const loopStart = String(args?.loop_start_date ?? '').trim();
  const loopEnd   = String(args?.loop_end_date ?? '').trim();
  const startMs   = parseDateIso(loopStart);
  const endMs     = parseDateIso(loopEnd);
  if (startMs === null) {
    return { success: false, error: `loop_start_date phải dạng YYYY-MM-DD (nhận: "${loopStart}").` };
  }
  if (endMs === null) {
    return { success: false, error: `loop_end_date phải dạng YYYY-MM-DD (nhận: "${loopEnd}").` };
  }
  if (startMs > endMs) {
    return { success: false, error: `loop_start_date phải <= loop_end_date.` };
  }

  const rawStart = args?.start_time_of_day;
  const rawEnd   = args?.end_time_of_day;
  const startHm  = rawStart ? normalizeTimeOfDay(rawStart) : null;
  const endHm    = rawEnd   ? normalizeTimeOfDay(rawEnd)   : null;
  if (rawStart && !startHm) return { success: false, error: `start_time_of_day không hợp lệ.` };
  if (rawEnd && !endHm)     return { success: false, error: `end_time_of_day không hợp lệ.` };
  if (Boolean(startHm) !== Boolean(endHm)) {
    return { success: false, error: 'Phải cung cấp CẢ start_time_of_day và end_time_of_day, hoặc bỏ qua cả hai.' };
  }
  const hasTime = Boolean(startHm && endHm);

  const taskType = (args?.task_type ?? 'TODO').toString().toUpperCase();
  if (!['TODO', 'CLASS', 'EXAM'].includes(taskType)) {
    return { success: false, error: `task_type không hợp lệ: "${taskType}".` };
  }

  const description = args?.description ? String(args.description).trim() : null;
  const tagIds      = sanitizeTagIds(args?.tag_ids);

  const startDt    = new Date(startMs);
  const startDow   = isoWeekday(startDt);
  const advance    = (dayOfWeek - startDow + 7) % 7;

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

  const sessions = dates.map((d) => ({
    start_time: hasTime ? `${d}T${startHm}+07:00` : null,
    end_time:   hasTime ? `${d}T${endHm}+07:00`   : `${d}T23:59:00+07:00`,
  }));

  const client = await getClient();
  try {
    await client.query('BEGIN');

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
        skipped:          0,
        day_of_week:      dayOfWeek,
        loop_start_date:  loopStart,
        loop_end_date:    loopEnd,
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

// Thang điểm chữ hợp lệ (HUST). NULL = chưa có điểm.
const GRADE_VALID_LETTERS = ['A+', 'A', 'B+', 'B', 'C+', 'C', 'D+', 'D', 'F'];

const normalizeGradeLetter = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const up = String(v).trim().toUpperCase();
  return GRADE_VALID_LETTERS.includes(up) ? up : null;
};

const normalizeGradeCredits = (v) => {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n < 0 || n > 30) {
    const err = new Error('credits phải là số nguyên 0..30.');
    err.statusCode = 400;
    throw err;
  }
  return n;
};

// Chuẩn hoá + validate 1 học phần từ args của model. Trả { ok, value, error }.
const normalizeGradeItem = (raw) => {
  const semester   = (raw?.semester ?? '').toString().trim();
  const courseCode = (raw?.course_code ?? '').toString().trim().toUpperCase();
  const courseName = (raw?.course_name ?? '').toString().trim();
  if (!semester)   return { ok: false, error: 'Thiếu semester.' };
  if (!courseCode) return { ok: false, error: 'Thiếu course_code.' };
  if (!courseName) return { ok: false, error: 'Thiếu course_name.' };

  const courseNameEn = raw?.course_name_en ? String(raw.course_name_en).trim() : null;
  let credits;
  try {
    credits = normalizeGradeCredits(raw?.credits);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const letter = normalizeGradeLetter(raw?.letter_grade);

  return {
    ok:    true,
    value: { semester, courseCode, courseName, courseNameEn, credits, letter },
  };
};

// Upsert 1 record theo (user_id, semester, course_code) trên bản CHƯA xoá.
// `client` là pg client đang trong transaction (create_grades) hoặc lấy từ pool (create_grade).
const upsertGradeRow = async (client, userId, g) => {
  const found = await client.query(
    `SELECT id FROM grades
      WHERE user_id = $1 AND semester = $2 AND course_code = $3 AND is_deleted = FALSE
      LIMIT 1`,
    [userId, g.semester, g.courseCode],
  );

  if (found.rows[0]) {
    const r = await client.query(
      `UPDATE grades SET
         course_name = $1, course_name_en = $2, credits = $3, letter_grade = $4,
         is_deleted = FALSE, mod_time = CURRENT_TIMESTAMP
       WHERE id = $5
       RETURNING id, semester, course_code, course_name, course_name_en, credits, letter_grade`,
      [g.courseName, g.courseNameEn, g.credits, g.letter, found.rows[0].id],
    );
    return { action: 'updated', row: r.rows[0] };
  }

  const r = await client.query(
    `INSERT INTO grades
       (user_id, semester, course_code, course_name, course_name_en, credits, letter_grade)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, semester, course_code, course_name, course_name_en, credits, letter_grade`,
    [userId, g.semester, g.courseCode, g.courseName, g.courseNameEn, g.credits, g.letter],
  );
  return { action: 'created', row: r.rows[0] };
};

const execCreateGrade = async ({ args, userId }) => {
  const norm = normalizeGradeItem(args);
  if (!norm.ok) return { success: false, error: norm.error };

  const client = await getClient();
  try {
    const { action, row } = await upsertGradeRow(client, userId, norm.value);
    return { success: true, action, grade: row }; // action: 'created' | 'updated'
  } catch (err) {
    return { success: false, error: err.message ?? String(err) };
  } finally {
    client.release();
  }
};

const execCreateGrades = async ({ args, userId }) => {
  const list = Array.isArray(args?.grades) ? args.grades : null;
  if (!list || list.length === 0) {
    return { success: false, error: 'Thiếu mảng `grades` (cần ít nhất 1 học phần).' };
  }

  // Validate trước để báo rõ phần tử nào sai, không chặn cả batch vì 1 môn lỗi.
  const normalized = [];
  const invalid = [];
  list.forEach((raw, i) => {
    const n = normalizeGradeItem(raw);
    if (n.ok) normalized.push(n.value);
    else invalid.push({ index: i, course_code: raw?.course_code ?? null, error: n.error });
  });

  if (normalized.length === 0) {
    return { success: false, error: 'Không có học phần hợp lệ nào.', invalid };
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const saved = [];
    let created = 0;
    let updated = 0;
    for (const g of normalized) {
      const { action, row } = await upsertGradeRow(client, userId, g);
      if (action === 'created') created += 1; else updated += 1;
      saved.push({ action, ...row });
    }
    await client.query('COMMIT');
    return {
      success:       true,
      created_count: created,
      updated_count: updated,
      skipped:       invalid, // các phần tử không hợp lệ bị bỏ qua (nếu có)
      grades:        saved,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    return { success: false, error: err.message ?? String(err) };
  } finally {
    client.release();
  }
};
