import { query } from '../shared/database/db.js';

const RETURN_COLUMNS = `
  id, semester, course_code, course_name, course_name_en,
  credits, letter_grade, is_deleted, mod_time
`;

export const listGrades = async (userId, includeDeleted = false) => {
  const extra = includeDeleted ? '' : 'AND is_deleted=FALSE';
  const r = await query(
    `SELECT ${RETURN_COLUMNS} FROM grades WHERE user_id=$1 ${extra} ORDER BY semester ASC, course_code ASC`,
    [userId],
  );
  return r.rows;
};

export const findGrade = async (id, userId) => {
  const r = await query('SELECT id FROM grades WHERE id=$1 AND user_id=$2', [id, userId]);
  return r.rows[0] ?? null;
};

// POST upsert theo id, có LWW + "xóa tối thượng" (giống Task/Tag, nhưng qua REST).
//   • `id` từ CLIENT + đã tồn tại:
//       - server.is_deleted=TRUE  → BỎ QUA (không hồi sinh), trả bản hiện tại.
//       - client.mod_time > server.mod_time → UPDATE, lưu ĐÚNG mod_time client.
//       - ngược lại (server mới hơn/bằng) → giữ server, trả bản hiện tại (stale).
//   • `id`=null (TOOL/AI) hoặc chưa tồn tại → INSERT (mod_time client nếu có, không thì giờ server).
// Guard `user_id` chặn ghi chéo user.
export const insertGrade = async (userId, { id = null, mod_time = null, semester, course_code, course_name, course_name_en, credits, letter_grade }) => {
  if (id) {
    const found = await query(
      'SELECT id, is_deleted, mod_time FROM grades WHERE id=$1 AND user_id=$2',
      [id, userId],
    );
    const ex = found.rows[0];
    if (ex) {
      const fresh = await query(`SELECT ${RETURN_COLUMNS} FROM grades WHERE id=$1`, [id]);
      if (ex.is_deleted) return fresh.rows[0];                                   // xóa tối thượng
      if (!(mod_time && new Date(mod_time) > new Date(ex.mod_time))) {
        return fresh.rows[0];                                                    // server mới hơn/bằng → stale
      }
      const upd = await query(
        `UPDATE grades SET
           semester=$1, course_code=$2, course_name=$3, course_name_en=$4,
           credits=$5, letter_grade=$6, is_deleted=FALSE, mod_time=$7
         WHERE id=$8 AND user_id=$9 RETURNING ${RETURN_COLUMNS}`,
        [semester, course_code, course_name, course_name_en ?? null, credits ?? 0, letter_grade ?? null, mod_time, id, userId],
      );
      return upd.rows[0];
    }
  }
  const r = await query(
    `INSERT INTO grades (id, user_id, semester, course_code, course_name, course_name_en, credits, letter_grade, mod_time)
     VALUES (COALESCE($1::uuid, uuid_generate_v4()), $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, CURRENT_TIMESTAMP))
     RETURNING ${RETURN_COLUMNS}`,
    [id, userId, semester, course_code, course_name, course_name_en ?? null, credits ?? 0, letter_grade ?? null, mod_time],
  );
  return r.rows[0];
};

// PUT — lưu ĐÚNG mod_time client (không CURRENT_TIMESTAMP). LWW server-newer đã được
// chặn ở lww.middleware (header x-client-mod-time); "xóa tối thượng" check ở controller.
export const updateGrade = async (id, { mod_time = null, semester, course_code, course_name, course_name_en, credits, letter_grade }) => {
  const r = await query(
    `UPDATE grades SET
       semester=$1, course_code=$2, course_name=$3, course_name_en=$4,
       credits=$5, letter_grade=$6,
       is_deleted=FALSE, mod_time=COALESCE($7::timestamptz, CURRENT_TIMESTAMP)
     WHERE id=$8 RETURNING ${RETURN_COLUMNS}`,
    [semester, course_code, course_name, course_name_en ?? null, credits ?? 0, letter_grade ?? null, mod_time, id],
  );
  return r.rows[0];
};

export const softDeleteGrade = async (id, modTime = null) => {
  const r = await query(
    `UPDATE grades SET is_deleted=TRUE, mod_time=COALESCE($2::timestamptz, CURRENT_TIMESTAMP)
     WHERE id=$1 RETURNING id, is_deleted, mod_time`,
    [id, modTime],
  );
  return r.rows[0];
};
