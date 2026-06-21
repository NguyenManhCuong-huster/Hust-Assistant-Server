import { z } from 'zod';

const requiredStr = (field) =>
  z.string({ required_error: `${field} là bắt buộc.` })
   .min(1, `${field} là bắt buộc.`)
   .trim();

export const GradeSchema = z.object({
  // id do CLIENT cấp khi POST (UUID ổn định, làm idempotency key). Thiếu → server tự sinh
  // (đường TOOL/AI). Chỉ dùng ở createGrade; replaceGrade lấy id từ URL param.
  id:             z.string().uuid().optional().nullable(),
  // mod_time do CLIENT gửi (thời điểm sửa thật trên máy) để server quyết LWW.
  // Thiếu (đường TOOL/AI) → server dùng giờ hiện tại.
  mod_time:       z.string().datetime({ offset: true }).optional().nullable(),
  semester:       requiredStr('semester'),
  course_code:    requiredStr('course_code'),
  course_name:    requiredStr('course_name'),
  course_name_en: z.string().trim().optional().nullable(),
  credits:        z.number().positive().optional().nullable(),
  letter_grade:   z.string().trim().optional().nullable(),
});
