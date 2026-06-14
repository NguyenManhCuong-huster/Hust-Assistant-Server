import crypto from 'node:crypto';

const store  = new Map();
const TTL_MS = 5 * 60 * 1000; // 5 phút

export const createCode = (userId) => {
  const code      = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + TTL_MS;
  store.set(code, { userId, expiresAt });
  setTimeout(() => store.delete(code), TTL_MS).unref();
  return code;
};

export const consumeCode = (code) => {
  const entry = store.get(code);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(code);
    return null;
  }
  store.delete(code);
  return entry.userId;
};
