import * as svc from './user.service.js';

export const getInfo = async (req, res, next) => {
  try {
    const row = await svc.getUserInfo(req.user.id);
    if (!row) return res.status(404).json({ success: false, message: 'No student profile found. Use POST /api/user-info to create one.' });
    res.json({ success: true, data: row });
  } catch (err) { next(err); }
};

export const createInfo = async (req, res, next) => {
  try {
    const row = await svc.createUserInfo(req.user.id, req.body);
    res.status(201).json({ success: true, data: row });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: 'A student profile already exists. Use PUT or PATCH to update it.' });
    next(err);
  }
};

export const upsertInfo = async (req, res, next) => {
  try {
    const row = await svc.upsertUserInfo(req.user.id, req.body);
    res.json({ success: true, data: row });
  } catch (err) { next(err); }
};

export const patchInfo = async (req, res, next) => {
  try {
    const exists = await svc.checkExists(req.user.id);
    if (!exists) return res.status(404).json({ success: false, message: 'No student profile found. Use POST to create one first.' });
    const row = await svc.patchUserInfo(req.user.id, req.body);
    res.json({ success: true, data: row });
  } catch (err) { next(err); }
};

export const deleteInfo = async (req, res, next) => {
  try {
    const row = await svc.deleteUserInfo(req.user.id);
    if (!row) return res.status(404).json({ success: false, message: 'No student profile found to delete.' });
    res.json({ success: true, message: 'Student profile deleted.' });
  } catch (err) { next(err); }
};
