/**
 * Server endpoint tests — verifies API security, health checks, and input validation.
 * GAP-T1 CLOSED: Integration tests for Express routes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { app, MAX_CONTENT_LENGTH } from '../src/server';
import http from 'http';

// Minimal supertest-like helper to avoid adding another dependency
async function request(
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      const url = `http://127.0.0.1:${addr.port}${path}`;

      const bodyStr = options.body ? JSON.stringify(options.body) : undefined;
      const parsed = new URL(url);

      const req = http.request(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname + parsed.search,
          method,
          headers: {
            'Content-Type': 'application/json',
            ...options.headers,
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            server.close();
            let body: unknown;
            try {
              body = JSON.parse(data);
            } catch {
              body = data;
            }
            resolve({
              status: res.statusCode ?? 0,
              body,
              headers: res.headers as Record<string, string>,
            });
          });
        },
      );

      req.on('error', (err) => {
        server.close();
        reject(err);
      });

      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  });
}

// ── GAP-O1: Health check tests ────────────────────────────────────────────────

describe('GAP-O1: Health check', () => {
  beforeEach(() => {
    process.env.DB_PATH = ':memory:';
    process.env.LLM_API_KEY = 'test-key';
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.AGENT_SERVICE_SECRET = 'test-webhook-secret-123456';
  });

  it('GET /health returns 200 with dependency checks', async () => {
    const res = await request('GET', '/health');
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.checks).toBeDefined();
    const checks = body.checks as Record<string, string>;
    expect(checks.database).toBe('ok');
    expect(checks.llm_key).toBe('configured');
    expect(checks.telegram).toBe('configured');
  });

  it('GET /ready returns 200', async () => {
    const res = await request('GET', '/ready');
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).ready).toBe(true);
  });
});

// ── GAP-A1/A2: Auth guard tests ───────────────────────────────────────────────

describe('GAP-A1/A2: Auth guards', () => {
  beforeEach(() => {
    process.env.DB_PATH = ':memory:';
    process.env.AGENT_SERVICE_SECRET = 'test-webhook-secret-123456';
    process.env.ADMIN_SECRET = 'test-admin-secret-123456xx';
  });

  it('POST /telegram returns 403 without secret', async () => {
    const res = await request('POST', '/telegram', { body: {} });
    expect(res.status).toBe(403);
  });

  it('POST /telegram returns 403 with wrong secret', async () => {
    const res = await request('POST', '/telegram', {
      body: {},
      headers: { 'x-agent-secret': 'wrong' },
    });
    expect(res.status).toBe(403);
  });

  it('POST /telegram returns 200 with correct webhook secret', async () => {
    const res = await request('POST', '/telegram', {
      body: {},
      headers: { 'x-agent-secret': 'test-webhook-secret-123456' },
    });
    expect(res.status).toBe(200);
  });

  it('GET /admin/conversations returns 403 without admin secret', async () => {
    const res = await request('GET', '/admin/conversations');
    expect(res.status).toBe(403);
  });

  it('GET /admin/conversations returns 403 with webhook secret (wrong level)', async () => {
    const res = await request('GET', '/admin/conversations', {
      headers: { 'x-agent-secret': 'test-webhook-secret-123456' },
    });
    // With ADMIN_SECRET set, the webhook secret should NOT work for admin routes
    expect(res.status).toBe(403);
  });

  it('GET /admin/conversations returns 200 with correct admin secret', async () => {
    const res = await request('GET', '/admin/conversations', {
      headers: { 'x-admin-secret': 'test-admin-secret-123456xx' },
    });
    expect(res.status).toBe(200);
  });
});

// ── GAP-I2: Content validation ────────────────────────────────────────────────

describe('GAP-I2: Admin send content validation', () => {
  beforeEach(() => {
    process.env.DB_PATH = ':memory:';
    process.env.AGENT_SERVICE_SECRET = 'test-webhook-secret-123456';
    // Clear ADMIN_SECRET so admin routes fall back to AGENT_SERVICE_SECRET
    delete process.env.ADMIN_SECRET;
  });

  it('POST /admin/send rejects empty content', async () => {
    const res = await request('POST', '/admin/send', {
      body: { chatId: '123', content: '' },
      headers: { 'x-admin-secret': 'test-webhook-secret-123456' },
    });
    expect(res.status).toBe(400);
    expect((res.body as Record<string, string>).error).toContain('content is required');
  });

  it('POST /admin/send rejects whitespace-only content', async () => {
    const res = await request('POST', '/admin/send', {
      body: { chatId: '123', content: '   ' },
      headers: { 'x-admin-secret': 'test-webhook-secret-123456' },
    });
    expect(res.status).toBe(400);
  });

  it('POST /admin/send rejects missing chatId and inviteGroupId', async () => {
    const res = await request('POST', '/admin/send', {
      body: { content: 'Hello!' },
      headers: { 'x-admin-secret': 'test-webhook-secret-123456' },
    });
    expect(res.status).toBe(400);
    expect((res.body as Record<string, string>).error).toContain('chatId or inviteGroupId is required');
  });
});

// ── GAP-P2: Body size limit ───────────────────────────────────────────────────

describe('GAP-P2: Request body size limit', () => {
  it('rejects payloads larger than 1MB', async () => {
    const largeContent = 'x'.repeat(1_100_000); // > 1MB
    const res = await request('POST', '/telegram', {
      body: { data: largeContent },
      headers: { 'x-agent-secret': 'test-webhook-secret-123456' },
    });
    expect(res.status).toBe(413);
  });
});

// ── GAP-L3: Audit logging ─────────────────────────────────────────────────────

describe('GAP-L3: Audit logging', () => {
  beforeEach(() => {
    process.env.DB_PATH = ':memory:';
    process.env.AGENT_SERVICE_SECRET = 'test-webhook-secret-123456';
  });

  it('records audit entry when admin lists conversations', async () => {
    const { getDb: getTestDb } = await import('../src/lib/db');

    await request('GET', '/admin/conversations', {
      headers: { 'x-agent-secret': 'test-webhook-secret-123456' },
    });

    const db = getTestDb();
    const entries = db.prepare('SELECT * FROM audit_log').all() as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const entry = entries[entries.length - 1];
    expect(entry.action).toBe('admin.list_conversations');
  });
});
