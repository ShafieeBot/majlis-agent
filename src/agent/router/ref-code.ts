/**
 * Reference code + chat PIN generation and hashing for Telegram identification.
 *
 * Ref code format: MJLS_XXXXXX (6 alphanumeric chars) — used for deep links (/start)
 * Chat PIN format: 4-digit numeric — shown on invite card, typed into chat to identify
 *
 * Only SHA-256 hashes are stored in the database. Raw values are never persisted.
 *
 * GAP-S4 CLOSED: deriveChatPin now uses createHmac instead of createHash.
 */

import { createHash, createHmac, randomBytes } from 'crypto';

const REF_CODE_PREFIX = 'MJLS_';
const REF_CODE_LENGTH = 6;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'; // no ambiguous chars

/** Generate a random MJLS_XXXXXX reference code for Telegram deep links. */
export function generateRefCode(): string {
  const bytes = randomBytes(REF_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < REF_CODE_LENGTH; i++) {
    code += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return `${REF_CODE_PREFIX}${code}`;
}

/** Hash a reference code with SHA-256. This hash is stored in invite_links. */
export function hashRefCode(refCode: string): string {
  return createHash('sha256').update(refCode).digest('hex');
}

/** Check if a string looks like a valid Majlis reference code. */
export function isValidRefCode(value: string): boolean {
  return /^MJLS_[A-Za-z0-9]{4,8}$/.test(value);
}

/**
 * Derive a stable 4-digit chat PIN from a link ID.
 * GAP-S4 CLOSED: Uses HMAC-SHA256(secret, linkId) — proper keyed hash.
 * The same link always produces the same PIN — stable across page loads.
 */
export function deriveChatPin(linkId: string): string {
  const secret = process.env.APP_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error('APP_SECRET (or NEXTAUTH_SECRET) must be set — chat PIN derivation requires a secret key');
  }
  // GAP-S4: Use createHmac (proper HMAC) instead of createHash (plain hash)
  const hmac = createHmac('sha256', secret).update(linkId).digest();
  // Take first 2 bytes → number 0-65535 → map to 1000-9999
  const num = ((hmac[0] << 8) | hmac[1]) % 9000 + 1000;
  return String(num);
}

/** Hash a chat PIN with SHA-256. This hash is stored in invite_links. */
export function hashChatPin(pin: string): string {
  return createHash('sha256').update(pin).digest('hex');
}
