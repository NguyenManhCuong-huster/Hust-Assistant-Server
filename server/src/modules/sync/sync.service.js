import { query } from '../../shared/database/db.js';
import { sanitizePriority, sanitizeLat, sanitizeLng } from '../../shared/utils/validators.js';
import { TASK_COLUMNS } from '../../dao/tasks.dao.js';

export { TASK_COLUMNS };

export const getServerTime = async () => {
  const { rows: [{ server_time }] } = await query('SELECT NOW() AS server_time');
  return server_time;
};

export const pullChanges = async (userId, since) => {
  const [tasksResult, tagsResult] = await Promise.all([
    query(
      `SELECT ${TASK_COLUMNS},
              COALESCE(json_agg(json_build_object('id', tg.id, 'name', tg.name, 'color_hex', tg.color_hex))
                FILTER (WHERE tg.id IS NOT NULL AND ttcr.is_deleted=FALSE), '[]') AS tags
       FROM tasks t
       LEFT JOIN task_tag_cross_ref ttcr ON ttcr.task_id = t.id
       LEFT JOIN tags tg ON tg.id = ttcr.tag_id
       WHERE t.user_id=$1 AND t.mod_time > $2
       GROUP BY t.id ORDER BY t.mod_time ASC`,
      [userId, since],
    ),
    query(
      `SELECT id, name, color_hex, is_deleted, mod_time FROM tags
       WHERE user_id=$1 AND mod_time > $2 ORDER BY mod_time ASC`,
      [userId, since],
    ),
  ]);
  return { tasks: tasksResult.rows, tags: tagsResult.rows };
};

export const pushChanges = async (userId, tasks, tags) => {
  const [taskResults, tagResults] = await Promise.all([
    Promise.all(tasks.map((item) => processSyncItem(item, 'tasks', userId))),
    Promise.all(tags.map((item)  => processSyncItem(item, 'tags',  userId))),
  ]);
  return { taskResults, tagResults };
};

// ─── Private helpers ───────────────────────────────────────────────────────────

const getItem = async (table, id, userId) => {
  const r = await query(`SELECT * FROM ${table} WHERE id=$1 AND user_id=$2`, [id, userId]);
  return r.rows[0] ?? null;
};

const softDelete = async (table, id) => {
  const r = await query(
    `UPDATE ${table} SET is_deleted=TRUE, mod_time=CURRENT_TIMESTAMP
     WHERE id=$1 RETURNING id, is_deleted, mod_time`,
    [id],
  );
  return r.rows[0];
};

const createTaskRow = async (userId, data) => {
  const {
    title, description = null, start_time = null, end_time = null,
    task_type = 'TODO', source_type = 'MANUAL', source_id = null, address_name = null,
  } = data;
  const r = await query(
    `INSERT INTO tasks
       (user_id, title, description, start_time, end_time, task_type,
        source_type, source_id, priority, latitude, longitude, address_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, 2), $10, $11, $12) RETURNING *`,
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
};

const updateTaskRow = async (userId, data) => {
  const {
    id, title, description = null, start_time = null, end_time = null,
    task_type = 'TODO', is_completed = false, source_type = 'MANUAL',
    source_id = null, address_name = null,
  } = data;
  const r = await query(
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
};

const createTagRow = async (userId, data) => {
  const { name, color_hex = null } = data;
  const r = await query(
    'INSERT INTO tags (user_id, name, color_hex) VALUES ($1, $2, $3) RETURNING *',
    [userId, name, color_hex],
  );
  return r.rows[0];
};

const updateTagRow = async (userId, data) => {
  const { id, name, color_hex = null } = data;
  const r = await query(
    `UPDATE tags SET name=$1, color_hex=$2, is_deleted=FALSE, mod_time=CURRENT_TIMESTAMP
     WHERE id=$3 AND user_id=$4 RETURNING *`,
    [name, color_hex, id, userId],
  );
  return r.rows[0];
};

const processSyncItem = async (item, table, userId) => {
  const { _action = 'upsert', mod_time: clientModTime, ...data } = item;
  const isDelete = _action === 'delete';

  try {
    if (!data.id) {
      if (isDelete) return { _action, status: 'skipped', reason: 'Không thể xóa item chưa có id.' };
      const row = table === 'tasks' ? await createTaskRow(userId, data) : await createTagRow(userId, data);
      return { _action, status: 'created', data: row };
    }

    const existing = await getItem(table, data.id, userId);
    if (!existing) {
      if (isDelete) return { id: data.id, _action, status: 'skipped', reason: 'Item không tồn tại trên server.' };
      const row = table === 'tasks' ? await createTaskRow(userId, data) : await createTagRow(userId, data);
      return { _action, status: 'created', data: row };
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

    if (isDelete) return { id: data.id, _action, status: 'deleted', data: await softDelete(table, data.id) };

    const row = table === 'tasks' ? await updateTaskRow(userId, data) : await updateTagRow(userId, data);
    return { id: data.id, _action, status: 'updated', data: row };
  } catch (err) {
    return { id: data.id, _action, status: 'error', error: err.message };
  }
};
