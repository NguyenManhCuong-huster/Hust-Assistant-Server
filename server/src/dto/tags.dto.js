import { z } from 'zod';

const colorHex = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/, 'color_hex phải có định dạng #RRGGBB.')
  .nullable()
  .optional();

export const CreateTagSchema = z.object({
  name:      z.string().min(1, 'name là bắt buộc.').trim(),
  color_hex: colorHex,
});

export const UpdateTagSchema = z.object({
  name:      z.string().min(1).trim().optional(),
  color_hex: colorHex,
}).refine((d) => d.name !== undefined || d.color_hex !== undefined, {
  message: 'Cần ít nhất name hoặc color_hex.',
});
