import { AppError } from './AppError.js';

// ── Task fields ──────────────────────────────────────────────────────────────

export const normalizePriority = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n < 1 || n > 4) {
    throw new AppError('priority phải là số nguyên 1..4 (1=LOW, 2=MEDIUM, 3=HIGH, 4=URGENT).', 400);
  }
  return n;
};

export const normalizeLat = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < -90 || n > 90) {
    throw new AppError('latitude phải nằm trong [-90, 90].', 400);
  }
  return n;
};

export const normalizeLng = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < -180 || n > 180) {
    throw new AppError('longitude phải nằm trong [-180, 180].', 400);
  }
  return n;
};

// ── Grade fields ─────────────────────────────────────────────────────────────

const VALID_LETTERS = ['A+', 'A', 'B+', 'B', 'C+', 'C', 'D+', 'D', 'F'];

export const normalizeLetter = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const up = String(v).trim().toUpperCase();
  return VALID_LETTERS.includes(up) ? up : null;
};

export const normalizeCredits = (v) => {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n < 0 || n > 30) {
    throw new AppError('credits phải là số nguyên 0..30.', 400);
  }
  return n;
};

// ── Tag fields ───────────────────────────────────────────────────────────────

export const isValidColorHex = (v) => /^#[0-9A-Fa-f]{6}$/.test(v);

// ── Batch-safe sanitizers (trả null thay vì throw — dùng trong sync) ─────────

export const sanitizePriority = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n >= 1 && n <= 4 ? n : null;
};

export const sanitizeLat = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= -90 && n <= 90 ? n : null;
};

export const sanitizeLng = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= -180 && n <= 180 ? n : null;
};
