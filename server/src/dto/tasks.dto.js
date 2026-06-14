import { z } from 'zod';

const taskType   = z.enum(['TODO', 'EVENT', 'REMINDER']).optional();
const sourceType = z.enum(['MANUAL', 'EMAIL', 'NEWS']).optional();
const priority   = z.number().int().min(1).max(5).optional().nullable();
const tagIds     = z.array(z.string().uuid()).optional();

export const CreateTaskSchema = z.object({
  title:        z.string().min(1, 'title là bắt buộc.').trim(),
  description:  z.string().trim().optional().nullable(),
  start_time:   z.string().datetime({ offset: true }).optional().nullable(),
  end_time:     z.string().datetime({ offset: true }).optional().nullable(),
  task_type:    taskType,
  source_type:  sourceType,
  source_id:    z.string().optional().nullable(),
  priority,
  latitude:     z.number().min(-90).max(90).optional().nullable(),
  longitude:    z.number().min(-180).max(180).optional().nullable(),
  address_name: z.string().trim().optional().nullable(),
  tag_ids:      tagIds,
});

export const ReplaceTaskSchema = CreateTaskSchema;

export const PatchTaskSchema = CreateTaskSchema.partial().refine(
  (d) => Object.keys(d).length > 0,
  { message: 'Không có field nào được cập nhật.' },
);
