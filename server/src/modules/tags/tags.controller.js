import * as svc from './tags.service.js';

export const listTags = async (req, res, next) => {
  try {
    const rows = await svc.listTags(req.user.id, req.query.include_deleted === 'true');
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

export const createTag = async (req, res, next) => {
  try {
    const tag = await svc.createTag(req.user.id, req.body.name, req.body.color_hex ?? null);
    res.status(201).json({ success: true, data: tag });
  } catch (err) { next(err); }
};

export const updateTag = async (req, res, next) => {
  try {
    const existing = req.serverRecord ?? await svc.findTag(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ success: false, message: 'Tag không tồn tại.' });
    const tag = await svc.updateTag(existing.id, req.body);
    res.json({ success: true, data: tag });
  } catch (err) { next(err); }
};

export const deleteTag = async (req, res, next) => {
  try {
    const existing = req.serverRecord ?? await svc.findTag(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ success: false, message: 'Tag không tồn tại.' });
    res.json({ success: true, data: await svc.softDeleteTag(existing.id) });
  } catch (err) { next(err); }
};
