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

export const insertGrade = async (userId, { semester, course_code, course_name, course_name_en, credits, letter_grade }) => {
  const r = await query(
    `INSERT INTO grades (user_id, semester, course_code, course_name, course_name_en, credits, letter_grade)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${RETURN_COLUMNS}`,
    [userId, semester, course_code, course_name, course_name_en ?? null, credits ?? 0, letter_grade ?? null],
  );
  return r.rows[0];
};

export const updateGrade = async (id, { semester, course_code, course_name, course_name_en, credits, letter_grade }) => {
  const r = await query(
    `UPDATE grades SET
       semester=$1, course_code=$2, course_name=$3, course_name_en=$4,
       credits=$5, letter_grade=$6,
       is_deleted=FALSE, mod_time=CURRENT_TIMESTAMP
     WHERE id=$7 RETURNING ${RETURN_COLUMNS}`,
    [semester, course_code, course_name, course_name_en ?? null, credits ?? 0, letter_grade ?? null, id],
  );
  return r.rows[0];
};

export const softDeleteGrade = async (id) => {
  const r = await query(
    `UPDATE grades SET is_deleted=TRUE, mod_time=CURRENT_TIMESTAMP
     WHERE id=$1 RETURNING id, is_deleted, mod_time`,
    [id],
  );
  return r.rows[0];
};
