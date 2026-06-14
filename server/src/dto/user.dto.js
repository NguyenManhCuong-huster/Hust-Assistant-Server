import { z } from 'zod';

const UserInfoBase = z.object({
  student_id:    z.string().regex(/^\d{7,10}$/, 'student_id must be 7–10 digits.').optional().nullable(),
  full_name:     z.string().max(255, 'full_name is too long (>255 characters).').trim().optional().nullable(),
  date_of_birth: z.string()
    .refine((v) => !Number.isNaN(new Date(v).getTime()), 'date_of_birth is invalid. Use YYYY-MM-DD.')
    .optional()
    .nullable(),
  phone:         z.string().regex(/^\+?\d{9,15}$/, 'phone is invalid (9–15 digits, optionally prefixed with +).').optional().nullable(),
  school:        z.string().max(255, 'school is too long (>255 characters).').trim().optional().nullable(),
  major:         z.string().max(255, 'major is too long (>255 characters).').trim().optional().nullable(),
  class_name:    z.string().max(50, 'class_name is too long (>50 characters).').trim().optional().nullable(),
  course:        z.string().regex(/^K\d{2,3}$/i, 'course must be in the format "K" + 2–3 digits (e.g. K66).').optional().nullable(),
});

export const CreateUserInfoSchema = UserInfoBase.required({ student_id: true }).refine(
  (d) => d.student_id != null,
  { message: 'student_id is required when creating a profile.', path: ['student_id'] },
);

export const UpsertUserInfoSchema  = CreateUserInfoSchema;
export const PatchUserInfoSchema   = UserInfoBase.partial().refine(
  (d) => Object.keys(d).length > 0,
  { message: 'No fields provided for update.' },
);
