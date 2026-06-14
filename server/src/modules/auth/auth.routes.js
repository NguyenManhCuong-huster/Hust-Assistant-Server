import express from 'express';
import passport    from '../../infrastructure/passport.js';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import * as ctrl       from './auth.controller.js';

const router = express.Router();

router.get('/google',
  passport.authenticate('google-login', {
    scope:  ['profile', 'email'],
    prompt: 'select_account',
  }),
);

router.get('/google/callback',
  passport.authenticate('google-login', {
    session:         false,
    failureRedirect: `${process.env.FRONTEND_URL}/login?error=oauth_failed`,
  }),
  ctrl.googleCallback,
);

router.get('/me',          requireAuth, ctrl.getMe);
router.post('/logout',     requireAuth, ctrl.logout);
router.post('/google/mobile', ctrl.googleMobileLogin);

export default router;
