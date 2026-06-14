import { parsePagination, buildPageMeta } from '../../shared/utils/paginate.js';
import * as svc from './tasks.service.js';

export const listTasks = async (req, res, next) => {
  try {
    const {
      type, completed, source_type, from, to,
      sort = 'mod_time', order = 'desc', include_deleted = 'false',
    } = req.query;
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

    const { rows, total } = await svc.listTasksWithTags(req.user.id, {
      conditions, params, safeSort, safeOrder, limit, offset,
    });
    res.json({ success: true, data: rows, meta: buildPageMeta(total, page, limit) });
  } catch (err) { next(err); }
};

export const getTask = async (req, res, next) => {
  try {
    const task = await svc.fetchTaskWithTags(req.params.id, req.user.id);
    if (!task) return res.status(404).json({ success: false, message: 'Task không tồn tại.' });
    res.json({ success: true, data: task });
  } catch (err) { next(err); }
};

export const createTask = async (req, res, next) => {
  try {
    const { title, tag_ids = [] } = req.body;
    const taskId = await svc.createTask(req.user.id, req.body, tag_ids);
    res.status(201).json({ success: true, data: await svc.fetchTaskWithTags(taskId, req.user.id) });
  } catch (err) { next(err); }
};

export const replaceTask = async (req, res, next) => {
  try {
    const { title, tag_ids = [] } = req.body;
    const existing = req.serverRecord ?? await svc.findTask(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ success: false, message: 'Task không tồn tại.' });
    await svc.replaceTask(existing.id, req.user.id, req.body, tag_ids);
    res.json({ success: true, data: await svc.fetchTaskWithTags(existing.id, req.user.id) });
  } catch (err) { next(err); }
};

export const patchTask = async (req, res, next) => {
  try {
    const existing = req.serverRecord ?? await svc.findTask(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ success: false, message: 'Task không tồn tại.' });

    const tagIds = 'tag_ids' in req.body ? req.body.tag_ids : undefined;
    await svc.patchTask(existing.id, req.user.id, req.body, tagIds);
    res.json({ success: true, data: await svc.fetchTaskWithTags(existing.id, req.user.id) });
  } catch (err) { next(err); }
};

export const deleteTask = async (req, res, next) => {
  try {
    const existing = req.serverRecord ?? await svc.findTask(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ success: false, message: 'Task không tồn tại.' });
    res.json({ success: true, data: await svc.softDeleteTask(existing.id) });
  } catch (err) { next(err); }
};
