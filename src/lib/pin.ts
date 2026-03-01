/**
 * Reference code + chat PIN generation and hashing for Telegram identification.
 * Copied from majlis/src/lib/pin.ts — keep in sync.
 */

import { createHash, randomBytes } from 'crypto';

const REF_CODE_PREFIX = 'MJLS_';
const REF_CODE_LENGTH = 6;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

export function generateRefCode(): string {
  const bytes = randomBytes(REF_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < REF_CODE_LENGTH; i++) {
    code += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return `${REF_CODE_PREFIX}${code}`;
}

export function hashRefCode(refCode: string): string {
  return createHash('sha256').update(refCode).digest('hex');
}

export function isValidRefCode(value: string): boolean {
  return /^MJLS_[A-Za-z0-9]{4,8}$/.test(value);
}

export function deriveChatPin(linkId: string): string {
  const secret = process.env.APP_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error('APP_SECRET must be set — chat PIN derivation requires a secret key');
  }
  const hmac = createHash('sha256').update(`${secret}:${linkId}`).digest();
  const num = ((hmac[0] << 8) | hmac[1]) % 9000 + 1000;
  return String(num);
}

export function hashChatPin(pin: string): string {
  return createHash('sha256').update(pin).digest('hex');
}
