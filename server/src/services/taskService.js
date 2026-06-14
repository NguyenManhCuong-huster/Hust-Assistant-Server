import { query, getClient } from '../config/db.js';
import { normalizePriority, normalizeLat, normalizeLng } from '../utils/validators.js';

// Shared column list — used here AND in sync.js to avoid duplication.
export const TASK_COLUMNS = `
  t.id, t.title, t.description, t.start_time, t.end_time,
  t.task_type, t.is_completed, t.source_type, t.source_id,
  t.priority, t.latitude, t.longitude, t.address_name,
  t.is_deleted, t.mod_time
`;

// ── Queries ──────────────────────────────────────────────────────────────────

export const findTask = async (id, userId) => {
  const r = await query(
    'SELECT * FROM tasks WHERE id=$1 AND user_id=$2',
    [id, userId],
  );
  return r.rows[0] ?? null;
};

export const fetchTaskWithTags = async (taskId, userId) => {
  const r = await query(
    `SELECT ${TASK_COLUMNS},
            COALESCE(json_agg(json_build_object('id', tg.id, 'name', tg.name, 'color_hex', tg.color_hex))
              FILTER (WHERE tg.id IS NOT NULL), '[]') AS tags
     FROM tasks t
     LEFT JOIN task_tag_cross_ref ttcr ON ttcr.task_id = t.id AND ttcr.is_deleted = FALSE
     LEFT JOIN tags tg ON tg.id = ttcr.tag_id AND tg.is_deleted = FALSE
     WHERE t.id=$1 AND t.user_id=$2
     GROUP BY t.id`,
    [taskId, userId],
  );
  return r.rows[0] ?? null;
};

// ── Tag management (must be called inside an open transaction) ────────────────

export const attachTagsInTx = async (client, taskId, userId, tagIds) => {
  if (!tagIds?.length) return;
  const valid = await client.query(
    'SELECT id FROM tags WHERE id=ANY($1) AND user_id=$2 AND is_deleted=FALSE',
    [tagIds, userId],
  );
  for (const t of valid.rows) {
    await client.query(
      `INSERT INTO task_tag_cross_ref (task_id, tag_id, is_deleted)
       VALUES ($1, $2, FALSE)
       ON CONFLICT (task_id, tag_id)
         DO UPDATE SET is_deleted=FALSE, mod_time=CURRENT_TIMESTAMP`,
      [taskId, t.id],
    );
  }
};

export const detachAllTagsInTx = async (client, taskId) => {
  await client.query(
    'UPDATE task_tag_cross_ref SET is_deleted=TRUE WHERE task_id=$1',
    [taskId],
  );
};

// ── Mutations ─────────────────────────────────────────────────────────────────

export const createTask = async (userId, fields, tagIds = []) => {
  const {
    title,
    description  = null,
    start_time   = null,
    end_time     = null,
    task_type    = 'TODO',
    source_type  = 'MANUAL',
    source_id    = null,
    address_name = null,
  } = fields;

  const priority  = normalizePriority(fields.priority);
  const latitude  = normalizeLat(fields.latitude);
  const longitude = normalizeLng(fields.longitude);

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO tasks
         (user_id, title, description, start_time, end_time, task_type,
          source_type, source_id, priority, latitude, longitude, address_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, 2), $10, $11, $12)
       RETURNING id`,
      [
        userId, title.trim(), description,
        start_time, end_time,
        task_type.toUpperCase(), source_type.toUpperCase(),
        source_id, priority, latitude, longitude, address_name,
      ],
    );
    await attachTagsInTx(client, rows[0].id, userId, tagIds);
    await client.query('COMMIT');
    return rows[0].id;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const replaceTask = async (taskId, userId, fields, tagIds = []) => {
  const {
    title,
    description  = null,
    start_time   = null,
    end_time     = null,
    task_type    = 'TODO',
    is_completed = false,
    source_type  = 'MANUAL',
    source_id    = null,
    address_name = null,
  } = fields;

  const priority  = normalizePriority(fields.priority);
  const latitude  = normalizeLat(fields.latitude);
  const longitude = normalizeLng(fields.longitude);

  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE tasks SET
         title=$1, description=$2, start_time=$3, end_time=$4, task_type=$5,
         is_completed=$6, source_type=$7, source_id=$8,
         priority=COALESCE($9, priority),
         latitude=$10, longitude=$11, address_name=$12,
         is_deleted=FALSE, mod_time=CURRENT_TIMESTAMP
       WHERE id=$13`,
      [
        title.trim(), description, start_time, end_time,
        task_type.toUpperCase(), is_completed,
        source_type.toUpperCase(), source_id,
        priority, latitude, longitude, address_name,
        taskId,
      ],
    );
    await detachAllTagsInTx(client, taskId);
    await attachTagsInTx(client, taskId, userId, tagIds);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const patchTask = async (taskId, userId, fieldMap, tagIds) => {
  const ALLOWED = [
    'title', 'description', 'start_time', 'end_time',
    'task_type', 'is_completed', 'source_type', 'source_id',
    'priority', 'latitude', 'longitude', 'address_name',
  ];

  const setClauses = [];
  const params     = [];
  let   idx        = 1;

  for (const f of ALLOWED) {
    if (!(f in fieldMap)) continue;
    let val = fieldMap[f];
    if (f === 'task_type' || f === 'source_type') val = val?.toUpperCase();
    if (f === 'priority')  val = normalizePriority(val);
    if (f === 'latitude')  val = normalizeLat(val);
    if (f === 'longitude') val = normalizeLng(val);
    setClauses.push(`${f}=$${idx++}`);
    params.push(val);
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');
    if (setClauses.length > 0) {
      setClauses.push('mod_time=CURRENT_TIMESTAMP');
      await client.query(
        `UPDATE tasks SET ${setClauses.join(',')} WHERE id=$${idx}`,
        [...params, taskId],
      );
    }
    if (tagIds !== undefined) {
      await detachAllTagsInTx(client, taskId);
      await attachTagsInTx(client, taskId, userId, tagIds);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const softDeleteTask = async (taskId) => {
  const r = await query(
    `UPDATE tasks SET is_deleted=TRUE, mod_time=CURRENT_TIMESTAMP
     WHERE id=$1 RETURNING id, is_deleted, mod_time`,
    [taskId],
  );
  return r.rows[0];
};
