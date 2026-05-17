import crypto from 'node:crypto';

const ALGORITHM  = 'aes-256-gcm';
const IV_LENGTH  = 12;
const TAG_LENGTH = 16;

const getKey = () => {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex) throw new Error('[Crypto] ENCRYPTION_KEY chưa set trong .env');
  if (hex.length !== 64) throw new Error(`[Crypto] ENCRYPTION_KEY phải là 64 ký tự hex, hiện: ${hex.length}`);
  return Buffer.from(hex, 'hex');
};

export const encrypt = (plaintext) => {
  if (!plaintext) throw new Error('[Crypto] plaintext không được rỗng');
  const key = getKey();
  const iv  = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), encrypted.toString('hex')].join(':');
};

export const decrypt = (encryptedData) => {
  if (!encryptedData) throw new Error('[Crypto] encryptedData không được rỗng');
  const parts = encryptedData.split(':');
  if (parts.length !== 3) throw new Error('[Crypto] Sai định dạng (iv:authTag:ciphertext)');
  const [ivHex, authTagHex, ciphertextHex] = parts;
  const key      = getKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'), { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]).toString('utf8');
};
