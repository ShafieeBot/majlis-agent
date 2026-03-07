/**
 * Conversation Router — State machine that resolves which wedding + invite group
 * a conversation belongs to. Runs BEFORE the agent runner.
 *
 * Identification flow for unknown guests:
 *   1. UNKNOWN → ask for 4-digit chat PIN (shown on invite card) → AWAITING_CODE
 *   2. AWAITING_CODE → hash PIN, match via majlis API → RESOLVED
 *                   → no match → retry once, then graceful "we'll let the host know"
 *
 * Guests can also tap the Telegram deep-link button (/start MJLS_XXXX) which
 * resolves immediately without typing anything.
 *
 * Pre-Resolution Firewall: If routing_state !== RESOLVED, the agent runner
 * is NEVER invoked.
 */

import { randomUUID } from 'crypto';
import { getDb } from '@/lib/db';
import { lookupByHash, lookupByPhone, listWeddings, createTicket } from '@/lib/api-client';
import { hashRefCode, isValidRefCode, hashChatPin } from './ref-code';
import type { NormalisedInboundMessage } from '../gateway/types';
import type { ConversationRecord, RoutedContext, RoutingState } from '../types';

export interface RouterResult {
  resolved: boolean;
  context?: RoutedContext;
  replyText?: string;
}

// Parse a raw SQLite row into ConversationRecord (metadata is stored as a JSON string)
function parseRow(row: Record<string, unknown>): ConversationRecord {
  return {
    ...row,
    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata ?? null),
  } as ConversationRecord;
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
        // Single match → resolve immediately, no PIN needed
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
        // Multiple matches → show only matched weddings, skip PIN after selection
        const weddings = await listWeddings();
        const matchedWeddings = phoneMatches
          .map((m) => {
            const w = weddings.find((w) => w.id === m.weddingId);
            return w ? { ...w, inviteGroupId: m.inviteGroupId } : null;
          })
          .filter(Boolean) as Array<{ id: string; title: string; inviteGroupId: string }>;

        if (matchedWeddings.length === 1) {
          // After filtering, only one active wedding remains
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
      // Phone lookup failed — fall through to standard flow
      console.error('[Router] Phone lookup failed, falling back to PIN flow:', err);
    }
  }

  // Standard flow: list all weddings and ask for PIN
  const weddings = await listWeddings();

  if (!weddings || weddings.length === 0) {
    return { resolved: false, replyText: 'Maaf, tiada majlis aktif pada masa ini.' };
  }

  // Multiple weddings — ask guest to pick one, then ask for PIN
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

  // Hash and look up via majlis API
  const pinHash = hashChatPin(digits);
  const result = await lookupByHash('pin', pinHash);

  if (!result) {
    // Wrong PIN — check how many attempts have been made
    const attempts = conversation.pin_attempts ?? 0;

    if (attempts >= 1) {
      // Second failure → graceful fallback
      return handleNoPin(msg, conversation);
    }

    // First failure → let them try once more
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

  // Standard flow: ask for PIN after selection
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

    return parseRow(
      db.prepare<string, Record<string, unknown>>('SELECT * FROM conversations WHERE id = ?').get(existing.id)!,
    );
  }

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

  return parseRow(
    db.prepare<string, Record<string, unknown>>('SELECT * FROM conversations WHERE id = ?').get(id)!,
  );
}
