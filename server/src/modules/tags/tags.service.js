import { AppError }        from '../../shared/utils/AppError.js';
import { isValidColorHex } from '../../shared/utils/validators.js';
import * as repo from '../../dao/tags.dao.js';

export const listTags  = (userId, includeDeleted) => repo.listTags(userId, includeDeleted);
export const findTag   = (id, userId)              => repo.findTag(id, userId);
export const softDeleteTag = (id)                  => repo.softDeleteTag(id);

export const createTag = async (userId, name, colorHex = null) => {
  if (!name?.trim()) throw new AppError('name là bắt buộc.', 400);
  if (colorHex && !isValidColorHex(colorHex)) {
    throw new AppError('color_hex phải có định dạng #RRGGBB.', 400);
  }
  try {
    return await repo.insertTag(userId, name, colorHex);
  } catch (err) {
    if (err.code === '23505') throw new AppError(`Tag "${name.trim()}" đã tồn tại.`, 409);
    throw err;
  }
};

export const updateTag = async (id, fields) => {
  const { name, color_hex } = fields;
  if (!name && color_hex === undefined) {
    throw new AppError('Cần ít nhất name hoặc color_hex.', 400);
  }
  if (color_hex && !isValidColorHex(color_hex)) {
    throw new AppError('color_hex phải có định dạng #RRGGBB.', 400);
  }
  try {
    return await repo.updateTag(id, fields);
  } catch (err) {
    if (err.code === '23505') throw new AppError(`Tag "${name}" đã tồn tại.`, 409);
    throw err;
  }
};
