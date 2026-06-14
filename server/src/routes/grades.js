import express from 'express';

import { requireAuth } from '../middleware/authMiddleware.js';
import { lwwCheck }    from '../middleware/lastWriteWins.js';
import { AppError }    from '../utils/AppError.js';
import {
  listGrades,
  findGrade,
  createGrade,
  replaceGrade,
  softDeleteGrade,
} from '../services/gradeService.js';

const router = express.Router();
router.use(requireAuth);

const requireGradeFields = (body) => {
  if (!body.semester?.toString().trim())    throw new AppError('semester là bắt buộc.', 400);
  if (!body.course_code?.toString().trim()) throw new AppError('course_code là bắt buộc.', 400);
  if (!body.course_name?.toString().trim()) throw new AppError('course_name là bắt buộc.', 400);
};

// GET /api/grades
router.get('/', async (req, res, next) => {
  try {
    const rows = await listGrades(req.user.id, req.query.include_deleted === 'true');
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// POST /api/grades
router.post('/', async (req, res, next) => {
  try {
    requireGradeFields(req.body);
    const grade = await createGrade(req.user.id, req.body);
    res.status(201).json({ success: true, data: grade });
  } catch (err) { next(err); }
});

// PUT /api/grades/:id  [LWW]
router.put('/:id', lwwCheck('grades'), async (req, res, next) => {
  try {
    requireGradeFields(req.body);
    const existing = req.serverRecord ?? await findGrade(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ success: false, message: 'Grade không tồn tại.' });
    const grade = await replaceGrade(existing.id, req.body);
    res.json({ success: true, data: grade });
  } catch (err) { next(err); }
});

// DELETE /api/grades/:id  [LWW]
router.delete('/:id', lwwCheck('grades'), async (req, res, next) => {
  try {
    const existing = req.serverRecord ?? await findGrade(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ success: false, message: 'Grade không tồn tại.' });
    res.json({ success: true, data: await softDeleteGrade(existing.id) });
  } catch (err) { next(err); }
});

export default router;
