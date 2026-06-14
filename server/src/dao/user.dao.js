import { query } from '../shared/database/db.js';

const RETURN_COLUMNS = `
  user_id, student_id, full_name, date_of_birth, phone,
  school, major, class_name, course, created_at, mod_time
`;

export const getUserInfo = async (userId) => {
  const r = await query(`SELECT ${RETURN_COLUMNS} FROM user_info WHERE user_id=$1`, [userId]);
  return r.rows[0] ?? null;
};

export const checkExists = async (userId) => {
  const r = await query('SELECT user_id FROM user_info WHERE user_id=$1', [userId]);
  return !!r.rows[0];
};

export const insertUserInfo = async (userId, data) => {
  const r = await query(
    `INSERT INTO user_info (user_id, student_id, full_name, date_of_birth, phone, school, major, class_name, course)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${RETURN_COLUMNS}`,
    [userId, data.student_id, data.full_name ?? null, data.date_of_birth ?? null,
     data.phone ?? null, data.school ?? null, data.major ?? null, data.class_name ?? null, data.course ?? null],
  );
  return r.rows[0];
};

export const upsertUserInfo = async (userId, data) => {
  const r = await query(
    `INSERT INTO user_info (user_id, student_id, full_name, date_of_birth, phone, school, major, class_name, course)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (user_id) DO UPDATE SET
       student_id=EXCLUDED.student_id, full_name=EXCLUDED.full_name, date_of_birth=EXCLUDED.date_of_birth,
       phone=EXCLUDED.phone, school=EXCLUDED.school, major=EXCLUDED.major,
       class_name=EXCLUDED.class_name, course=EXCLUDED.course, mod_time=CURRENT_TIMESTAMP
     RETURNING ${RETURN_COLUMNS}`,
    [userId, data.student_id, data.full_name ?? null, data.date_of_birth ?? null,
     data.phone ?? null, data.school ?? null, data.major ?? null, data.class_name ?? null, data.course ?? null],
  );
  return r.rows[0];
};

export const patchUserInfo = async (userId, keys, values) => {
  const setClauses = [...keys.map((k, i) => `${k}=$${i + 1}`), 'mod_time=CURRENT_TIMESTAMP'];
  const r = await query(
    `UPDATE user_info SET ${setClauses.join(',')} WHERE user_id=$${keys.length + 1} RETURNING ${RETURN_COLUMNS}`,
    [...values, userId],
  );
  return r.rows[0];
};

export const getUserProfile = async (userId) => {
  const r = await query(
    `SELECT u.email, ui.student_id, ui.full_name, ui.school, ui.major, ui.class_name, ui.course
     FROM users u
     LEFT JOIN user_info ui ON ui.user_id = u.id
     WHERE u.id = $1`,
    [userId],
  );
  const row = r.rows[0];
  if (!row) return { userEmail: null, userInfo: null };
  const hasProfile = Boolean(row.student_id || row.full_name || row.school || row.major || row.class_name || row.course);
  return {
    userEmail: row.email ?? null,
    userInfo: hasProfile ? {
      student_id: row.student_id, full_name: row.full_name, school: row.school,
      major: row.major, class_name: row.class_name, course: row.course,
    } : null,
  };
};

export const deleteUserInfo = async (userId) => {
  const r = await query('DELETE FROM user_info WHERE user_id=$1 RETURNING user_id', [userId]);
  return r.rows[0] ?? null;
};
