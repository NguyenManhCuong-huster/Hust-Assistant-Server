import express from 'express';
import passport    from '../../infrastructure/passport.js';
import { requireAuth }    from '../../shared/middleware/auth.middleware.js';
import { createCode, consumeCode } from '../../infrastructure/link-code-store.js';
import * as ctrl from './accounts.controller.js';

const router = express.Router();

router.post('/link/init', requireAuth, (req, res) => {
  const { provider } = req.body;
  if (!provider || !['google', 'outlook'].includes(provider.toLowerCase())) {
    return res.status(400).json({ success: false, message: 'provider phải là google hoặc outlook.' });
  }
  const code      = createCode(req.user.id);
  const serverUrl = process.env.SERVER_URL ?? 'http://localhost:3000';
  res.json({
    success:      true,
    link_code:    code,
    expires_in:   300,
    redirect_url: `${serverUrl}/api/accounts/link/${provider.toLowerCase()}?code=${code}`,
  });
});

router.get('/link/google', (req, res, next) => {
  const userId = consumeCode(req.query.code);
  if (!userId) return res.status(400).send('<h3>Link code không hợp lệ hoặc đã hết hạn.</h3>');
  req.session.linkUserId = userId;
  passport.authenticate('google-account', {
    scope:      ['profile', 'email', 'https://www.googleapis.com/auth/gmail.readonly'],
    accessType: 'offline',
    prompt:     'consent',
    session:    true,
  })(req, res, next);
});

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

router.get('/',              requireAuth, ctrl.listAccounts);
router.delete('/:accountId', requireAuth, ctrl.unlinkAccount);

export default router;
