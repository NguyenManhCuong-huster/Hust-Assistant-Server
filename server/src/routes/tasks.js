import express from 'express';

import { requireAuth }       from '../middleware/authMiddleware.js';
import { lwwCheck }          from '../middleware/lastWriteWins.js';
import { query, getClient }  from '../config/db.js';

const router = express.Router();
router.use(requireAuth);

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

// Cột trả về cho client — tập trung 1 chỗ để các handler list/detail/sync dùng chung.
const TASK_COLUMNS = `
  t.id, t.title, t.description, t.start_time, t.end_time,
  t.task_type, t.is_completed, t.source_type, t.source_id,
  t.priority, t.latitude, t.longitude, t.address_name,
  t.is_deleted, t.mod_time
`;

const findTask = async (id, userId) => {
  const r = await query(
    'SELECT * FROM tasks WHERE id=$1 AND user_id=$2',
    [id, userId],
  );
  return r.rows[0] ?? null;
};

const attachTags = async (client, taskId, userId, tagIds) => {
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

const fetchTaskWithTags = async (taskId, userId) => {
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
  return r.rows[0];
};

// Validate priority: chấp nhận null/undefined → trả null (server sẽ dùng DEFAULT 2).
// Nếu có giá trị thì phải là số nguyên 1..4, ngược lại throw để route trả 400.
const normalizePriority = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n < 1 || n > 4) {
    const err = new Error('priority phải là số nguyên 1..4 (1=LOW, 2=MEDIUM, 3=HIGH, 4=URGENT).');
    err.statusCode = 400;
    throw err;
  }
  return n;
};

// Validate lat/lng — null/undefined/'' → null. Có giá trị thì phải số trong range.
const normalizeLat = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < -90 || n > 90) {
    const err = new Error('latitude phải nằm trong [-90, 90].');
    err.statusCode = 400;
    throw err;
  }
  return n;
};
const normalizeLng = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < -180 || n > 180) {
    const err = new Error('longitude phải nằm trong [-180, 180].');
    err.statusCode = 400;
    throw err;
  }
  return n;
};

// ─────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────

// GET /api/tasks
// ?type=TODO|CLASS|EXAM  &completed=true|false  &source_type=MANUAL|EMAIL|NEWS|CTT
// &from=ISO  &to=ISO  &sort=start_time|end_time|mod_time  &order=asc|desc
// &page=1  &limit=20  &include_deleted=false
router.get('/', async (req, res, next) => {
  try {
    const {
      type, completed, source_type, from, to,
      sort = 'mod_time', order = 'desc',
      page = 1, limit = 20,
      include_deleted = 'false',
    } = req.query;

    const safeSort  = ['start_time', 'end_time', 'mod_time'].includes(sort) ? sort : 'mod_time';
    const safeOrder = ['asc', 'desc'].includes(order) ? order : 'desc';
    const safePage  = Math.max(1, Number.parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));
    const offset    = (safePage - 1) * safeLimit;

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
        [...params, safeLimit, offset],
      ),
      query(`SELECT COUNT(*) FROM tasks t WHERE ${where}`, params),
    ]);

    const total     = Number.parseInt(countResult.rows[0].count, 10);
    const totalPage = Math.ceil(total / safeLimit);
    res.json({
      success: true,
      data:    tasksResult.rows,
      meta: {
        total,
        page:       safePage,
        limit:      safeLimit,
        total_page: totalPage,
        has_next:   safePage < totalPage,
      },
    });
  } catch (err) { next(err); }
});

// GET /api/tasks/:id
router.get('/:id', async (req, res, next) => {
  try {
    const r = await query(
      `SELECT ${TASK_COLUMNS},
              COALESCE(json_agg(json_build_object('id', tg.id, 'name', tg.name, 'color_hex', tg.color_hex))
                FILTER (WHERE tg.id IS NOT NULL), '[]') AS tags
       FROM tasks t
       LEFT JOIN task_tag_cross_ref ttcr ON ttcr.task_id = t.id AND ttcr.is_deleted = FALSE
       LEFT JOIN tags tg ON tg.id = ttcr.tag_id AND tg.is_deleted = FALSE
       WHERE t.id=$1 AND t.user_id=$2
       GROUP BY t.id`,
      [req.params.id, req.user.id],
    );
    if (!r.rows[0]) return res.status(404).json({ success: false, message: 'Task không tồn tại.' });
    res.json({ success: true, data: r.rows[0] });
  } catch (err) { next(err); }
});

// POST /api/tasks
// Body: { title, description?, start_time?, end_time?, task_type?, source_type?, source_id?,
//         priority?, latitude?, longitude?, address_name?, tag_ids? }
router.post('/', async (req, res, next) => {
  const {
    title,
    description  = null,
    start_time   = null,
    end_time     = null,
    task_type    = 'TODO',
    source_type  = 'MANUAL',
    source_id    = null,
    address_name = null,
    tag_ids      = [],
  } = req.body;

  if (!title?.trim()) {
    return res.status(400).json({ success: false, message: 'title là bắt buộc.' });
  }

  let priority, latitude, longitude;
  try {
    priority  = normalizePriority(req.body.priority);
    latitude  = normalizeLat(req.body.latitude);
    longitude = normalizeLng(req.body.longitude);
  } catch (e) {
    return res.status(e.statusCode ?? 400).json({ success: false, message: e.message });
  }

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
        req.user.id,
        title.trim(),
        description,
        start_time,
        end_time,
        task_type.toUpperCase(),
        source_type.toUpperCase(),
        source_id,
        priority,        // null → server dùng DEFAULT 2 nhờ COALESCE
        latitude,
        longitude,
        address_name,
      ],
    );
    if (tag_ids.length > 0) await attachTags(client, rows[0].id, req.user.id, tag_ids);
    await client.query('COMMIT');
    res.status(201).json({
      success: true,
      data:    await fetchTaskWithTags(rows[0].id, req.user.id),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// PUT /api/tasks/:id  [LWW]
router.put('/:id', lwwCheck('tasks'), async (req, res, next) => {
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
    tag_ids      = [],
  } = req.body;

  if (!title?.trim()) {
    return res.status(400).json({ success: false, message: 'title là bắt buộc.' });
  }

  let priority, latitude, longitude;
  try {
    priority  = normalizePriority(req.body.priority);
    latitude  = normalizeLat(req.body.latitude);
    longitude = normalizeLng(req.body.longitude);
  } catch (e) {
    return res.status(e.statusCode ?? 400).json({ success: false, message: e.message });
  }

  const existing = req.serverRecord ?? await findTask(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ success: false, message: 'Task không tồn tại.' });

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
        title.trim(),
        description,
        start_time,
        end_time,
        task_type.toUpperCase(),
        is_completed,
        source_type.toUpperCase(),
        source_id,
        priority,        // null → giữ priority cũ nhờ COALESCE
        latitude,
        longitude,
        address_name,
        existing.id,
      ],
    );
    await client.query(
      'UPDATE task_tag_cross_ref SET is_deleted=TRUE WHERE task_id=$1',
      [existing.id],
    );
    if (tag_ids.length > 0) await attachTags(client, existing.id, req.user.id, tag_ids);
    await client.query('COMMIT');
    res.json({ success: true, data: await fetchTaskWithTags(existing.id, req.user.id) });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// PATCH /api/tasks/:id  [LWW]  — chỉ gửi field cần thay đổi
router.patch('/:id', lwwCheck('tasks'), async (req, res, next) => {
  const ALLOWED = [
    'title', 'description', 'start_time', 'end_time',
    'task_type', 'is_completed', 'source_type', 'source_id',
    'priority', 'latitude', 'longitude', 'address_name',
  ];
  const existing = req.serverRecord ?? await findTask(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ success: false, message: 'Task không tồn tại.' });

  const setClauses = [];
  const params     = [];
  let   idx        = 1;

  try {
    for (const f of ALLOWED) {
      if (!(f in req.body)) continue;
      let val = req.body[f];
      if (f === 'task_type' || f === 'source_type') val = val?.toUpperCase();
      if (f === 'priority')  val = normalizePriority(val);
      if (f === 'latitude')  val = normalizeLat(val);
      if (f === 'longitude') val = normalizeLng(val);
      setClauses.push(`${f}=$${idx++}`);
      params.push(val);
    }
  } catch (e) {
    return res.status(e.statusCode ?? 400).json({ success: false, message: e.message });
  }

  if (setClauses.length === 0 && !('tag_ids' in req.body)) {
    return res.status(400).json({ success: false, message: 'Không có field nào được cập nhật.' });
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');
    if (setClauses.length > 0) {
      setClauses.push('mod_time=CURRENT_TIMESTAMP');
      await client.query(
        `UPDATE tasks SET ${setClauses.join(',')} WHERE id=$${idx}`,
        [...params, existing.id],
      );
    }
    if ('tag_ids' in req.body) {
      await client.query(
        'UPDATE task_tag_cross_ref SET is_deleted=TRUE WHERE task_id=$1',
        [existing.id],
      );
      if (req.body.tag_ids.length > 0) {
        await attachTags(client, existing.id, req.user.id, req.body.tag_ids);
      }
    }
    await client.query('COMMIT');
    res.json({ success: true, data: await fetchTaskWithTags(existing.id, req.user.id) });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// DELETE /api/tasks/:id  [LWW]  — soft delete
router.delete('/:id', lwwCheck('tasks'), async (req, res, next) => {
  try {
    const existing = req.serverRecord ?? await findTask(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ success: false, message: 'Task không tồn tại.' });
    const r = await query(
      `UPDATE tasks SET is_deleted=TRUE, mod_time=CURRENT_TIMESTAMP
       WHERE id=$1 RETURNING id, is_deleted, mod_time`,
      [existing.id],
    );
    res.json({ success: true, data: r.rows[0] });
  } catch (err) { next(err); }
});

export default router;
