import { parsePagination, buildPageMeta } from '../../shared/utils/paginate.js';
import * as repo from '../../dao/emails.dao.js';
import * as att  from '../attachments/attachments.service.js';
import { syncEmailsForUser } from './emails.service.js';

export const listEmails = async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 50 });
    const built = repo.buildWhere(req.user.id, req.query, 2);
    const [dataRes, countRes] = await repo.listThreaded(built, limit, offset);
    await att.attachToRows(att.OWNER_EMAIL, dataRes.rows);
    const total = Number.parseInt(countRes.rows[0].count, 10);
    res.json({ success: true, data: dataRes.rows, meta: buildPageMeta(total, page, limit) });
  } catch (err) { next(err); }
};

export const listEmailsFlat = async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 200, maxLimit: 500 });
    const built = repo.buildWhere(req.user.id, req.query, 2);
    const [dataRes, countRes] = await repo.listFlat(built, limit, offset);
    await att.attachToRows(att.OWNER_EMAIL, dataRes.rows);
    const total = Number.parseInt(countRes.rows[0].count, 10);
    res.json({ success: true, data: dataRes.rows, meta: buildPageMeta(total, page, limit) });
  } catch (err) { next(err); }
};

export const getEmailThread = async (req, res, next) => {
  try {
    const anchor = await repo.getEmailAnchor(req.params.id, req.user.id);
    if (!anchor) return res.status(404).json({ success: false, message: 'Email not found.' });
    const rows = await repo.getThread(anchor, req.user.id);
    await att.attachToRows(att.OWNER_EMAIL, rows);
    res.json({
      success: true,
      data: { thread_id: anchor.gmail_thread_id ?? anchor.gmail_message_id, messages: rows },
    });
  } catch (err) { next(err); }
};

export const getEmail = async (req, res, next) => {
  try {
    const row = await repo.getEmailById(req.params.id, req.user.id);
    if (!row) return res.status(404).json({ success: false, message: 'Email not found.' });
    row.attachments = await att.listForOwner(att.OWNER_EMAIL, row.id);
    res.json({ success: true, data: row });
  } catch (err) { next(err); }
};

export const getEmailAttachments = async (req, res, next) => {
  try {
    const ok = await repo.checkEmailAccess(req.params.id, req.user.id);
    if (!ok) return res.status(404).json({ success: false, message: 'Email không tồn tại hoặc không có quyền.' });
    const rows = await att.listForOwner(att.OWNER_EMAIL, req.params.id);
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

export const deleteEmail = async (req, res, next) => {
  try {
    const ok = await repo.checkEmailAccess(req.params.id, req.user.id);
    if (!ok) return res.status(404).json({ success: false, message: 'Email not found.' });
    const row = await repo.softDeleteEmail(req.params.id);
    res.json({ success: true, data: row });
  } catch (err) { next(err); }
};

export const syncEmails = async (req, res, next) => {
  try {
    const { account_id } = req.body;
    if (account_id) {
      const ok = await repo.checkAccountAccess(req.user.id, account_id);
      if (!ok) return res.status(403).json({ success: false, message: 'Account not found or does not belong to you.' });
    }
    const result = await syncEmailsForUser(req.user.id);
    const total  = result.accounts?.reduce((s, a) => s + (a.new_emails ?? 0), 0) ?? 0;
    res.json({ success: true, message: `Sync complete. ${total} new email(s) fetched.`, data: result });
  } catch (err) { next(err); }
};
