/**
 * Conversation Router — State machine that resolves which wedding + invite group
 * a conversation belongs to. Runs BEFORE the agent runner.
 *
 * GAP-A4 CLOSED: Global PIN brute-force rate limiting via pin_attempts table.
 * GAP-R2 CLOSED: Supabase sync with retry via withRetry.
 */

import { randomUUID } from 'crypto';
import { getDb } from '@/lib/db';
import { lookupByHash, lookupByPhone, listWeddings, createTicket, syncConversation } from '@/lib/api-client';
import { hashRefCode, isValidRefCode, hashChatPin } from './ref-code';
import { withRetry, isRetryableHttpError } from '@/lib/retry';
import { createModuleLogger } from '@/lib/logger';
import type { NormalisedInboundMessage } from '../gateway/types';
import type { ConversationRecord, RoutedContext, RoutingState } from '../types';

const log = createModuleLogger('router');

export interface RouterResult {
  resolved: boolean;
  context?: RoutedContext;
  replyText?: string;
}

// Parse a raw SQLite row into ConversationRecord (metadata is stored as a JSON string)
function parseRow(row: Record<string, unknown>): ConversationRecord {
  let metadata: Record<string, unknown> | null = null;
  if (typeof row.metadata === 'string') {
    try {
      metadata = JSON.parse(row.metadata);
    } catch {
      metadata = null;
    }
  } else {
    metadata = (row.metadata as Record<string, unknown>) ?? null;
  }
  return { ...row, metadata } as ConversationRecord;
}

// ── GAP-A4 CLOSED: Global PIN brute-force rate limiting ──────────────────────

const PIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const PIN_RATE_LIMIT_MAX = 10; // max 10 attempts per identifier per window

/**
 * Check if a chat has exceeded the global PIN attempt rate limit.
 * Uses the pin_attempts table in SQLite rather than in-memory state.
 */
export function isPinRateLimited(identifier: string): boolean {
  const db = getDb();
  const windowStart = new Date(Date.now() - PIN_RATE_LIMIT_WINDOW_MS).toISOString();

  const row = db
    .prepare<[string, string], { count: number }>(
      'SELECT COUNT(*) as count FROM pin_attempts WHERE identifier = ? AND attempted_at > ?',
    )
    .get(identifier, windowStart);

  return (row?.count ?? 0) >= PIN_RATE_LIMIT_MAX;
}

/**
 * Record a PIN attempt for rate limiting.
 */
export function recordPinAttempt(identifier: string): void {
  const db = getDb();
  db.prepare('INSERT INTO pin_attempts (id, identifier, attempted_at) VALUES (?, ?, ?)').run(
    randomUUID(),
    identifier,
    new Date().toISOString(),
  );

  // Cleanup old entries (older than 1 hour)
  const cutoff = new Date(Date.now() - 3_600_000).toISOString();
  db.prepare('DELETE FROM pin_attempts WHERE attempted_at < ?').run(cutoff);
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function resolveRouting(msg: NormalisedInboundMessage): Promise<RouterResult> {
  const db = getDb();

  const existing = db
    .prepare<[string, string], Record<string, unknown>>(
      'SELECT * FROM conversations WHERE channel = ? AND chat_id = ?',
    )
    .get(msg.channel, msg.chatId);

  const conversation = existing ? parseRow(existing) : null;

  // Already resolved — refresh timestamps and return
  if (conversation?.routing_state === 'RESOLVED' && conversation.wedding_id && conversation.invite_group_id) {
    const now = new Date().toISOString();
    db.prepare('UPDATE conversations SET last_message_at = ?, sender_name = ?, updated_at = ? WHERE id = ?').run(
      now,
      msg.senderName || conversation.sender_name,
      now,
      conversation.id,
    );

    return {
      resolved: true,
      context: {
        conversation,
        weddingId: conversation.wedding_id,
        inviteGroupId: conversation.invite_group_id,
      },
    };
  }

  // /start MJLS_XXXX deep link — highest priority
  if (msg.metadata.isCommand && msg.metadata.commandArg && isValidRefCode(msg.metadata.commandArg)) {
    return handleRefCodeStart(msg, conversation);
  }

  const state = conversation?.routing_state ?? 'UNKNOWN';

  if (state === 'AWAITING_SELECTION') {
    return handleAwaitingSelection(msg, conversation!);
  }

  if (state === 'AWAITING_CODE') {
    return handleAwaitingCode(msg, conversation!);
  }

  // UNKNOWN / NEEDS_SELECTION / new conversation → begin identification
  return handleUnknown(msg, conversation);
}

// ── /start MJLS_XXXX deep link ────────────────────────────────────────────────

async function handleRefCodeStart(
  msg: NormalisedInboundMessage,
  existing: ConversationRecord | null,
): Promise<RouterResult> {
  const refCode = msg.metadata.commandArg!;
  const hash = hashRefCode(refCode);

  const result = await lookupByHash('ref', hash);

  if (!result) {
    upsertConversation(msg, existing, { routing_state: 'UNKNOWN' as RoutingState });
    return {
      resolved: false,
      replyText: 'Maaf, kod jemputan tidak sah. Sila gunakan pautan jemputan anda yang betul.',
    };
  }

  const conv = upsertConversation(msg, existing, {
    routing_state: 'RESOLVED' as RoutingState,
    wedding_id: result.weddingId,
    invite_group_id: result.inviteGroupId,
  });

  return {
    resolved: true,
    context: { conversation: conv, weddingId: result.weddingId, inviteGroupId: result.inviteGroupId },
  };
}

// ── Step 1: New/unknown guest → phone lookup (WhatsApp) or ask for PIN ──────

async function handleUnknown(
  msg: NormalisedInboundMessage,
  existing: ConversationRecord | null,
): Promise<RouterResult> {
  // WhatsApp: try to resolve by phone number first (chatId = phone number)
  if (msg.channel === 'whatsapp') {
    try {
      const phoneMatches = await lookupByPhone(msg.chatId);

      if (phoneMatches.length === 1) {
        const match = phoneMatches[0];
        const conv = upsertConversation(msg, existing, {
          routing_state: 'RESOLVED' as RoutingState,
          wedding_id: match.weddingId,
          invite_group_id: match.inviteGroupId,
        });
        return {
          resolved: true,
          context: { conversation: conv, weddingId: match.weddingId, inviteGroupId: match.inviteGroupId },
        };
      }

      if (phoneMatches.length > 1) {
        const weddings = await listWeddings();
        const matchedWeddings = phoneMatches
          .map((m) => {
            const w = weddings.find((w) => w.id === m.weddingId);
            return w ? { ...w, inviteGroupId: m.inviteGroupId } : null;
          })
          .filter(Boolean) as Array<{ id: string; title: string; inviteGroupId: string }>;

        if (matchedWeddings.length === 1) {
          const match = phoneMatches.find((m) => m.weddingId === matchedWeddings[0].id)!;
          const conv = upsertConversation(msg, existing, {
            routing_state: 'RESOLVED' as RoutingState,
            wedding_id: match.weddingId,
            invite_group_id: match.inviteGroupId,
          });
          return {
            resolved: true,
            context: { conversation: conv, weddingId: match.weddingId, inviteGroupId: match.inviteGroupId },
          };
        }

        if (matchedWeddings.length > 1) {
          const options = matchedWeddings.map((w, i) => `${i + 1}. ${w.title}`).join('\n');
          upsertConversation(msg, existing, {
            routing_state: 'AWAITING_SELECTION' as RoutingState,
            metadata: {
              wedding_options: matchedWeddings.map((w) => w.id),
              phone_matches: matchedWeddings.map((w) => ({
                weddingId: w.id,
                inviteGroupId: w.inviteGroupId,
              })),
            },
          });
          return {
            resolved: false,
            replyText: `Assalamualaikum! 👋 Majlis yang mana satu?\n\n${options}`,
          };
        }
      }
    } catch (err) {
      log.warn({ err }, 'Phone lookup failed, falling back to PIN flow');
    }
  }

  // Standard flow: list all weddings and ask for PIN
  const weddings = await listWeddings();

  if (!weddings || weddings.length === 0) {
    return { resolved: false, replyText: 'Maaf, tiada majlis aktif pada masa ini.' };
  }

  if (weddings.length > 1) {
    const options = weddings.map((w, i) => `${i + 1}. ${w.title}`).join('\n');
    upsertConversation(msg, existing, {
      routing_state: 'AWAITING_SELECTION' as RoutingState,
      metadata: { wedding_options: weddings.map((w) => w.id) },
    });
    return {
      resolved: false,
      replyText: `Assalamualaikum! 👋 Majlis yang mana satu?\n\n${options}`,
    };
  }

  const wedding = weddings[0];
  upsertConversation(msg, existing, {
    routing_state: 'AWAITING_CODE' as RoutingState,
    wedding_id: wedding.id,
  });

  return {
    resolved: false,
    replyText:
      `Assalamualaikum! 👋 Selamat datang ke ${wedding.title}.\n\n` +
      `Sila hantar *PIN 4 digit* yang tertera pada kad jemputan digital anda untuk mengenal pasti anda.`,
  };
}

// ── Step 2: Waiting for 4-digit PIN ──────────────────────────────────────────

async function handleAwaitingCode(
  msg: NormalisedInboundMessage,
  conversation: ConversationRecord,
): Promise<RouterResult> {
  const text = msg.text.trim();

  // GAP-A4: Check global PIN rate limit before processing
  if (isPinRateLimited(msg.chatId)) {
    return {
      resolved: false,
      replyText: 'Terlalu banyak percubaan PIN. Sila tunggu beberapa minit sebelum mencuba lagi. 🙏',
    };
  }

  // Guest says they don't have a PIN
  if (/^(tiada|tak ada|no|none|dont have|don'?t have|x ada|xde|tidak)/i.test(text)) {
    return handleNoPin(msg, conversation);
  }

  // Also accept the MJLS_XXXX format typed manually
  const normalizedForRef = text.replace(/[-\s]/g, '_').toUpperCase();
  const codeMatch = normalizedForRef.match(/MJLS_([A-Z0-9]{4,8})/);
  if (codeMatch) {
    const refCode = `MJLS_${codeMatch[1]}`;
    if (isValidRefCode(refCode)) {
      const hash = hashRefCode(refCode);
      const result = await lookupByHash('ref', hash);
      if (result) {
        const conv = upsertConversation(msg, conversation, {
          routing_state: 'RESOLVED' as RoutingState,
          wedding_id: result.weddingId,
          invite_group_id: result.inviteGroupId,
        });
        return {
          resolved: true,
          context: { conversation: conv, weddingId: result.weddingId, inviteGroupId: result.inviteGroupId },
        };
      }
    }
  }

  // Extract exactly 4 digits
  const digits = text.replace(/\D/g, '');
  if (digits.length !== 4) {
    return {
      resolved: false,
      replyText:
        'PIN tidak sah. PIN anda adalah *4 digit* yang tertera pada kad jemputan digital anda. ' +
        'Taip *tiada* jika anda tidak mempunyai kad jemputan.',
    };
  }

  // GAP-A4: Record this PIN attempt
  recordPinAttempt(msg.chatId);

  // Hash and look up via majlis API
  const pinHash = hashChatPin(digits);
  const result = await lookupByHash('pin', pinHash);

  if (!result) {
    const attempts = conversation.pin_attempts ?? 0;

    if (attempts >= 1) {
      return handleNoPin(msg, conversation);
    }

    upsertConversation(msg, conversation, { pin_attempts: attempts + 1 });
    return {
      resolved: false,
      replyText:
        'PIN tidak ditemui. Sila semak semula PIN pada kad jemputan digital anda dan cuba lagi, ' +
        'atau taip *tiada* jika anda tidak mempunyai kad jemputan.',
    };
  }

  // PIN matched — resolve
  const conv = upsertConversation(msg, conversation, {
    routing_state: 'RESOLVED' as RoutingState,
    wedding_id: result.weddingId,
    invite_group_id: result.inviteGroupId,
  });

  return {
    resolved: true,
    context: { conversation: conv, weddingId: result.weddingId, inviteGroupId: result.inviteGroupId },
  };
}

// ── Graceful fallback: guest has no PIN ───────────────────────────────────────

async function handleNoPin(
  msg: NormalisedInboundMessage,
  conversation: ConversationRecord,
): Promise<RouterResult> {
  upsertConversation(msg, conversation, { routing_state: 'UNKNOWN' as RoutingState });

  if (conversation.wedding_id) {
    await createTicket({
      weddingId: conversation.wedding_id,
      conversationId: conversation.id,
      type: 'UNKNOWN_SENDER',
      details: {
        description: `Guest could not be identified via PIN. Sender: ${msg.senderName ?? 'Unknown'} (chat_id: ${msg.chatId})`,
        sender_name: msg.senderName,
        chat_id: msg.chatId,
      },
    });
  }

  return {
    resolved: false,
    replyText: 'Tidak mengapa! 😊 Kami telah maklumkan tuan rumah dan mereka akan menghubungi anda tidak lama lagi.',
  };
}

// ── Wedding selection (multi-wedding setups only) ─────────────────────────────

async function handleAwaitingSelection(
  msg: NormalisedInboundMessage,
  conversation: ConversationRecord,
): Promise<RouterResult> {
  const options = (conversation.metadata as Record<string, unknown>)?.wedding_options as string[] | undefined;

  if (!options) {
    upsertConversation(msg, conversation, { routing_state: 'UNKNOWN' as RoutingState });
    return handleUnknown(msg, conversation);
  }

  const num = parseInt(msg.text.trim(), 10);
  if (isNaN(num) || num < 1 || num > options.length) {
    return { resolved: false, replyText: `Sila pilih nombor antara 1 hingga ${options.length}.` };
  }

  // Phone-matched selection: resolve directly without PIN
  const phoneMatches = (conversation.metadata as Record<string, unknown>)?.phone_matches as
    | Array<{ weddingId: string; inviteGroupId: string }>
    | undefined;

  if (phoneMatches && phoneMatches[num - 1]) {
    const match = phoneMatches[num - 1];
    const conv = upsertConversation(msg, conversation, {
      routing_state: 'RESOLVED' as RoutingState,
      wedding_id: match.weddingId,
      invite_group_id: match.inviteGroupId,
    });
    return {
      resolved: true,
      context: { conversation: conv, weddingId: match.weddingId, inviteGroupId: match.inviteGroupId },
    };
  }

  const weddingId = options[num - 1];
  upsertConversation(msg, conversation, {
    routing_state: 'AWAITING_CODE' as RoutingState,
    wedding_id: weddingId,
  });

  return {
    resolved: false,
    replyText: 'Terima kasih! Sila hantar *PIN 4 digit* yang tertera pada kad jemputan digital anda.',
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function upsertConversation(
  msg: NormalisedInboundMessage,
  existing: ConversationRecord | null,
  updates: Partial<ConversationRecord>,
): ConversationRecord {
  const db = getDb();
  const now = new Date().toISOString();

  let conv: ConversationRecord;

  if (existing) {
    db.prepare(`
      UPDATE conversations SET
        sender_name      = ?,
        routing_state    = ?,
        wedding_id       = ?,
        invite_group_id  = ?,
        pin_attempts     = ?,
        metadata         = ?,
        last_message_at  = ?,
        updated_at       = ?
      WHERE id = ?
    `).run(
      msg.senderName || existing.sender_name,
      updates.routing_state ?? existing.routing_state,
      updates.wedding_id !== undefined ? updates.wedding_id : existing.wedding_id,
      updates.invite_group_id !== undefined ? updates.invite_group_id : existing.invite_group_id,
      updates.pin_attempts !== undefined ? updates.pin_attempts : existing.pin_attempts,
      updates.metadata !== undefined
        ? JSON.stringify(updates.metadata)
        : JSON.stringify(existing.metadata ?? {}),
      now,
      now,
      existing.id,
    );

    conv = parseRow(
      db.prepare<string, Record<string, unknown>>('SELECT * FROM conversations WHERE id = ?').get(existing.id)!,
    );
  } else {
    const id = randomUUID();
    db.prepare(`
      INSERT INTO conversations
        (id, channel, chat_id, sender_id, sender_name, routing_state, wedding_id, invite_group_id, pin_attempts, metadata, last_message_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      msg.channel,
      msg.chatId,
      msg.senderId || null,
      msg.senderName || null,
      updates.routing_state ?? 'UNKNOWN',
      updates.wedding_id ?? null,
      updates.invite_group_id ?? null,
      updates.pin_attempts ?? 0,
      JSON.stringify(updates.metadata ?? {}),
      now,
      now,
      now,
    );

    conv = parseRow(
      db.prepare<string, Record<string, unknown>>('SELECT * FROM conversations WHERE id = ?').get(id)!,
    );
  }

  // GAP-R2 CLOSED: Sync to Supabase with retry (fire-and-forget but with backoff)
  withRetry(
    () =>
      syncConversation({
        id: conv.id,
        channel: conv.channel,
        chatId: conv.chat_id,
        senderId: conv.sender_id,
        senderName: conv.sender_name,
        routingState: conv.routing_state,
        weddingId: conv.wedding_id,
        inviteGroupId: conv.invite_group_id,
        metadata: (conv.metadata as Record<string, unknown>) ?? {},
        lastMessageAt: conv.last_message_at,
      }),
    { maxAttempts: 3, initialDelayMs: 1000, isRetryable: isRetryableHttpError },
  ).catch((err) => {
    log.warn({ err, conversationId: conv.id }, 'Conversation sync to Supabase failed after retries (non-fatal)');
  });

  return conv;
}
