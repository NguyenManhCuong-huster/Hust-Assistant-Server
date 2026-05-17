import express from 'express';
import jwt     from 'jsonwebtoken';

import passport           from '../config/passport.js';
import { requireAuth }    from '../middleware/authMiddleware.js';
import { OAuth2Client } from 'google-auth-library';
import { query, getClient } from '../config/db.js';

const googleOAuthClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const router = express.Router();

const generateToken = (userId) =>
  jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  });

// GET /api/auth/google — bắt đầu đăng nhập
router.get('/google',
  passport.authenticate('google-login', {
    scope:  ['profile', 'email'],
    prompt: 'select_account',
  }),
);

// GET /api/auth/google/callback
router.get('/google/callback',
  passport.authenticate('google-login', {
    session:         false,
    failureRedirect: `${process.env.FRONTEND_URL}/login?error=oauth_failed`,
  }),
  (req, res) => {
    res.redirect(`${process.env.FRONTEND_URL}/auth/callback?token=${generateToken(req.user.id)}`);
  },
);

// GET /api/auth/me  [JWT]
router.get('/me', requireAuth, (req, res) => {
  res.json({
    success: true,
    data: {
      id:         req.user.id,
      email:      req.user.email,
      created_at: req.user.created_at,
    },
  });
});

// POST /api/auth/logout  [JWT]
router.post('/logout', requireAuth, (_req, res) => {
  res.json({ success: true, message: 'Đăng xuất thành công.' });
});

// POST /api/auth/google/mobile  — dành riêng cho Android
router.post('/google/mobile', async (req, res, next) => {
  try {
    const { id_token, server_auth_code } = req.body;
    if (!id_token) {
      return res.status(400).json({ success: false, message: 'id_token is required.' });
    }

    // 1. Verify ID token
    let payload;
    try {
      const ticket = await googleOAuthClient.verifyIdToken({
        idToken:  id_token,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
    } catch {
      return res.status(401).json({ success: false, message: 'Invalid Google ID token.' });
    }

    const email = payload?.email;
    if (!email) {
      return res.status(400).json({ success: false, message: 'ID token has no email.' });
    }

    // 2. Upsert user
    const result = await query(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'GOOGLE_OAUTH')
       ON CONFLICT (email) DO UPDATE SET is_deleted = FALSE
       RETURNING id, email, created_at`,
      [email],
    );
    const user  = result.rows[0];
    const token = generateToken(user.id);

    // 3. Nếu có server_auth_code → tự động link Gmail
    if (server_auth_code) {
      try {
        // Exchange auth code → access_token + refresh_token
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method:  'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body:    new URLSearchParams({
            code:          server_auth_code,
            client_id:     process.env.GOOGLE_CLIENT_ID,
            client_secret: process.env.GOOGLE_CLIENT_SECRET,
            redirect_uri:  '',   // server-side exchange không cần redirect_uri
            grant_type:    'authorization_code',
          }),
        });

        if (tokenRes.ok) {
          const tokens    = await tokenRes.json();
          const { encrypt } = await import('../config/crypto.js');
          const tokenBlob = encrypt(JSON.stringify({
            access_token:  tokens.access_token,
            refresh_token: tokens.refresh_token ?? null,
          }));

          // Upsert account + link to user
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
              [user.id, rows[0].id],
            );
            await client.query('COMMIT');
          } catch (linkErr) {
            await client.query('ROLLBACK');
            console.warn('[Auth] Gmail auto-link failed:', linkErr.message);
          } finally {
            client.release();
          }
        }
      } catch (exchErr) {
        // Không block login nếu link Gmail lỗi
        console.warn('[Auth] Token exchange failed:', exchErr.message);
      }
    }

    return res.json({
      success: true,
      data: { token, user: { id: user.id, email: user.email, created_at: user.created_at } },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
