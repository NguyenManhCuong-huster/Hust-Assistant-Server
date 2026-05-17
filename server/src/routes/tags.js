import express from 'express';

import { requireAuth } from '../middleware/authMiddleware.js';
import { lwwCheck }    from '../middleware/lastWriteWins.js';
import { query }       from '../config/db.js';

const router = express.Router();
router.use(requireAuth);

// GET /api/tags  (?include_deleted=true để lấy cả đã xóa)
router.get('/', async (req, res, next) => {
  try {
    const extra = req.query.include_deleted === 'true' ? '' : 'AND is_deleted=FALSE';
    const r = await query(
      `SELECT id, name, color_hex, is_deleted, mod_time
       FROM tags
       WHERE user_id=$1 ${extra}
       ORDER BY name ASC`,
      [req.user.id],
    );
    res.json({ success: true, data: r.rows });
  } catch (err) { next(err); }
});

// POST /api/tags  — Body: { name, color_hex? }
router.post('/', async (req, res, next) => {
  const { name, color_hex = null } = req.body;
  if (!name?.trim()) return res.status(400).json({ success: false, message: 'name là bắt buộc.' });
  if (color_hex && !/^#[0-9A-Fa-f]{6}$/.test(color_hex)) {
    return res.status(400).json({ success: false, message: 'color_hex phải có định dạng #RRGGBB.' });
  }

  try {
    const r = await query(
      `INSERT INTO tags (user_id, name, color_hex)
       VALUES ($1, $2, $3)
       RETURNING id, name, color_hex, is_deleted, mod_time`,
      [req.user.id, name.trim(), color_hex],
    );
    res.status(201).json({ success: true, data: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: `Tag "${name.trim()}" đã tồn tại.` });
    }
    next(err);
  }
});

// PUT /api/tags/:id  [LWW]  — Body: { name?, color_hex? }
router.put('/:id', lwwCheck('tags'), async (req, res, next) => {
  const { name, color_hex } = req.body;
  if (!name && color_hex === undefined) {
    return res.status(400).json({ success: false, message: 'Cần ít nhất name hoặc color_hex.' });
  }
  if (color_hex && !/^#[0-9A-Fa-f]{6}$/.test(color_hex)) {
    return res.status(400).json({ success: false, message: 'color_hex phải có định dạng #RRGGBB.' });
  }

  const existing = req.serverRecord
    ?? (await query('SELECT id FROM tags WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id])).rows[0];
  if (!existing) return res.status(404).json({ success: false, message: 'Tag không tồn tại.' });

  try {
    const setClauses = [];
    const params     = [];
    let   idx        = 1;
    if (name)                  { setClauses.push(`name=$${idx++}`);      params.push(name.trim()); }
    if (color_hex !== undefined) { setClauses.push(`color_hex=$${idx++}`); params.push(color_hex); }
    setClauses.push('mod_time=CURRENT_TIMESTAMP');
    params.push(existing.id);

    const r = await query(
      `UPDATE tags SET ${setClauses.join(',')}
       WHERE id=$${idx}
       RETURNING id, name, color_hex, is_deleted, mod_time`,
      params,
    );
    res.json({ success: true, data: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: `Tag "${name}" đã tồn tại.` });
    }
    next(err);
  }
});

// DELETE /api/tags/:id  [LWW]  — soft delete
router.delete('/:id', lwwCheck('tags'), async (req, res, next) => {
  try {
    const existing = req.serverRecord
      ?? (await query('SELECT id FROM tags WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id])).rows[0];
    if (!existing) return res.status(404).json({ success: false, message: 'Tag không tồn tại.' });
    const r = await query(
      `UPDATE tags SET is_deleted=TRUE, mod_time=CURRENT_TIMESTAMP
       WHERE id=$1 RETURNING id, is_deleted, mod_time`,
      [existing.id],
    );
    res.json({ success: true, data: r.rows[0] });
  } catch (err) { next(err); }
});

export default router;
