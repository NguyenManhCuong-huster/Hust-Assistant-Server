import { query, getClient } from '../shared/database/db.js';
import { encrypt } from '../infrastructure/crypto.js';

export const upsertUser = async (email) => {
  const result = await query(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'GOOGLE_OAUTH')
     ON CONFLICT (email) DO UPDATE SET is_deleted = FALSE
     RETURNING id, email, created_at`,
    [email],
  );
  return result.rows[0];
};

export const linkGmailAccount = async (userId, email, tokens) => {
  const tokenBlob = encrypt(JSON.stringify({
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token ?? null,
  }));

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO accounts (provider, username_or_email, access_token, status)
       VALUES ('GMAIL', $1, $2, 'ACTIVE')
       ON CONFLICT (provider, username_or_email)
         DO UPDATE SET access_token = EXCLUDED.access_token, status = 'ACTIVE'
       RETURNING id`,
      [email, tokenBlob],
    );
    await client.query(
      `INSERT INTO user_account_cross_ref (user_id, account_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [userId, rows[0].id],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};
