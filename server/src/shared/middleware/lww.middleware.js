import { query } from '../database/db.js';

export const lwwCheck = (table) => async (req, res, next) => {
  const clientModTime = req.headers['x-client-mod-time'] ?? req.body?.mod_time;
  if (!clientModTime) return next();

  try {
    const result = await query(
      `SELECT * FROM ${table} WHERE id=$1 AND user_id=$2`,
      [req.params.id, req.user.id],
    );
    if (!result.rows[0]) return next();

    const serverRecord  = result.rows[0];
    const clientModDate = new Date(clientModTime);

    if (Number.isNaN(clientModDate.getTime())) {
      return res.status(400).json({
        success: false,
        message: 'mod_time không hợp lệ. Dùng ISO 8601.',
      });
    }

    if (new Date(serverRecord.mod_time) > clientModDate) {
      return res.status(409).json({
        success:       false,
        code:          'CONFLICT_LWW',
        message:       'Dữ liệu trên server mới hơn. Client cần sync trước khi ghi.',
        server_record: serverRecord,
      });
    }

    req.serverRecord = serverRecord;
    next();
  } catch (err) {
    next(err);
  }
};
