import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'crypto';

const ITERATIONS = 100000;
const KEYLEN = 64;
const DIGEST = 'sha512';

interface HashResult {
  hash: string;
  salt: string;
}

/**
 * Hash a password using PBKDF2 with SHA-512 and a cryptographically secure random salt.
 */
export function hashPassword(password: string, providedSalt?: string): HashResult {
  const salt = providedSalt || randomBytes(16).toString('hex');
  const hash = pbkdf2Sync(password, salt, ITERATIONS, KEYLEN, DIGEST).toString('hex');
  return { hash, salt };
}

/**
 * Constant-time verification of a plaintext password against a stored hash and salt.
 */
export function verifyPassword(password: string, storedHash: string, salt: string): boolean {
  try {
    const { hash } = hashPassword(password, salt);
    const hashBuf = Buffer.from(hash, 'hex');
    const storedBuf = Buffer.from(storedHash, 'hex');
    if (hashBuf.length !== storedBuf.length) return false;
    return timingSafeEqual(hashBuf, storedBuf);
  } catch {
    return false;
  }
}
