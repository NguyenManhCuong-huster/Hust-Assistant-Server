import express from 'express';

import { requireAuth }                               from '../middleware/authMiddleware.js';
import { lwwCheck }                                  from '../middleware/lastWriteWins.js';
import { query }                                     from '../config/db.js';
import { AppError }                                  from '../utils/AppError.js';
import { parsePagination, buildPageMeta }            from '../utils/paginate.js';
import {
  TASK_COLUMNS,
  findTask,
  fetchTaskWithTags,
  createTask,
  replaceTask,
  patchTask,
  softDeleteTask,
} from '../services/taskService.js';

const router = express.Router();
router.use(requireAuth);

// GET /api/tasks
router.get('/', async (req, res, next) => {
  try {
    const { type, completed, source_type, from, to, sort = 'mod_time', order = 'desc', include_deleted = 'false' } = req.query;
    const { page, limit, offset } = parsePagination(req.query);

    const safeSort  = ['start_time', 'end_time', 'mod_time'].includes(sort) ? sort : 'mod_time';
    const safeOrder = order === 'asc' ? 'asc' : 'desc';

    const conditions = ['t.user_id = $1'];
    const params     = [req.user.id];
    let   idx        = 2;

    if (include_deleted !== 'true') conditions.push('t.is_deleted = FALSE');
    if (type)                    { conditions.push(`t.task_type=$${idx++}`);    params.push(type.toUpperCase()); }
    if (completed !== undefined) { conditions.push(`t.is_completed=$${idx++}`); params.push(completed === 'true'); }
    if (source_type)             { conditions.push(`t.source_type=$${idx++}`);  params.push(source_type.toUpperCase()); }
    if (from)                    { conditions.push(`t.start_time>=$${idx++}`);  params.push(from); }
    if (to)                      { conditions.push(`t.end_time<=$${idx++}`);    params.push(to); }

    const where = conditions.join(' AND ');
    const [tasksResult, countResult] = await Promise.all([
      query(
        `SELECT ${TASK_COLUMNS},
                COALESCE(json_agg(json_build_object('id', tg.id, 'name', tg.name, 'color_hex', tg.color_hex))
                  FILTER (WHERE tg.id IS NOT NULL), '[]') AS tags
         FROM tasks t
         LEFT JOIN task_tag_cross_ref ttcr ON ttcr.task_id = t.id AND ttcr.is_deleted = FALSE
         LEFT JOIN tags tg ON tg.id = ttcr.tag_id AND tg.is_deleted = FALSE
         WHERE ${where}
         GROUP BY t.id
         ORDER BY t.${safeSort} ${safeOrder}
         LIMIT $${idx++} OFFSET $${idx++}`,
        [...params, limit, offset],
      ),
      query(`SELECT COUNT(*) FROM tasks t WHERE ${where}`, params),
    ]);

    const total = Number.parseInt(countResult.rows[0].count, 10);
    res.json({ success: true, data: tasksResult.rows, meta: buildPageMeta(total, page, limit) });
  } catch (err) { next(err); }
});

// GET /api/tasks/:id
router.get('/:id', async (req, res, next) => {
  try {
    const task = await fetchTaskWithTags(req.params.id, req.user.id);
    if (!task) return res.status(404).json({ success: false, message: 'Task không tồn tại.' });
    res.json({ success: true, data: task });
  } catch (err) { next(err); }
});

// POST /api/tasks
router.post('/', async (req, res, next) => {
  try {
    const { title, tag_ids = [] } = req.body;
    if (!title?.trim()) throw new AppError('title là bắt buộc.', 400);
    const taskId = await createTask(req.user.id, req.body, tag_ids);
    res.status(201).json({ success: true, data: await fetchTaskWithTags(taskId, req.user.id) });
  } catch (err) { next(err); }
});

// PUT /api/tasks/:id  [LWW]
router.put('/:id', lwwCheck('tasks'), async (req, res, next) => {
  try {
    const { title, tag_ids = [] } = req.body;
    if (!title?.trim()) throw new AppError('title là bắt buộc.', 400);
    const existing = req.serverRecord ?? await findTask(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ success: false, message: 'Task không tồn tại.' });
    await replaceTask(existing.id, req.user.id, req.body, tag_ids);
    res.json({ success: true, data: await fetchTaskWithTags(existing.id, req.user.id) });
  } catch (err) { next(err); }
});

// PATCH /api/tasks/:id  [LWW]
router.patch('/:id', lwwCheck('tasks'), async (req, res, next) => {
  try {
    const existing = req.serverRecord ?? await findTask(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ success: false, message: 'Task không tồn tại.' });

    const PATCHABLE = ['title', 'description', 'start_time', 'end_time', 'task_type',
      'is_completed', 'source_type', 'source_id', 'priority', 'latitude', 'longitude',
      'address_name', 'tag_ids'];
    if (!PATCHABLE.some((f) => f in req.body)) {
      throw new AppError('Không có field nào được cập nhật.', 400);
    }

    const tagIds = 'tag_ids' in req.body ? req.body.tag_ids : undefined;
    await patchTask(existing.id, req.user.id, req.body, tagIds);
    res.json({ success: true, data: await fetchTaskWithTags(existing.id, req.user.id) });
  } catch (err) { next(err); }
});

// DELETE /api/tasks/:id  [LWW]
router.delete('/:id', lwwCheck('tasks'), async (req, res, next) => {
  try {
    const existing = req.serverRecord ?? await findTask(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ success: false, message: 'Task không tồn tại.' });
    res.json({ success: true, data: await softDeleteTask(existing.id) });
  } catch (err) { next(err); }
});

export default router;
