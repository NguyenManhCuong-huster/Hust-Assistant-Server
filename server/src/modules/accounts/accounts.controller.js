import * as repo from '../../dao/accounts.dao.js';

export const listAccounts = async (req, res, next) => {
  try {
    const rows = await repo.listAccounts(req.user.id);
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

export const unlinkAccount = async (req, res, next) => {
  try {
    const owned = await repo.checkOwnership(req.user.id, req.params.accountId);
    if (!owned) {
      return res.status(404).json({
        success: false,
        message: 'Account không tồn tại hoặc không thuộc về bạn.',
      });
    }
    await repo.unlinkAccount(req.user.id, req.params.accountId);
    res.json({ success: true, message: 'Đã ngắt liên kết tài khoản.' });
  } catch (err) { next(err); }
};
