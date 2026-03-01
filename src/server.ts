/**
 * Agent Express Server
 *
 * Receives Telegram updates forwarded by the Next.js app proxy.
 * Exposes /admin/* routes for the admin panel to read conversations.
 */

import { randomUUID } from 'crypto';
import express from 'express';
import { getDb } from '@/lib/db';
import { parseInbound, sendMessage } from '@/agent/gateway';
import { resolveRouting } from '@/agent/router/conversation-router';
import { handleIncomingMessage } from '@/agent/handler';

const app = express();
app.use(express.json());

// ── Shared secret validation ───────────────────────────────────────────────────

function getSecret(): string {
  return process.env.AGENT_SERVICE_SECRET ?? '';
}

function requireSecret(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (req.headers['x-agent-secret'] !== getSecret()) {
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

// ── Health check ──────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ── Telegram update receiver ──────────────────────────────────────────────────

app.post('/telegram', requireSecret, (req, res) => {
  res.json({ ok: true });

  processTelegramUpdate(req.body).catch((err) => {
    console.error('[Agent] Unhandled error in processTelegramUpdate:', err);
  });
});

async function processTelegramUpdate(rawPayload: unknown) {
  const msg = parseInbound(rawPayload as Record<string, unknown>, 'telegram');
  if (!msg) return;

  if (isRateLimited(msg.chatId)) {
    await sendMessage({
      channel: 'telegram',
      chatId: msg.chatId,
      text: 'Anda telah menghantar terlalu banyak mesej. Sila cuba lagi kemudian. 🙏',
    });
    return;
  }

  const routerResult = await resolveRouting(msg);

  if (!routerResult.resolved) {
    if (routerResult.replyText) {
      await sendMessage({
        channel: 'telegram',
        chatId: msg.chatId,
        text: routerResult.replyText,
      });

      // Log inbound + routing reply to SQLite
      const db = getDb();
      const conv = db
        .prepare<[string, string], { id: string }>(
          'SELECT id FROM conversations WHERE channel = ? AND chat_id = ?',
        )
        .get('telegram', msg.chatId);

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

// ── Admin routes (require x-agent-secret) ─────────────────────────────────────

/**
 * GET /admin/conversations — list all conversations (newest first)
 */
app.get('/admin/conversations', requireSecret, (_req, res) => {
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
      metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata,
    })),
  );
});

/**
 * GET /admin/conversations/:id — conversation detail + messages
 */
app.get('/admin/conversations/:id', requireSecret, (req, res) => {
  const db = getDb();
  const conv = db
    .prepare<[string], Record<string, unknown>>('SELECT * FROM conversations WHERE id = ?')
    .get(req.params.id as string);

  if (!conv) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }

  const messages = db
    .prepare<[string], Record<string, unknown>>(
      `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`,
    )
    .all(req.params.id as string)
    .map((m: Record<string, unknown>) => ({
      ...m,
      metadata: typeof m.metadata === 'string' ? JSON.parse(m.metadata) : m.metadata,
    }));

  res.json({
    conversation: {
      ...conv,
      metadata: typeof conv.metadata === 'string' ? JSON.parse(conv.metadata) : conv.metadata,
    },
    messages,
  });
});

/**
 * POST /admin/conversations/:id/reply — admin sends a direct reply
 * Body: { content: string }
 */
app.post('/admin/conversations/:id/reply', requireSecret, async (req, res) => {
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
  if (!content?.trim()) {
    res.status(400).json({ error: 'content is required' });
    return;
  }

  try {
    const result = await sendMessage({
      channel: conv.channel as 'telegram',
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
    console.error('[Admin reply] Failed to send:', err);
    res.status(502).json({ error: 'Failed to deliver message' });
  }
});

/**
 * POST /admin/send — send by chatId+channel (for ticket replies)
 * Body: { chatId: string, channel: string, content: string }
 */
app.post('/admin/send', requireSecret, async (req, res) => {
  const { chatId, inviteGroupId, channel = 'telegram', content } = req.body as {
    chatId?: string;
    inviteGroupId?: string;
    channel?: string;
    content?: string;
  };

  if (!content?.trim()) {
    res.status(400).json({ error: 'content is required' });
    return;
  }

  const db = getDb();
  let resolvedChatId = chatId;
  let conv: { id: string } | undefined;

  if (inviteGroupId && !chatId) {
    // Look up chat_id from a resolved conversation for this invite group
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

  try {
    const result = await sendMessage({
      channel: channel as 'telegram',
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
    console.error('[Admin send] Failed to send:', err);
    res.status(502).json({ error: 'Failed to deliver message' });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

export function startServer(port = 3001) {
  app.listen(port, () => {
    console.log(`[Agent] Server listening on :${port}`);
  });
}
