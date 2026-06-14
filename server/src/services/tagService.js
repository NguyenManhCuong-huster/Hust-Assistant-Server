import { query } from '../config/db.js';
import { AppError }        from '../utils/AppError.js';
import { isValidColorHex } from '../utils/validators.js';

export const listTags = async (userId, includeDeleted = false) => {
  const extra = includeDeleted ? '' : 'AND is_deleted=FALSE';
  const r = await query(
    `SELECT id, name, color_hex, is_deleted, mod_time
     FROM tags
     WHERE user_id=$1 ${extra}
     ORDER BY name ASC`,
    [userId],
  );
  return r.rows;
};

export const findTag = async (id, userId) => {
  const r = await query(
    'SELECT * FROM tags WHERE id=$1 AND user_id=$2',
    [id, userId],
  );
  return r.rows[0] ?? null;
};

export const createTag = async (userId, name, colorHex = null) => {
  if (!name?.trim()) throw new AppError('name là bắt buộc.', 400);
  if (colorHex && !isValidColorHex(colorHex)) {
    throw new AppError('color_hex phải có định dạng #RRGGBB.', 400);
  }
  try {
    const r = await query(
      `INSERT INTO tags (user_id, name, color_hex)
       VALUES ($1, $2, $3)
       RETURNING id, name, color_hex, is_deleted, mod_time`,
      [userId, name.trim(), colorHex],
    );
    return r.rows[0];
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

  const setClauses = [];
  const params     = [];
  let   idx        = 1;
  if (name)                    { setClauses.push(`name=$${idx++}`);      params.push(name.trim()); }
  if (color_hex !== undefined) { setClauses.push(`color_hex=$${idx++}`); params.push(color_hex); }
  setClauses.push('mod_time=CURRENT_TIMESTAMP');
  params.push(id);

  try {
    const r = await query(
      `UPDATE tags SET ${setClauses.join(',')}
       WHERE id=$${idx}
       RETURNING id, name, color_hex, is_deleted, mod_time`,
      params,
    );
    return r.rows[0];
  } catch (err) {
    if (err.code === '23505') throw new AppError(`Tag "${name}" đã tồn tại.`, 409);
    throw err;
  }
};

export const softDeleteTag = async (id) => {
  const r = await query(
    `UPDATE tags SET is_deleted=TRUE, mod_time=CURRENT_TIMESTAMP
     WHERE id=$1 RETURNING id, is_deleted, mod_time`,
    [id],
  );
  return r.rows[0];
};
