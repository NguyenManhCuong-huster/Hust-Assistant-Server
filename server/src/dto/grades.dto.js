import { z } from 'zod';

const requiredStr = (field) =>
  z.string({ required_error: `${field} là bắt buộc.` })
   .min(1, `${field} là bắt buộc.`)
   .trim();

export const GradeSchema = z.object({
  semester:       requiredStr('semester'),
  course_code:    requiredStr('course_code'),
  course_name:    requiredStr('course_name'),
  course_name_en: z.string().trim().optional().nullable(),
  credits:        z.number().positive().optional().nullable(),
  letter_grade:   z.string().trim().optional().nullable(),
});
