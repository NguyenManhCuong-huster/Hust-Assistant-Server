import * as svc from './grades.service.js';

export const listGrades = async (req, res, next) => {
  try {
    const rows = await svc.listGrades(req.user.id, req.query.include_deleted === 'true');
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

export const createGrade = async (req, res, next) => {
  try {
    const grade = await svc.createGrade(req.user.id, req.body);
    res.status(201).json({ success: true, data: grade });
  } catch (err) { next(err); }
};

export const replaceGrade = async (req, res, next) => {
  try {
    const existing = req.serverRecord ?? await svc.findGrade(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ success: false, message: 'Grade không tồn tại.' });
    // Xóa tối thượng: bản trên server đã xoá → không hồi sinh, trả về nguyên trạng.
    if (existing.is_deleted) return res.json({ success: true, data: existing });
    const grade = await svc.replaceGrade(existing.id, req.body);
    res.json({ success: true, data: grade });
  } catch (err) { next(err); }
};

export const deleteGrade = async (req, res, next) => {
  try {
    const existing = req.serverRecord ?? await svc.findGrade(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ success: false, message: 'Grade không tồn tại.' });
    const clientModTime = req.headers['x-client-mod-time'] ?? null;
    res.json({ success: true, data: await svc.softDeleteGrade(existing.id, clientModTime) });
  } catch (err) { next(err); }
};
