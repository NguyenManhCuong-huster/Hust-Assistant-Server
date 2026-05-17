import express from 'express';
import { requireAuth } from '../middleware/authMiddleware.js';
import { query } from '../config/db.js';

const router = express.Router();
router.use(requireAuth);

const ALLOWED_FIELDS = [
  'student_id', 'full_name', 'date_of_birth', 'phone',
  'school', 'major', 'class_name', 'course',
];

const RETURN_COLUMNS = `
  user_id, student_id, full_name, date_of_birth, phone,
  school, major, class_name, course, created_at, mod_time
`;

// Student ID (HUST): 7–10 digits (e.g. 20226XXX)
const isValidStudentId = (v) => typeof v === 'string' && /^\d{7,10}$/.test(v);

// Course: "K" + 2–3 digits, e.g. K66, K67, K100
const isValidCourse = (v) => typeof v === 'string' && /^K\d{2,3}$/i.test(v);

// Phone: 9–15 digits, optional leading +
const isValidPhone = (v) => typeof v === 'string' && /^\+?\d{9,15}$/.test(v);

const isValidDate = (v) => !Number.isNaN(new Date(v).getTime());

const sanitize = (body) => {
  const out = {};
  for (const f of ALLOWED_FIELDS) {
    if (f in body) {
      const v = body[f];
      if (v === null || v === undefined) { out[f] = null; }
      else if (typeof v === 'string') { const t = v.trim(); out[f] = t === '' ? null : t; }
      else { out[f] = v; }
    }
  }
  if (typeof out.course === 'string') out.course = out.course.toUpperCase();
  return out;
};

const validate = (data, { partial = false } = {}) => {
  if (!partial && !data.student_id) return 'student_id is required when creating a profile.';
  if (data.student_id != null && !isValidStudentId(data.student_id)) return 'student_id must be 7–10 digits.';
  if (data.course != null && !isValidCourse(data.course)) return 'course must be in the format "K" + 2–3 digits (e.g. K66).';
  if (data.phone != null && !isValidPhone(data.phone)) return 'phone is invalid (9–15 digits, optionally prefixed with +).';
  if (data.date_of_birth != null && !isValidDate(data.date_of_birth)) return 'date_of_birth is invalid. Use YYYY-MM-DD.';
  if (data.full_name   != null && data.full_name.length   > 255) return 'full_name is too long (>255 characters).';
  if (data.school      != null && data.school.length      > 255) return 'school is too long (>255 characters).';
  if (data.major       != null && data.major.length       > 255) return 'major is too long (>255 characters).';
  if (data.class_name  != null && data.class_name.length  > 50)  return 'class_name is too long (>50 characters).';
  return null;
};

// GET /api/user-info
router.get('/', async (req, res, next) => {
  try {
    const r = await query(`SELECT ${RETURN_COLUMNS} FROM user_info WHERE user_id=$1`, [req.user.id]);
    if (!r.rows[0]) return res.status(404).json({ success: false, message: 'No student profile found. Use POST /api/user-info to create one.' });
    res.json({ success: true, data: r.rows[0] });
  } catch (err) { next(err); }
});

// POST /api/user-info — Create (409 if profile already exists)
router.post('/', async (req, res, next) => {
  const data = sanitize(req.body);
  const vErr = validate(data);
  if (vErr) return res.status(400).json({ success: false, message: vErr });
  try {
    const r = await query(
      `INSERT INTO user_info (user_id, student_id, full_name, date_of_birth, phone, school, major, class_name, course)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${RETURN_COLUMNS}`,
      [req.user.id, data.student_id, data.full_name ?? null, data.date_of_birth ?? null,
       data.phone ?? null, data.school ?? null, data.major ?? null, data.class_name ?? null, data.course ?? null],
    );
    res.status(201).json({ success: true, data: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: 'A student profile already exists. Use PUT or PATCH to update it.' });
    next(err);
  }
});

// PUT /api/user-info — Upsert
router.put('/', async (req, res, next) => {
  const data = sanitize(req.body);
  const vErr = validate(data);
  if (vErr) return res.status(400).json({ success: false, message: vErr });
  try {
    const r = await query(
      `INSERT INTO user_info (user_id, student_id, full_name, date_of_birth, phone, school, major, class_name, course)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (user_id) DO UPDATE SET
         student_id=EXCLUDED.student_id, full_name=EXCLUDED.full_name, date_of_birth=EXCLUDED.date_of_birth,
         phone=EXCLUDED.phone, school=EXCLUDED.school, major=EXCLUDED.major,
         class_name=EXCLUDED.class_name, course=EXCLUDED.course, mod_time=CURRENT_TIMESTAMP
       RETURNING ${RETURN_COLUMNS}`,
      [req.user.id, data.student_id, data.full_name ?? null, data.date_of_birth ?? null,
       data.phone ?? null, data.school ?? null, data.major ?? null, data.class_name ?? null, data.course ?? null],
    );
    res.json({ success: true, data: r.rows[0] });
  } catch (err) { next(err); }
});

// PATCH /api/user-info — Partial update
router.patch('/', async (req, res, next) => {
  const data = sanitize(req.body);
  const vErr = validate(data, { partial: true });
  if (vErr) return res.status(400).json({ success: false, message: vErr });
  const keys = Object.keys(data);
  if (keys.length === 0) return res.status(400).json({ success: false, message: 'No fields provided for update.' });
  try {
    const existing = await query('SELECT user_id FROM user_info WHERE user_id=$1', [req.user.id]);
    if (!existing.rows[0]) return res.status(404).json({ success: false, message: 'No student profile found. Use POST to create one first.' });
    const setClauses = keys.map((k, i) => `${k}=$${i + 1}`);
    setClauses.push('mod_time=CURRENT_TIMESTAMP');
    const r = await query(
      `UPDATE user_info SET ${setClauses.join(',')} WHERE user_id=$${keys.length + 1} RETURNING ${RETURN_COLUMNS}`,
      [...keys.map((k) => data[k]), req.user.id],
    );
    res.json({ success: true, data: r.rows[0] });
  } catch (err) { next(err); }
});

// DELETE /api/user-info — Hard delete
router.delete('/', async (req, res, next) => {
  try {
    const r = await query('DELETE FROM user_info WHERE user_id=$1 RETURNING user_id', [req.user.id]);
    if (!r.rows[0]) return res.status(404).json({ success: false, message: 'No student profile found to delete.' });
    res.json({ success: true, message: 'Student profile deleted.' });
  } catch (err) { next(err); }
});

export default router;