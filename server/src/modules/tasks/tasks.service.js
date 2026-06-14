import { getClient } from '../../shared/database/db.js';
import { normalizePriority, normalizeLat, normalizeLng } from '../../shared/utils/validators.js';
import * as repo from '../../dao/tasks.dao.js';

export const { TASK_COLUMNS, findTask, fetchTaskWithTags, listTasksWithTags, softDeleteTask } = repo;

export const createTask = async (userId, fields, tagIds = []) => {
  const normalizedFields = normalizeTaskFields(fields);
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const row = await repo.insertTask(client, userId, normalizedFields);
    await repo.attachTagsInTx(client, row.id, userId, tagIds);
    await client.query('COMMIT');
    return row.id;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const replaceTask = async (taskId, userId, fields, tagIds = []) => {
  const normalizedFields = normalizeTaskFields(fields);
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await repo.replaceTaskRow(client, taskId, normalizedFields);
    await repo.detachAllTagsInTx(client, taskId);
    await repo.attachTagsInTx(client, taskId, userId, tagIds);
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
    await repo.patchTaskFields(client, taskId, setClauses, params);
    if (tagIds !== undefined) {
      await repo.detachAllTagsInTx(client, taskId);
      await repo.attachTagsInTx(client, taskId, userId, tagIds);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

const normalizeTaskFields = (fields) => ({
  ...fields,
  priority:  normalizePriority(fields.priority),
  latitude:  normalizeLat(fields.latitude),
  longitude: normalizeLng(fields.longitude),
});
