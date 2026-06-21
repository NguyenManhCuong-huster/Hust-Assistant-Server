import { normalizeCredits, normalizeLetter } from '../../shared/utils/validators.js';
import * as repo from '../../dao/grades.dao.js';

export const listGrades    = (userId, includeDeleted) => repo.listGrades(userId, includeDeleted);
export const findGrade     = (id, userId)              => repo.findGrade(id, userId);
export const softDeleteGrade = (id, modTime = null)    => repo.softDeleteGrade(id, modTime);

const normalizeFields = ({ semester, course_code, course_name, course_name_en = null, ...rest }) => ({
  semester:       semester.toString().trim(),
  course_code:    course_code.toString().trim().toUpperCase(),
  course_name:    course_name.toString().trim(),
  course_name_en: course_name_en?.toString().trim() || null,
  credits:        normalizeCredits(rest.credits),
  letter_grade:   normalizeLetter(rest.letter_grade),
});

const modTimeOf = (fields) => fields.mod_time?.toString().trim() || null;

export const createGrade  = (userId, fields) =>
  repo.insertGrade(userId, {
    id: fields.id?.toString().trim() || null,
    mod_time: modTimeOf(fields),
    ...normalizeFields(fields),
  });
export const replaceGrade = (id, fields) =>
  repo.updateGrade(id, { mod_time: modTimeOf(fields), ...normalizeFields(fields) });
