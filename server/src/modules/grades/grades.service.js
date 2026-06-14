import { normalizeCredits, normalizeLetter } from '../../shared/utils/validators.js';
import * as repo from '../../dao/grades.dao.js';

export const listGrades    = (userId, includeDeleted) => repo.listGrades(userId, includeDeleted);
export const findGrade     = (id, userId)              => repo.findGrade(id, userId);
export const softDeleteGrade = (id)                    => repo.softDeleteGrade(id);

const normalizeFields = ({ semester, course_code, course_name, course_name_en = null, ...rest }) => ({
  semester:       semester.toString().trim(),
  course_code:    course_code.toString().trim().toUpperCase(),
  course_name:    course_name.toString().trim(),
  course_name_en: course_name_en?.toString().trim() || null,
  credits:        normalizeCredits(rest.credits),
  letter_grade:   normalizeLetter(rest.letter_grade),
});

export const createGrade  = (userId, fields) => repo.insertGrade(userId, normalizeFields(fields));
export const replaceGrade = (id, fields)     => repo.updateGrade(id, normalizeFields(fields));
