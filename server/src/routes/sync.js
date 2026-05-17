import express from 'express';

import { requireAuth }      from '../middleware/authMiddleware.js';
import { query, getClient } from '../config/db.js';

const router = express.Router();
router.use(requireAuth);

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
const TASK_COLUMNS = `
  t.id, t.title, t.description, t.start_time, t.end_time,
  t.task_type, t.is_completed, t.source_type, t.source_id,
  t.priority, t.latitude, t.longitude, t.address_name,
  t.is_deleted, t.mod_time
`;

const getItem = async (c, t, id, uid) => {
  const r = await c.query(`SELECT * FROM ${t} WHERE id=$1 AND user_id=$2`, [id, uid]);
  return r.rows[0] ?? null;
};

const softDelete = async (c, t, id) => {
  const r = await c.query(
    `UPDATE ${t} SET is_deleted=TRUE, mod_time=CURRENT_TIMESTAMP
     WHERE id=$1 RETURNING id, is_deleted, mod_time`,
    [id],
  );
  return r.rows[0];
};

// Sanitize helpers — trả về null nếu không hợp lệ thay vì throw
// (sync batch: 1 record lỗi không nên fail cả batch).
const sanitizePriority = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n >= 1 && n <= 4 ? n : null;
};
const sanitizeLat = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= -90 && n <= 90 ? n : null;
};
const sanitizeLng = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= -180 && n <= 180 ? n : null;
};

const createItem = async (client, table, userId, data) => {
  if (table === 'tasks') {
    const {
      title,
      description  = null,
      start_time   = null,
      end_time     = null,
      task_type    = 'TODO',
      source_type  = 'MANUAL',
      source_id    = null,
      address_name = null,
    } = data;
    const r = await client.query(
      `INSERT INTO tasks
         (user_id, title, description, start_time, end_time, task_type,
          source_type, source_id, priority, latitude, longitude, address_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, 2), $10, $11, $12)
       RETURNING *`,
      [
        userId, title, description, start_time, end_time,
        task_type?.toUpperCase()   ?? 'TODO',
        source_type?.toUpperCase() ?? 'MANUAL',
        source_id,
        sanitizePriority(data.priority),
        sanitizeLat(data.latitude),
        sanitizeLng(data.longitude),
        address_name,
      ],
    );
    return r.rows[0];
  }
  const { name, color_hex = null } = data;
  const r = await client.query(
    'INSERT INTO tags (user_id, name, color_hex) VALUES ($1, $2, $3) RETURNING *',
    [userId, name, color_hex],
  );
  return r.rows[0];
};

const updateItem = async (client, table, userId, data) => {
  if (table === 'tasks') {
    const {
      id,
      title,
      description  = null,
      start_time   = null,
      end_time     = null,
      task_type    = 'TODO',
      is_completed = false,
      source_type  = 'MANUAL',
      source_id    = null,
      address_name = null,
    } = data;
    const r = await client.query(
      `UPDATE tasks SET
         title=$1, description=$2, start_time=$3, end_time=$4, task_type=$5,
         is_completed=$6, source_type=$7, source_id=$8,
         priority=COALESCE($9, priority),
         latitude=$10, longitude=$11, address_name=$12,
         is_deleted=FALSE, mod_time=CURRENT_TIMESTAMP
       WHERE id=$13 AND user_id=$14 RETURNING *`,
      [
        title, description, start_time, end_time,
        task_type?.toUpperCase()   ?? 'TODO',
        is_completed,
        source_type?.toUpperCase() ?? 'MANUAL',
        source_id,
        sanitizePriority(data.priority),
        sanitizeLat(data.latitude),
        sanitizeLng(data.longitude),
        address_name,
        id, userId,
      ],
    );
    return r.rows[0];
  }
  const { id, name, color_hex = null } = data;
  const r = await client.query(
    `UPDATE tags SET name=$1, color_hex=$2, is_deleted=FALSE, mod_time=CURRENT_TIMESTAMP
     WHERE id=$3 AND user_id=$4 RETURNING *`,
    [name, color_hex, id, userId],
  );
  return r.rows[0];
};

const processSyncItem = async (client, item, table, userId) => {
  const { _action = 'upsert', mod_time: clientModTime, ...data } = item;
  const isDelete = _action === 'delete';

  try {
    if (!data.id) {
      if (isDelete) return { _action, status: 'skipped', reason: 'Không thể xóa item chưa có id.' };
      return { _action, status: 'created', data: await createItem(client, table, userId, data) };
    }
    const existing = await getItem(client, table, data.id, userId);
    if (!existing) {
      if (isDelete) return { id: data.id, _action, status: 'skipped', reason: 'Item không tồn tại trên server.' };
      return { _action, status: 'created', data: await createItem(client, table, userId, data) };
    }
    if (clientModTime && new Date(existing.mod_time) > new Date(clientModTime)) {
      return {
        id:              data.id,
        _action,
        status:          'conflict',
        server_record:   existing,
        client_mod_time: clientModTime,
        server_mod_time: existing.mod_time,
      };
    }
    if (isDelete) return { id: data.id, _action, status: 'deleted', data: await softDelete(client, table, data.id) };
    return { id: data.id, _action, status: 'updated', data: await updateItem(client, table, userId, data) };
  } catch (err) {
    return { id: data.id, _action, status: 'error', error: err.message };
  }
};

// ─────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────

// GET /api/sync?since=<ISO>  — Pull thay đổi từ server
router.get('/', async (req, res, next) => {
  try {
    const { since } = req.query;
    if (!since) {
      return res.status(400).json({ success: false, message: '"since" là bắt buộc. Dùng ISO 8601.' });
    }
    const sinceDate = new Date(since);
    if (Number.isNaN(sinceDate.getTime())) {
      return res.status(400).json({ success: false, message: '"since" không hợp lệ.' });
    }

    const { rows: [{ server_time }] } = await query('SELECT NOW() AS server_time');

    const [tasksResult, tagsResult] = await Promise.all([
      query(
        `SELECT ${TASK_COLUMNS},
                COALESCE(json_agg(json_build_object('id', tg.id, 'name', tg.name, 'color_hex', tg.color_hex))
                  FILTER (WHERE tg.id IS NOT NULL AND ttcr.is_deleted=FALSE), '[]') AS tags
         FROM tasks t
         LEFT JOIN task_tag_cross_ref ttcr ON ttcr.task_id = t.id
         LEFT JOIN tags tg ON tg.id = ttcr.tag_id
         WHERE t.user_id=$1 AND t.mod_time > $2
         GROUP BY t.id
         ORDER BY t.mod_time ASC`,
        [req.user.id, sinceDate],
      ),
      query(
        `SELECT id, name, color_hex, is_deleted, mod_time FROM tags
         WHERE user_id=$1 AND mod_time > $2
         ORDER BY mod_time ASC`,
        [req.user.id, sinceDate],
      ),
    ]);

    res.json({
      success:     true,
      server_time,
      changes: { tasks: tasksResult.rows, tags: tagsResult.rows },
      meta: { task_count: tasksResult.rowCount, tag_count: tagsResult.rowCount },
    });
  } catch (err) { next(err); }
});

// POST /api/sync  — Push batch thay đổi lên server
// Body: { tasks: [{_action, id?, mod_time, ...fields}], tags: [...] }
// status per item: created | updated | deleted | conflict | skipped | error
router.post('/', async (req, res, next) => {
  const { tasks = [], tags = [] } = req.body;
  if (!Array.isArray(tasks) || !Array.isArray(tags)) {
    return res.status(400).json({ success: false, message: 'tasks và tags phải là array.' });
  }

  const { rows: [{ server_time }] } = await query('SELECT NOW() AS server_time');
  const results = { tasks: [], tags: [] };
  const client  = await getClient();
  try {
    for (const item of tasks) results.tasks.push(await processSyncItem(client, item, 'tasks', req.user.id));
    for (const item of tags)  results.tags.push(await processSyncItem(client, item, 'tags', req.user.id));
    res.json({
      success: true,
      server_time,
      results,
      meta: {
        tasks_processed: tasks.length,
        tags_processed:  tags.length,
        conflicts:       [...results.tasks, ...results.tags].filter((r) => r.status === 'conflict').length,
      },
    });
  } catch (err) {
    next(err);
  } finally {
    client.release();
  }
});

export default router;
