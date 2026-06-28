import { query, getClient } from '../../shared/database/db.js';
import { sanitizePriority, sanitizeLat, sanitizeLng } from '../../shared/utils/validators.js';
import { TASK_COLUMNS } from '../../dao/tasks.dao.js';

export { TASK_COLUMNS };

// ════════════════════════════════════════════════════════════════════════════
//  BATCH SYNC — mô hình thống nhất cho Task / Tag / Cross-ref (task_tag).
//
//  Nguyên tắc (chốt với khách):
//   • ID sinh 1 nơi, KHÔNG đổi: client tạo → client sinh UUID và gửi lên; server
//     DÙNG LUÔN id đó. (Tool/AI tạo → server sinh, KHÔNG đi qua batch này.)
//     Cross-ref định danh bằng cặp (task_id, tag_id) — cả hai đều là id ổn định.
//   • Server là nơi DUY NHẤT quyết Last-Write-Wins, dựa trên `mod_time` do CLIENT
//     gửi (thời điểm sửa thật trên máy) — KHÔNG đè CURRENT_TIMESTAMP.
//   • "Xóa là tối thượng": nếu bản ghi trên server đã `is_deleted=TRUE` thì BỎ QUA
//     mọi push tới (không hồi sinh). Tombstone giữ lại (chấp nhận phình bảng).
//   • LWW dùng so sánh chặt `>`: client chỉ thắng khi mới hơn HẲN; bằng nhau → giữ
//     server (push lại cùng dữ liệu là idempotent).
//   • Ghi đè chéo user bị chặn: mọi thao tác scope theo user_id (ref scope qua task).
//
//  Cross-ref (task_tag) KHÔNG sync như entity riêng: mỗi task mang `tag_ids` (tập
//  tag đang gắn). Server tự đối chiếu trong transaction — tag bỏ thì soft-delete
//  cross-ref, tag thêm thì upsert — dùng chính `mod_time` của task. Nhờ vậy client
//  không cần tombstone cross-ref; khi đổi tag chỉ cần đánh dấu Task dirty.
//
//  Thứ tự xử lý trong MỘT transaction: tags → tasks (kèm đối chiếu cross-ref). Tag
//  phải tồn tại trước khi task gắn nó.
// ════════════════════════════════════════════════════════════════════════════

export const getServerTime = async () => {
  const { rows: [{ server_time }] } = await query('SELECT NOW() AS server_time');
  return server_time;
};

// So sánh LWW: client thắng khi mới hơn HẲN server.
const clientWins = (clientModTime, serverModTime) =>
  new Date(clientModTime).getTime() > new Date(serverModTime).getTime();

const asBool = (v) => v === true || v === 'true' || v === 1;

// ── PULL ────────────────────────────────────────────────────────────────────
// Trả về mọi thay đổi (kể cả tombstone is_deleted=TRUE) sau mốc `since`.
// Mỗi task kèm `tags` (chỉ ref đang active) → client tự dựng lại cross-ref local.
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

// ── PUSH ──────────────────────────────────────────────────────────────────────
export const pushChanges = async (userId, { tasks = [], tags = [] }) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Thứ tự: tags → tasks (task gắn tag nên tag phải có trước; cross-ref đối chiếu
    // ngay trong upsertTask).
    const tagResults  = [];
    for (const item of tags)  tagResults.push(await upsertTag(client, userId, item));

    const taskResults = [];
    for (const item of tasks) taskResults.push(await upsertTask(client, userId, item));

    await client.query('COMMIT');
    return { tagResults, taskResults };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// ── Tag upsert ──────────────────────────────────────────────────────────────
const upsertTag = async (client, userId, item) => {
  const { id } = item;
  if (!id) return { id: null, status: 'skipped', reason: 'Thiếu id (client phải sinh id).' };

  try {
    const found = await client.query(
      'SELECT id, is_deleted, mod_time FROM tags WHERE id=$1 AND user_id=$2',
      [id, userId],
    );
    const existing = found.rows[0];
    const isDelete = asBool(item.is_deleted);

    if (!existing) {
      if (isDelete) return { id, status: 'skipped', reason: 'Xóa bản ghi server chưa có.' };
      const r = await client.query(
        `INSERT INTO tags (id, user_id, name, color_hex, is_deleted, mod_time)
         VALUES ($1, $2, $3, $4, FALSE, $5)
         RETURNING id, name, color_hex, is_deleted, mod_time`,
        [id, userId, item.name, item.color_hex ?? null, item.mod_time],
      );
      return { id, status: 'created', data: r.rows[0] };
    }

    if (existing.is_deleted) return { id, status: 'skipped_deleted' }; // xóa tối thượng
    if (!clientWins(item.mod_time, existing.mod_time)) {
      return { id, status: 'stale', server_mod_time: existing.mod_time };
    }

    if (isDelete) {
      const r = await client.query(
        `UPDATE tags SET is_deleted=TRUE, mod_time=$1 WHERE id=$2 AND user_id=$3
         RETURNING id, is_deleted, mod_time`,
        [item.mod_time, id, userId],
      );
      return { id, status: 'deleted', data: r.rows[0] };
    }
    const r = await client.query(
      `UPDATE tags SET name=$1, color_hex=$2, is_deleted=FALSE, mod_time=$3
       WHERE id=$4 AND user_id=$5
       RETURNING id, name, color_hex, is_deleted, mod_time`,
      [item.name, item.color_hex ?? null, item.mod_time, id, userId],
    );
    return { id, status: 'updated', data: r.rows[0] };
  } catch (err) {
    return { id, status: 'error', error: err.message };
  }
};

// ── Task upsert ───────────────────────────────────────────────────────────────
const upsertTask = async (client, userId, item) => {
  const { id } = item;
  if (!id) return { id: null, status: 'skipped', reason: 'Thiếu id (client phải sinh id).' };

  try {
    const found = await client.query(
      'SELECT id, is_deleted, mod_time FROM tasks WHERE id=$1 AND user_id=$2',
      [id, userId],
    );
    const existing = found.rows[0];
    const isDelete = asBool(item.is_deleted);

    if (!existing) {
      if (isDelete) return { id, status: 'skipped', reason: 'Xóa bản ghi server chưa có.' };
      const r = await insertTaskRow(client, userId, item);
      await reconcileTaskTags(client, userId, id, item.tag_ids, item.mod_time);
      return { id, status: 'created', data: r };
    }

    if (existing.is_deleted) return { id, status: 'skipped_deleted' }; // xóa tối thượng
    if (!clientWins(item.mod_time, existing.mod_time)) {
      return { id, status: 'stale', server_mod_time: existing.mod_time };
    }

    if (isDelete) {
      const r = await client.query(
        `UPDATE tasks SET is_deleted=TRUE, mod_time=$1 WHERE id=$2 AND user_id=$3
         RETURNING id, is_deleted, mod_time`,
        [item.mod_time, id, userId],
      );
      return { id, status: 'deleted', data: r.rows[0] };
    }
    const r = await updateTaskRow(client, userId, item);
    await reconcileTaskTags(client, userId, id, item.tag_ids, item.mod_time);
    return { id, status: 'updated', data: r };
  } catch (err) {
    return { id, status: 'error', error: err.message };
  }
};

// Đối chiếu cross-ref của 1 task theo tập `tagIds` client gửi (dùng mod_time của task):
//   • tag trong tagIds (và thuộc user, chưa xoá) → upsert ref active.
//   • ref đang active mà KHÔNG còn trong tagIds → soft-delete (tombstone server-side).
// `tagIds` undefined → bỏ qua (client không gửi thông tin tag → không đụng ref).
const reconcileTaskTags = async (client, userId, taskId, tagIds, modTime) => {
  if (!Array.isArray(tagIds)) return;

  const valid = tagIds.length > 0
    ? (await client.query(
        'SELECT id FROM tags WHERE id = ANY($1) AND user_id=$2 AND is_deleted=FALSE',
        [tagIds, userId],
      )).rows.map((r) => r.id)
    : [];

  for (const tid of valid) {
    await client.query(
      `INSERT INTO task_tag_cross_ref (task_id, tag_id, is_deleted, mod_time)
       VALUES ($1, $2, FALSE, $3)
       ON CONFLICT (task_id, tag_id) DO UPDATE SET is_deleted=FALSE, mod_time=$3`,
      [taskId, tid, modTime],
    );
  }

  // Gỡ (soft-delete) các ref active không còn trong tập mong muốn.
  await client.query(
    `UPDATE task_tag_cross_ref SET is_deleted=TRUE, mod_time=$1
     WHERE task_id=$2 AND is_deleted=FALSE AND NOT (tag_id = ANY($3::uuid[]))`,
    [modTime, taskId, valid],
  );
};

const insertTaskRow = async (client, userId, item) => {
  const r = await client.query(
    `INSERT INTO tasks AS t
       (id, user_id, title, description, start_time, end_time, task_type,
        source_type, source_id, priority, latitude, longitude, address_name,
        is_completed, is_deleted, mod_time)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10,2),$11,$12,$13,$14,FALSE,$15)
     RETURNING ${TASK_COLUMNS}`,
    [
      item.id, userId, item.title, item.description ?? null,
      item.start_time ?? null, item.end_time ?? null,
      (item.task_type ?? 'TODO').toUpperCase(),
      (item.source_type ?? 'MANUAL').toUpperCase(), item.source_id ?? null,
      sanitizePriority(item.priority), sanitizeLat(item.latitude), sanitizeLng(item.longitude),
      item.address_name ?? null, asBool(item.is_completed), item.mod_time,
    ],
  );
  return r.rows[0];
};

const updateTaskRow = async (client, userId, item) => {
  const r = await client.query(
    `UPDATE tasks AS t SET
       title=$1, description=$2, start_time=$3, end_time=$4, task_type=$5,
       is_completed=$6, source_type=$7, source_id=$8,
       priority=COALESCE($9, priority), latitude=$10, longitude=$11, address_name=$12,
       is_deleted=FALSE, mod_time=$13
     WHERE id=$14 AND user_id=$15
     RETURNING ${TASK_COLUMNS}`,
    [
      item.title, item.description ?? null, item.start_time ?? null, item.end_time ?? null,
      (item.task_type ?? 'TODO').toUpperCase(), asBool(item.is_completed),
      (item.source_type ?? 'MANUAL').toUpperCase(), item.source_id ?? null,
      sanitizePriority(item.priority), sanitizeLat(item.latitude), sanitizeLng(item.longitude),
      item.address_name ?? null, item.mod_time, item.id, userId,
    ],
  );
  return r.rows[0];
};

