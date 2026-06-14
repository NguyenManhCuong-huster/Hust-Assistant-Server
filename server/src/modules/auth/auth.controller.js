import * as svc from './auth.service.js';

export const googleCallback = (req, res) => {
  res.redirect(`${process.env.FRONTEND_URL}/auth/callback?token=${svc.generateToken(req.user.id)}`);
};

export const getMe = (req, res) => {
  res.json({
    success: true,
    data: {
      id:         req.user.id,
      email:      req.user.email,
      created_at: req.user.created_at,
    },
  });
};

export const logout = (_req, res) => {
  res.json({ success: true, message: 'Đăng xuất thành công.' });
};

export const googleMobileLogin = async (req, res, next) => {
  try {
    const { id_token, server_auth_code } = req.body;
    if (!id_token) {
      return res.status(400).json({ success: false, message: 'id_token is required.' });
    }

    let payload;
    try {
      payload = await svc.verifyGoogleIdToken(id_token);
    } catch {
      return res.status(401).json({ success: false, message: 'Invalid Google ID token.' });
    }

    const email = payload?.email;
    if (!email) {
      return res.status(400).json({ success: false, message: 'ID token has no email.' });
    }

    const user  = await svc.loginWithGoogle(email);
    const token = svc.generateToken(user.id);

    if (server_auth_code) {
      try {
        const tokens = await svc.exchangeGoogleAuthCode(server_auth_code);
        if (tokens.access_token) {
          await svc.linkGmailAccount(user.id, email, tokens);
        }
      } catch (exchErr) {
        console.warn('[Auth] Gmail auto-link failed:', exchErr.message);
      }
    }

    return res.json({
      success: true,
      data: { token, user: { id: user.id, email: user.email, created_at: user.created_at } },
    });
  } catch (err) {
    next(err);
  }
};
