import express from 'express';

import { requireAuth } from '../middleware/authMiddleware.js';
import { lwwCheck }    from '../middleware/lastWriteWins.js';
import { query }       from '../config/db.js';

const router = express.Router();
router.use(requireAuth);

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
const RETURN_COLUMNS = `
  id, semester, course_code, course_name, course_name_en,
  credits, letter_grade, is_deleted, mod_time
`;

// Điểm chữ hợp lệ theo thang HUST (NULL = chưa có điểm).
const VALID_LETTERS = ['A+', 'A', 'B+', 'B', 'C+', 'C', 'D+', 'D', 'F'];

const normalizeLetter = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const up = String(v).trim().toUpperCase();
  return VALID_LETTERS.includes(up) ? up : null;
};

const normalizeCredits = (v) => {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n < 0 || n > 30) {
    const err = new Error('credits phải là số nguyên 0..30.');
    err.statusCode = 400;
    throw err;
  }
  return n;
};

// ─────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────

// GET /api/grades  (?include_deleted=true để lấy cả đã xoá — dùng khi sync)
router.get('/', async (req, res, next) => {
  try {
    const extra = req.query.include_deleted === 'true' ? '' : 'AND is_deleted=FALSE';
    const r = await query(
      `SELECT ${RETURN_COLUMNS}
       FROM grades
       WHERE user_id=$1 ${extra}
       ORDER BY semester ASC, course_code ASC`,
      [req.user.id],
    );
    res.json({ success: true, data: r.rows });
  } catch (err) { next(err); }
});

// POST /api/grades
// Body: { semester, course_code, course_name, course_name_en?, credits?, letter_grade? }
router.post('/', async (req, res, next) => {
  const {
    semester,
    course_code,
    course_name,
    course_name_en = null,
  } = req.body;

  if (!semester?.toString().trim())    return res.status(400).json({ success: false, message: 'semester là bắt buộc.' });
  if (!course_code?.toString().trim()) return res.status(400).json({ success: false, message: 'course_code là bắt buộc.' });
  if (!course_name?.toString().trim()) return res.status(400).json({ success: false, message: 'course_name là bắt buộc.' });

  let credits, letter;
  try {
    credits = normalizeCredits(req.body.credits);
    letter  = normalizeLetter(req.body.letter_grade);
  } catch (e) {
    return res.status(e.statusCode ?? 400).json({ success: false, message: e.message });
  }

  try {
    const r = await query(
      `INSERT INTO grades
         (user_id, semester, course_code, course_name, course_name_en, credits, letter_grade)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${RETURN_COLUMNS}`,
      [
        req.user.id,
        semester.toString().trim(),
        course_code.toString().trim().toUpperCase(),
        course_name.toString().trim(),
        course_name_en?.toString().trim() || null,
        credits,
        letter,
      ],
    );
    res.status(201).json({ success: true, data: r.rows[0] });
  } catch (err) { next(err); }
});

// PUT /api/grades/:id  [LWW]
router.put('/:id', lwwCheck('grades'), async (req, res, next) => {
  const {
    semester,
    course_code,
    course_name,
    course_name_en = null,
  } = req.body;

  if (!semester?.toString().trim())    return res.status(400).json({ success: false, message: 'semester là bắt buộc.' });
  if (!course_code?.toString().trim()) return res.status(400).json({ success: false, message: 'course_code là bắt buộc.' });
  if (!course_name?.toString().trim()) return res.status(400).json({ success: false, message: 'course_name là bắt buộc.' });

  let credits, letter;
  try {
    credits = normalizeCredits(req.body.credits);
    letter  = normalizeLetter(req.body.letter_grade);
  } catch (e) {
    return res.status(e.statusCode ?? 400).json({ success: false, message: e.message });
  }

  const existing = req.serverRecord
    ?? (await query('SELECT id FROM grades WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id])).rows[0];
  if (!existing) return res.status(404).json({ success: false, message: 'Grade không tồn tại.' });

  try {
    const r = await query(
      `UPDATE grades SET
         semester=$1, course_code=$2, course_name=$3, course_name_en=$4,
         credits=$5, letter_grade=$6,
         is_deleted=FALSE, mod_time=CURRENT_TIMESTAMP
       WHERE id=$7
       RETURNING ${RETURN_COLUMNS}`,
      [
        semester.toString().trim(),
        course_code.toString().trim().toUpperCase(),
        course_name.toString().trim(),
        course_name_en?.toString().trim() || null,
        credits,
        letter,
        existing.id,
      ],
    );
    res.json({ success: true, data: r.rows[0] });
  } catch (err) { next(err); }
});

// DELETE /api/grades/:id  [LWW]  — soft delete
router.delete('/:id', lwwCheck('grades'), async (req, res, next) => {
  try {
    const existing = req.serverRecord
      ?? (await query('SELECT id FROM grades WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id])).rows[0];
    if (!existing) return res.status(404).json({ success: false, message: 'Grade không tồn tại.' });
    const r = await query(
      `UPDATE grades SET is_deleted=TRUE, mod_time=CURRENT_TIMESTAMP
       WHERE id=$1 RETURNING id, is_deleted, mod_time`,
      [existing.id],
    );
    res.json({ success: true, data: r.rows[0] });
  } catch (err) { next(err); }
});

export default router;
