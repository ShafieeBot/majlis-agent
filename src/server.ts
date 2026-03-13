/**
 * Agent Express Server
 *
 * Receives Telegram and WhatsApp updates forwarded by the Next.js app proxy.
 * Exposes /admin/* routes for the admin panel to read conversations.
 *
 * Security hardening applied per audit:
 * GAP-A1: timingSafeEqual for shared secret comparison
 * GAP-A2: Separate webhook vs admin secrets
 * GAP-P2: Request body size limit
 * GAP-P1: CORS middleware
 * GAP-P3: Trust proxy
 * GAP-L3: Audit logging for admin operations
 * GAP-I2: Content validation on admin send
 * GAP-I4: Safe JSON.parse on metadata
 * GAP-O1: Enhanced health check
 * GAP-S1: Weak secret validation at startup
 */

import { randomUUID, timingSafeEqual } from 'crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { getDb } from '@/lib/db';
import { parseInbound, sendMessage } from '@/agent/gateway';
import { resolveRouting } from '@/agent/router/conversation-router';
import { handleIncomingMessage } from '@/agent/handler';
import { createModuleLogger } from '@/lib/logger';
import { recordAudit } from '@/lib/audit';

const log = createModuleLogger('server');

const app = express();

// GAP-P3 CLOSED: Trust proxy for correct client IP behind reverse proxy
app.set('trust proxy', 1);

// GAP-P2 CLOSED: Request body size limit (1MB)
app.use(express.json({ limit: '1mb' }));

// GAP-P1 CLOSED: CORS configuration
app.use(
  cors({
    origin: process.env.CORS_ALLOWED_ORIGINS
      ? process.env.CORS_ALLOWED_ORIGINS.split(',')
      : [process.env.APP_URL || 'https://jemputan.app'],
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'x-agent-secret', 'x-admin-secret'],
  }),
);

// Security headers via helmet
app.use(helmet());

// ── Shared secret validation ───────────────────────────────────────────────────

// GAP-S1 CLOSED: Validate secrets are not weak at startup
export function validateSecretStrength(name: string, value: string | undefined): boolean {
  if (!value || value.length < 16) {
    log.warn({ name }, `${name} is missing or too short (min 16 chars). Set a strong secret in production.`);
    return false;
  }
  const weakSecrets = ['localdevsecret', 'secret', 'password', 'changeme', 'test', 'dev'];
  if (weakSecrets.includes(value.toLowerCase())) {
    log.warn({ name }, `${name} is set to a weak/default value. Rotate immediately in production.`);
    return false;
  }
  return true;
}

function getWebhookSecret(): string {
  return process.env.AGENT_SERVICE_SECRET ?? '';
}

// GAP-A2 CLOSED: Separate admin secret (falls back to AGENT_SERVICE_SECRET for backward compat)
function getAdminSecret(): string {
  return process.env.ADMIN_SECRET ?? process.env.AGENT_SERVICE_SECRET ?? '';
}

// GAP-A1 CLOSED: Use timingSafeEqual to prevent timing attacks
export function timingSafeCompare(a: string, b: string): boolean {
  if (!a || !b) return false;
  try {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

function requireWebhookSecret(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const provided = req.headers['x-agent-secret'] as string | undefined;
  if (!timingSafeCompare(provided ?? '', getWebhookSecret())) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

function requireAdminSecret(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const provided =
    (req.headers['x-admin-secret'] as string | undefined) ??
    (req.headers['x-agent-secret'] as string | undefined);
  if (!timingSafeCompare(provided ?? '', getAdminSecret())) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// ── Per-chat rate limiter (in-memory) ─────────────────────────────────────────

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 30;
const RATE_WINDOW = 3_600_000; // 1 hour

function isRateLimited(chatId: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(chatId);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(chatId, { count: 1, resetAt: now + RATE_WINDOW });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT;
}

// ── GAP-I4 CLOSED: Safe JSON.parse helper ─────────────────────────────────────

export function safeParseMetadata(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return (raw as Record<string, unknown>) ?? {};
}

// ── GAP-O1 CLOSED: Enhanced health check ──────────────────────────────────────

app.get('/health', (_req, res) => {
  try {
    const db = getDb();
    // Verify DB is accessible with a simple query
    const dbCheck = db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
    const dbOk = dbCheck?.ok === 1;

    const llmKeySet = !!process.env.LLM_API_KEY;
    const telegramSet = !!process.env.TELEGRAM_BOT_TOKEN;

    res.json({
      ok: dbOk && llmKeySet,
      ts: new Date().toISOString(),
      checks: {
        database: dbOk ? 'ok' : 'error',
        llm_key: llmKeySet ? 'configured' : 'missing',
        telegram: telegramSet ? 'configured' : 'missing',
      },
    });
  } catch {
    res.status(503).json({
      ok: false,
      ts: new Date().toISOString(),
      error: 'Health check failed',
    });
  }
});

app.get('/ready', (_req, res) => {
  try {
    const db = getDb();
    db.prepare('SELECT 1').get();
    res.json({ ready: true });
  } catch {
    res.status(503).json({ ready: false });
  }
});

// ── Channel update processor (shared by Telegram + WhatsApp) ─────────────────

type Channel = 'telegram' | 'whatsapp';

// GAP-I2 CLOSED: Content length limit for outbound messages
const MAX_CONTENT_LENGTH = 4096;

async function processChannelUpdate(rawPayload: unknown, channel: Channel) {
  const msg = parseInbound(rawPayload as Record<string, unknown>, channel);
  if (!msg) return;

  if (isRateLimited(msg.chatId)) {
    await sendMessage({
      channel,
      chatId: msg.chatId,
      text: 'Anda telah menghantar terlalu banyak mesej. Sila cuba lagi kemudian. 🙏',
    });
    return;
  }

  const routerResult = await resolveRouting(msg);

  if (!routerResult.resolved) {
    if (routerResult.replyText) {
      await sendMessage({
        channel,
        chatId: msg.chatId,
        text: routerResult.replyText,
      });

      // Log inbound + routing reply to SQLite
      const db = getDb();
      const conv = db
        .prepare<[string, string], { id: string }>(
          'SELECT id FROM conversations WHERE channel = ? AND chat_id = ?',
        )
        .get(channel, msg.chatId);

      if (conv) {
        const now = new Date().toISOString();
        db.prepare(`
          INSERT INTO messages (id, conversation_id, direction, status, content, metadata, created_at)
          VALUES (?, ?, 'IN', 'RECEIVED', ?, ?, ?)
        `).run(
          randomUUID(),
          conv.id,
          msg.text,
          JSON.stringify({ sender_name: msg.senderName }),
          now,
        );
        db.prepare(`
          INSERT INTO messages (id, conversation_id, direction, status, intent, content, created_at)
          VALUES (?, ?, 'OUT', 'SENT', 'GREETING', ?, ?)
        `).run(randomUUID(), conv.id, routerResult.replyText, now);
      }
    }
    return;
  }

  await handleIncomingMessage(routerResult.context!, msg);
}

// ── Telegram update receiver ──────────────────────────────────────────────────

app.post('/telegram', requireWebhookSecret, (req, res) => {
  res.json({ ok: true });

  processChannelUpdate(req.body, 'telegram').catch((err) => {
    log.error({ err, channel: 'telegram' }, 'Unhandled error in processChannelUpdate');
  });
});

// ── WhatsApp update receiver ─────────────────────────────────────────────────

app.post('/whatsapp', requireWebhookSecret, (req, res) => {
  res.json({ ok: true });

  processChannelUpdate(req.body, 'whatsapp').catch((err) => {
    log.error({ err, channel: 'whatsapp' }, 'Unhandled error in processChannelUpdate');
  });
});

// ── Admin routes (require admin secret — GAP-A2) ─────────────────────────────

/**
 * GET /admin/conversations — list all conversations (newest first)
 */
app.get('/admin/conversations', requireAdminSecret, (req, res) => {
  // GAP-L3: Audit log
  recordAudit({
    action: 'admin.list_conversations',
    actor: 'admin',
    target_type: 'conversations',
    target_id: '*',
    ip_address: Array.isArray(req.ip) ? req.ip[0] : req.ip,
  });

  const db = getDb();
  const rows = db
    .prepare<[], Record<string, unknown>>(
      `SELECT c.*,
              (SELECT content FROM messages m
               WHERE m.conversation_id = c.id
               ORDER BY m.created_at DESC LIMIT 1) AS last_message_preview
       FROM conversations c
       ORDER BY c.last_message_at DESC
       LIMIT 100`,
    )
    .all();

  res.json(
    rows.map((r: Record<string, unknown>) => ({
      ...r,
      metadata: safeParseMetadata(r.metadata),
    })),
  );
});

/**
 * GET /admin/conversations/:id — conversation detail + messages
 */
app.get('/admin/conversations/:id', requireAdminSecret, (req, res) => {
  const db = getDb();
  const conv = db
    .prepare<[string], Record<string, unknown>>('SELECT * FROM conversations WHERE id = ?')
    .get(req.params.id as string);

  if (!conv) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }

  // GAP-L3: Audit log
  recordAudit({
    action: 'admin.read_conversation',
    actor: 'admin',
    target_type: 'conversation',
    target_id: req.params.id as string,
    ip_address: Array.isArray(req.ip) ? req.ip[0] : req.ip,
  });

  const messages = db
    .prepare<[string], Record<string, unknown>>(
      `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`,
    )
    .all(req.params.id as string)
    .map((m: Record<string, unknown>) => ({
      ...m,
      metadata: safeParseMetadata(m.metadata),
    }));

  res.json({
    conversation: {
      ...conv,
      metadata: safeParseMetadata(conv.metadata),
    },
    messages,
  });
});

/**
 * POST /admin/conversations/:id/reply — admin sends a direct reply
 * Body: { content: string }
 */
app.post('/admin/conversations/:id/reply', requireAdminSecret, async (req, res) => {
  const db = getDb();
  const conv = db
    .prepare<[string], { id: string; channel: string; chat_id: string }>(
      'SELECT id, channel, chat_id FROM conversations WHERE id = ?',
    )
    .get(req.params.id as string);

  if (!conv) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }

  const { content } = req.body as { content?: string };

  // GAP-I2 CLOSED: Validate admin send content
  if (!content?.trim()) {
    res.status(400).json({ error: 'content is required' });
    return;
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    res.status(400).json({ error: `content must be ${MAX_CONTENT_LENGTH} characters or less` });
    return;
  }

  // GAP-L3: Audit log
  recordAudit({
    action: 'admin.reply',
    actor: 'admin',
    target_type: 'conversation',
    target_id: req.params.id as string,
    metadata: { content_length: content.length, channel: conv.channel },
    ip_address: Array.isArray(req.ip) ? req.ip[0] : req.ip,
  });

  try {
    const result = await sendMessage({
      channel: conv.channel as Channel,
      chatId: conv.chat_id,
      text: content,
    });

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO messages (id, conversation_id, direction, status, content, platform_message_id, created_at)
      VALUES (?, ?, 'OUT', 'SENT', ?, ?, ?)
    `).run(randomUUID(), conv.id, content, result.messageId, now);

    res.json({ ok: true, messageId: result.messageId });
  } catch (err) {
    log.error({ err, conversationId: conv.id }, 'Admin reply failed to send');
    res.status(502).json({ error: 'Failed to deliver message' });
  }
});

/**
 * POST /admin/send — send by chatId+channel (for ticket replies)
 * Body: { chatId: string, channel: string, content: string }
 */
app.post('/admin/send', requireAdminSecret, async (req, res) => {
  const { chatId, inviteGroupId, channel = 'telegram', content } = req.body as {
    chatId?: string;
    inviteGroupId?: string;
    channel?: string;
    content?: string;
  };

  // GAP-I2 CLOSED: Validate admin send content
  if (!content?.trim()) {
    res.status(400).json({ error: 'content is required' });
    return;
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    res.status(400).json({ error: `content must be ${MAX_CONTENT_LENGTH} characters or less` });
    return;
  }

  const db = getDb();
  let resolvedChatId = chatId;
  let conv: { id: string } | undefined;

  if (inviteGroupId && !chatId) {
    const row = db
      .prepare<[string, string], { id: string; chat_id: string }>(
        'SELECT id, chat_id FROM conversations WHERE invite_group_id = ? AND channel = ? LIMIT 1',
      )
      .get(inviteGroupId, channel);

    if (!row) {
      res.status(404).json({ error: 'Guest has not started a conversation with the bot yet' });
      return;
    }
    resolvedChatId = row.chat_id;
    conv = { id: row.id };
  } else if (chatId) {
    conv = db
      .prepare<[string, string], { id: string }>(
        'SELECT id FROM conversations WHERE channel = ? AND chat_id = ?',
      )
      .get(channel, chatId);
  } else {
    res.status(400).json({ error: 'chatId or inviteGroupId is required' });
    return;
  }

  // GAP-L3: Audit log
  recordAudit({
    action: 'admin.send',
    actor: 'admin',
    target_type: 'chat',
    target_id: resolvedChatId ?? inviteGroupId ?? 'unknown',
    metadata: { content_length: content.length, channel },
    ip_address: Array.isArray(req.ip) ? req.ip[0] : req.ip,
  });

  try {
    const result = await sendMessage({
      channel: channel as Channel,
      chatId: resolvedChatId!,
      text: content,
    });

    if (conv) {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO messages (id, conversation_id, direction, status, content, platform_message_id, created_at)
        VALUES (?, ?, 'OUT', 'SENT', ?, ?, ?)
      `).run(randomUUID(), conv.id, content, result.messageId, now);
    }

    res.json({ ok: true, messageId: result.messageId });
  } catch (err) {
    log.error({ err, chatId: resolvedChatId }, 'Admin send failed');
    res.status(502).json({ error: 'Failed to deliver message' });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

export function startServer(port = 3001) {
  // GAP-S1 CLOSED: Warn on weak secrets at startup
  validateSecretStrength('AGENT_SERVICE_SECRET', process.env.AGENT_SERVICE_SECRET);
  validateSecretStrength('APP_SECRET', process.env.APP_SECRET);
  if (process.env.ADMIN_SECRET) {
    validateSecretStrength('ADMIN_SECRET', process.env.ADMIN_SECRET);
  }

  app.listen(port, () => {
    log.info({ port }, 'Agent server listening');
  });
}

// Export for testing
export { app, MAX_CONTENT_LENGTH };
