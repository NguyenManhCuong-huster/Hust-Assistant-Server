import passport        from 'passport';
import GoogleOAuth     from 'passport-google-oauth20';
import MicrosoftOAuth  from 'passport-microsoft';
import { query, getClient } from '../shared/database/db.js';
import { encrypt }          from './crypto.js';

const GoogleStrategy    = GoogleOAuth.Strategy;
const MicrosoftStrategy = MicrosoftOAuth.Strategy;

passport.use('google-login', new GoogleStrategy(
  {
    clientID:     process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:  process.env.GOOGLE_LOGIN_CALLBACK_URL,
  },
  async (_accessToken, _refreshToken, profile, done) => {
    try {
      const email  = profile.emails[0].value;
      const result = await query(
        `INSERT INTO users (email, password_hash) VALUES ($1, 'GOOGLE_OAUTH')
         ON CONFLICT (email) DO UPDATE SET is_deleted = FALSE
         RETURNING id, email, created_at`,
        [email],
      );
      return done(null, result.rows[0]);
    } catch (err) { return done(err, null); }
  },
));

passport.use('google-account', new GoogleStrategy(
  {
    clientID:          process.env.GOOGLE_CLIENT_ID,
    clientSecret:      process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:       process.env.GOOGLE_ACCOUNT_CALLBACK_URL,
    passReqToCallback: true,
    accessType:        'offline',
    prompt:            'consent',
    scope: [
      'profile',
      'email',
      'https://www.googleapis.com/auth/gmail.readonly',
    ],
  },
  async (req, accessToken, refreshToken, profile, done) => {
    const userId = req.session.linkUserId;
    if (!userId) return done(new Error('Link session invalid or expired.'), null);

    const client = await getClient();
    try {
      await client.query('BEGIN');
      const email = profile.emails[0].value;

      const tokenBlob = encrypt(JSON.stringify({
        access_token:  accessToken,
        refresh_token: refreshToken ?? null,
      }));

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
      delete req.session.linkUserId;
      return done(null, { accountId: rows[0].id, email, provider: 'GMAIL' });
    } catch (err) {
      await client.query('ROLLBACK');
      return done(err, null);
    } finally {
      client.release();
    }
  },
));

passport.use('microsoft-account', new MicrosoftStrategy(
  {
    clientID:          process.env.MICROSOFT_CLIENT_ID,
    clientSecret:      process.env.MICROSOFT_CLIENT_SECRET,
    callbackURL:       process.env.MICROSOFT_ACCOUNT_CALLBACK_URL,
    passReqToCallback: true,
    scope:             ['openid', 'profile', 'email', 'offline_access'],
    tenant:            'consumers',
  },
  async (req, accessToken, _refreshToken, profile, done) => {
    const userId = req.session.linkUserId;
    if (!userId) return done(new Error('Link session invalid or expired.'), null);

    const client = await getClient();
    try {
      await client.query('BEGIN');
      const email = profile.emails?.[0]?.value ?? profile._json?.email;
      if (!email) throw new Error('Could not retrieve email from Microsoft account.');
      const { rows } = await client.query(
        `INSERT INTO accounts (provider, username_or_email, access_token, status)
         VALUES ('OUTLOOK', $1, $2, 'ACTIVE')
         ON CONFLICT (provider, username_or_email)
           DO UPDATE SET access_token = EXCLUDED.access_token, status = 'ACTIVE'
         RETURNING id`,
        [email, encrypt(accessToken)],
      );
      await client.query(
        `INSERT INTO user_account_cross_ref (user_id, account_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [userId, rows[0].id],
      );
      await client.query('COMMIT');
      delete req.session.linkUserId;
      return done(null, { accountId: rows[0].id, email, provider: 'OUTLOOK' });
    } catch (err) {
      await client.query('ROLLBACK');
      return done(err, null);
    } finally {
      client.release();
    }
  },
));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const r = await query(
      'SELECT id, email, created_at FROM users WHERE id=$1 AND is_deleted=FALSE',
      [id],
    );
    done(null, r.rows[0] ?? null);
  } catch (err) { done(err, null); }
});

export default passport;
