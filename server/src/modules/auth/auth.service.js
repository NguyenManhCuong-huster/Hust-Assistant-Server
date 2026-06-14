import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import * as repo from '../../dao/auth.dao.js';

const googleOAuthClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

export const generateToken = (userId) =>
  jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  });

export const verifyGoogleIdToken = async (idToken) => {
  const ticket = await googleOAuthClient.verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  return ticket.getPayload();
};

export const loginWithGoogle = (email) => repo.upsertUser(email);

export const exchangeGoogleAuthCode = async (serverAuthCode) => {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      code:          serverAuthCode,
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri:  '',
      grant_type:    'authorization_code',
    }),
  });
  if (!tokenRes.ok) throw new Error('Token exchange failed');
  return tokenRes.json();
};

export const linkGmailAccount = (userId, email, tokens) =>
  repo.linkGmailAccount(userId, email, tokens);
