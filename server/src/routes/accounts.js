import express from 'express';

import passport                     from '../config/passport.js';
import { requireAuth }              from '../middleware/authMiddleware.js';
import { query }                    from '../config/db.js';
import { createCode, consumeCode }  from '../config/linkCodeStore.js';

const router = express.Router();

// POST /api/accounts/link/init  [JWT]
router.post('/link/init', requireAuth, (req, res) => {
  const { provider } = req.body;
  if (!provider || !['google', 'outlook'].includes(provider.toLowerCase())) {
    return res.status(400).json({
      success: false,
      message: 'provider phải là google hoặc outlook.',
    });
  }
  const code       = createCode(req.user.id);
  const serverUrl  = process.env.SERVER_URL ?? 'http://localhost:3000';
  res.json({
    success:      true,
    link_code:    code,
    expires_in:   300,
    redirect_url: `${serverUrl}/api/accounts/link/${provider.toLowerCase()}?code=${code}`,
  });
});

// GET /api/accounts/link/google  [link_code via ?code=]
router.get('/link/google', (req, res, next) => {
  const userId = consumeCode(req.query.code);
  if (!userId) return res.status(400).send('<h3>Link code không hợp lệ hoặc đã hết hạn.</h3>');
  req.session.linkUserId = userId;
  passport.authenticate('google-account', {
    scope: [
      'profile',
      'email',
      'https://www.googleapis.com/auth/gmail.readonly',
    ],
    accessType: 'offline',   // ← THÊM: cấp refresh_token
    prompt:     'consent',   // ← ĐỔI từ 'select_account': force consent → refresh_token
    session:    true,
  })(req, res, next);
});

// GET /api/accounts/link/google/callback  [session]
router.get('/link/google/callback',
  passport.authenticate('google-account', {
    session:         false,
    failureRedirect: `${process.env.FRONTEND_URL}/settings/accounts?error=link_failed&provider=google`,
  }),
  (req, res) => {
    res.redirect(
      `${process.env.FRONTEND_URL}/settings/accounts?linked=${req.user.provider}&email=${encodeURIComponent(req.user.email)}`,
    );
  },
);

// GET /api/accounts/link/outlook  [link_code via ?code=]
router.get('/link/outlook', (req, res, next) => {
  const userId = consumeCode(req.query.code);
  if (!userId) return res.status(400).send('<h3>Link code không hợp lệ hoặc đã hết hạn.</h3>');
  req.session.linkUserId = userId;
  passport.authenticate('microsoft-account', { session: true })(req, res, next);
});

router.get('/link/outlook/callback',
  passport.authenticate('microsoft-account', {
    session:         false,
    failureRedirect: `${process.env.FRONTEND_URL}/settings/accounts?error=link_failed&provider=outlook`,
  }),
  (req, res) => {
    res.redirect(
      `${process.env.FRONTEND_URL}/settings/accounts?linked=${req.user.provider}&email=${encodeURIComponent(req.user.email)}`,
    );
  },
);

// GET /api/accounts  [JWT]
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT a.id, a.provider, a.username_or_email, a.status, a.created_at, uac.linked_at
       FROM accounts a
       JOIN user_account_cross_ref uac ON uac.account_id = a.id
       WHERE uac.user_id = $1
       ORDER BY uac.linked_at DESC`,
      [req.user.id],
    );
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
});

// DELETE /api/accounts/:accountId  [JWT]
router.delete('/:accountId', requireAuth, async (req, res, next) => {
  try {
    const check = await query(
      'SELECT 1 FROM user_account_cross_ref WHERE user_id=$1 AND account_id=$2',
      [req.user.id, req.params.accountId],
    );
    if (!check.rows[0]) {
      return res.status(404).json({
        success: false,
        message: 'Account không tồn tại hoặc không thuộc về bạn.',
      });
    }
    await query(
      'DELETE FROM user_account_cross_ref WHERE user_id=$1 AND account_id=$2',
      [req.user.id, req.params.accountId],
    );
    res.json({ success: true, message: 'Đã ngắt liên kết tài khoản.' });
  } catch (err) { next(err); }
});

export default router;
