import { query } from '../shared/database/db.js';

export const listAccounts = async (userId) => {
  const result = await query(
    `SELECT a.id, a.provider, a.username_or_email, a.status, a.created_at, uac.linked_at
     FROM accounts a
     JOIN user_account_cross_ref uac ON uac.account_id = a.id
     WHERE uac.user_id = $1
     ORDER BY uac.linked_at DESC`,
    [userId],
  );
  return result.rows;
};

export const checkOwnership = async (userId, accountId) => {
  const check = await query(
    'SELECT 1 FROM user_account_cross_ref WHERE user_id=$1 AND account_id=$2',
    [userId, accountId],
  );
  return !!check.rows[0];
};

export const unlinkAccount = async (userId, accountId) => {
  await query(
    'DELETE FROM user_account_cross_ref WHERE user_id=$1 AND account_id=$2',
    [userId, accountId],
  );
};
