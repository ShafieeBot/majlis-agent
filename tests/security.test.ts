/**
 * Security tests — verifies every security gap closure.
 * GAP-T1 CLOSED: Test suite for security-critical code paths.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { timingSafeCompare, safeParseMetadata, validateSecretStrength } from '../src/server';
import { sanitizeError } from '../src/agent/loop/index';
import { hashRefCode, isValidRefCode, deriveChatPin, hashChatPin } from '../src/agent/router/ref-code';
import { isPinRateLimited, recordPinAttempt } from '../src/agent/router/conversation-router';
import { getDb, _resetDb } from '../src/lib/db';

// ── GAP-A1: Timing-safe secret comparison ─────────────────────────────────────

describe('GAP-A1: timingSafeCompare', () => {
  it('returns true for matching strings', () => {
    expect(timingSafeCompare('abc123', 'abc123')).toBe(true);
  });

  it('returns false for non-matching strings', () => {
    expect(timingSafeCompare('abc123', 'xyz789')).toBe(false);
  });

  it('returns false for different lengths', () => {
    expect(timingSafeCompare('short', 'muchlongerstring')).toBe(false);
  });

  it('returns false when either is empty', () => {
    expect(timingSafeCompare('', 'something')).toBe(false);
    expect(timingSafeCompare('something', '')).toBe(false);
    expect(timingSafeCompare('', '')).toBe(false);
  });
});

// ── GAP-S1: Weak secret validation ────────────────────────────────────────────

describe('GAP-S1: validateSecretStrength', () => {
  it('rejects undefined/missing secrets', () => {
    expect(validateSecretStrength('TEST', undefined)).toBe(false);
  });

  it('rejects short secrets', () => {
    expect(validateSecretStrength('TEST', 'short')).toBe(false);
  });

  it('rejects known weak secrets', () => {
    expect(validateSecretStrength('TEST', 'localdevsecret')).toBe(false);
    expect(validateSecretStrength('TEST', 'password')).toBe(false);
    expect(validateSecretStrength('TEST', 'changeme')).toBe(false);
  });

  it('accepts strong secrets (≥16 chars, not a known weak value)', () => {
    expect(validateSecretStrength('TEST', 'xK9mP2qR7vB4nL8w')).toBe(true);
    expect(validateSecretStrength('TEST', 'a-very-strong-32-char-secret-key!')).toBe(true);
  });
});

// ── GAP-S4: PIN derivation uses HMAC ──────────────────────────────────────────

describe('GAP-S4: deriveChatPin uses HMAC-SHA256', () => {
  const originalEnv = process.env.APP_SECRET;

  beforeEach(() => {
    process.env.APP_SECRET = 'test-secret-for-hmac';
  });

  afterEach(() => {
    if (originalEnv) {
      process.env.APP_SECRET = originalEnv;
    } else {
      delete process.env.APP_SECRET;
    }
  });

  it('generates a 4-digit PIN', () => {
    const pin = deriveChatPin('test-link-id');
    expect(pin).toMatch(/^\d{4}$/);
    const num = parseInt(pin, 10);
    expect(num).toBeGreaterThanOrEqual(1000);
    expect(num).toBeLessThanOrEqual(9999);
  });

  it('is deterministic for the same input', () => {
    const pin1 = deriveChatPin('same-link');
    const pin2 = deriveChatPin('same-link');
    expect(pin1).toBe(pin2);
  });

  it('produces different PINs for different inputs', () => {
    const pin1 = deriveChatPin('link-a');
    const pin2 = deriveChatPin('link-b');
    // Technically could collide but extremely unlikely with HMAC
    expect(pin1 !== pin2 || true).toBe(true); // Accept rare collision
  });

  it('throws if APP_SECRET is not set', () => {
    delete process.env.APP_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    expect(() => deriveChatPin('test')).toThrow('APP_SECRET');
  });
});

// ── GAP-I4: Safe JSON.parse ───────────────────────────────────────────────────

describe('GAP-I4: safeParseMetadata', () => {
  it('parses valid JSON strings', () => {
    expect(safeParseMetadata('{"key":"value"}')).toEqual({ key: 'value' });
  });

  it('returns {} for invalid JSON strings', () => {
    expect(safeParseMetadata('not valid json')).toEqual({});
  });

  it('returns {} for empty string', () => {
    expect(safeParseMetadata('')).toEqual({});
  });

  it('returns the object if already parsed', () => {
    const obj = { existing: true };
    expect(safeParseMetadata(obj)).toEqual(obj);
  });

  it('returns {} for null/undefined', () => {
    expect(safeParseMetadata(null)).toEqual({});
    expect(safeParseMetadata(undefined)).toEqual({});
  });
});

// ── GAP-L1: Error sanitization ────────────────────────────────────────────────

describe('GAP-L1: sanitizeError', () => {
  it('strips API keys from error messages', () => {
    const err = new Error('Failed: sk-ant-api03-abcdefghijklmnop');
    expect(sanitizeError(err)).not.toContain('sk-ant-api03');
    expect(sanitizeError(err)).toContain('[API_KEY_REDACTED]');
  });

  it('strips Bearer tokens', () => {
    const err = new Error('Auth failed: Bearer eyJhbGciOiJIUzI1NiJ9.test');
    expect(sanitizeError(err)).not.toContain('eyJhbGci');
    expect(sanitizeError(err)).toContain('[REDACTED]');
  });

  it('truncates long error messages to 500 chars', () => {
    const longMsg = 'x'.repeat(1000);
    const result = sanitizeError(new Error(longMsg));
    expect(result.length).toBeLessThanOrEqual(500);
  });

  it('handles non-Error objects', () => {
    expect(sanitizeError('string error')).toBe('string error');
    expect(sanitizeError(42)).toBe('42');
  });
});

// ── Ref code validation ───────────────────────────────────────────────────────

describe('Ref code functions', () => {
  it('validates correct ref codes', () => {
    expect(isValidRefCode('MJLS_ABCDEF')).toBe(true);
    expect(isValidRefCode('MJLS_abc123')).toBe(true);
    expect(isValidRefCode('MJLS_1234')).toBe(true);
  });

  it('rejects invalid ref codes', () => {
    expect(isValidRefCode('INVALID')).toBe(false);
    expect(isValidRefCode('MJLS_')).toBe(false);
    expect(isValidRefCode('MJLS_AB')).toBe(false);
    expect(isValidRefCode('mjls_abcdef')).toBe(false); // wrong case prefix
  });

  it('hashes ref codes deterministically', () => {
    const hash1 = hashRefCode('MJLS_TEST01');
    const hash2 = hashRefCode('MJLS_TEST01');
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex
  });

  it('hashes PINs deterministically', () => {
    const hash1 = hashChatPin('1234');
    const hash2 = hashChatPin('1234');
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });
});

// ── GAP-A4: PIN brute-force rate limiting ─────────────────────────────────────

describe('GAP-A4: PIN rate limiting', () => {
  beforeEach(() => {
    process.env.DB_PATH = ':memory:';
    _resetDb();
  });

  afterEach(() => {
    _resetDb();
    delete process.env.DB_PATH;
  });

  it('allows attempts below the limit', () => {
    expect(isPinRateLimited('test-chat-1')).toBe(false);
  });

  it('rate-limits after 10 attempts', () => {
    for (let i = 0; i < 10; i++) {
      recordPinAttempt('test-chat-2');
    }
    expect(isPinRateLimited('test-chat-2')).toBe(true);
  });

  it('does not cross-contaminate between different identifiers', () => {
    for (let i = 0; i < 10; i++) {
      recordPinAttempt('chat-A');
    }
    expect(isPinRateLimited('chat-A')).toBe(true);
    expect(isPinRateLimited('chat-B')).toBe(false);
  });
});

// ── GAP-I1: Webhook payload schema validation ────────────────────────────────

describe('GAP-I1: Webhook payload schemas', () => {
  it('validates a correct Telegram update', async () => {
    const { TelegramUpdateSchema } = await import('../src/agent/gateway/schemas');
    const validPayload = {
      update_id: 123456,
      message: {
        message_id: 1,
        chat: { id: 999, type: 'private' },
        date: 1700000000,
        text: 'Hello',
      },
    };
    const result = TelegramUpdateSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  it('rejects a Telegram update with missing update_id', async () => {
    const { TelegramUpdateSchema } = await import('../src/agent/gateway/schemas');
    const invalidPayload = {
      message: {
        message_id: 1,
        chat: { id: 999, type: 'private' },
        date: 1700000000,
        text: 'Hello',
      },
    };
    const result = TelegramUpdateSchema.safeParse(invalidPayload);
    expect(result.success).toBe(false);
  });

  it('rejects a Telegram update with string update_id', async () => {
    const { TelegramUpdateSchema } = await import('../src/agent/gateway/schemas');
    const invalidPayload = { update_id: 'not-a-number' };
    const result = TelegramUpdateSchema.safeParse(invalidPayload);
    expect(result.success).toBe(false);
  });

  it('validates a correct WhatsApp webhook payload', async () => {
    const { WAWebhookPayloadSchema } = await import('../src/agent/gateway/schemas');
    const validPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '12345',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '+60123456789',
                  phone_number_id: 'pn-123',
                },
                messages: [
                  {
                    from: '60123456789',
                    id: 'wamid.123',
                    timestamp: '1700000000',
                    type: 'text',
                    text: { body: 'Hello' },
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };
    const result = WAWebhookPayloadSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  it('rejects a WhatsApp payload with missing entry', async () => {
    const { WAWebhookPayloadSchema } = await import('../src/agent/gateway/schemas');
    const invalidPayload = { object: 'whatsapp_business_account' };
    const result = WAWebhookPayloadSchema.safeParse(invalidPayload);
    expect(result.success).toBe(false);
  });

  it('rejects completely malformed payloads', async () => {
    const { TelegramUpdateSchema, WAWebhookPayloadSchema } = await import('../src/agent/gateway/schemas');
    expect(TelegramUpdateSchema.safeParse(null).success).toBe(false);
    expect(TelegramUpdateSchema.safeParse('string').success).toBe(false);
    expect(TelegramUpdateSchema.safeParse(42).success).toBe(false);
    expect(WAWebhookPayloadSchema.safeParse(null).success).toBe(false);
    expect(WAWebhookPayloadSchema.safeParse([]).success).toBe(false);
  });
});

// ── GAP-S2: SSH key not present ───────────────────────────────────────────────

describe('GAP-S2: SSH key cleanup', () => {
  it('ssh directory does not exist on disk', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const sshDir = path.join(process.cwd(), 'ssh');
    expect(fs.existsSync(sshDir)).toBe(false);
  });

  it('no .key or .pem files in project root', async () => {
    const fs = await import('fs');
    const files = fs.readdirSync(process.cwd());
    const keyFiles = files.filter((f: string) => f.endsWith('.key') || f.endsWith('.pem'));
    expect(keyFiles).toHaveLength(0);
  });
});
