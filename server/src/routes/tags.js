import express from 'express';

import { requireAuth }                                from '../middleware/authMiddleware.js';
import { lwwCheck }                                   from '../middleware/lastWriteWins.js';
import { listTags, findTag, createTag, updateTag, softDeleteTag } from '../services/tagService.js';

const router = express.Router();
router.use(requireAuth);

// GET /api/tags
router.get('/', async (req, res, next) => {
  try {
    const rows = await listTags(req.user.id, req.query.include_deleted === 'true');
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// POST /api/tags
router.post('/', async (req, res, next) => {
  try {
    const tag = await createTag(req.user.id, req.body.name, req.body.color_hex ?? null);
    res.status(201).json({ success: true, data: tag });
  } catch (err) { next(err); }
});

// PUT /api/tags/:id  [LWW]
router.put('/:id', lwwCheck('tags'), async (req, res, next) => {
  try {
    const existing = req.serverRecord ?? await findTag(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ success: false, message: 'Tag không tồn tại.' });
    const tag = await updateTag(existing.id, req.body);
    res.json({ success: true, data: tag });
  } catch (err) { next(err); }
});

// DELETE /api/tags/:id  [LWW]
router.delete('/:id', lwwCheck('tags'), async (req, res, next) => {
  try {
    const existing = req.serverRecord ?? await findTag(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ success: false, message: 'Tag không tồn tại.' });
    res.json({ success: true, data: await softDeleteTag(existing.id) });
  } catch (err) { next(err); }
});

export default router;
