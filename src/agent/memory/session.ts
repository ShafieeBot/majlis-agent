/**
 * Session Manager — Rolling conversation window with LLM summarization.
 *
 * When a conversation exceeds MAX_TURNS messages, older messages are
 * compressed into a summary stored in agent_memory with
 * note_type='conversation_summary'. The summary is prepended to the
 * system prompt for continuity.
 *
 * Flow:
 * 1. loadSession() — fetches recent messages + any existing summary (SQLite)
 * 2. After agent response, check if compression is needed
 * 3. compressSession() — summarise old turns via LLM (Haiku for cost)
 * 4. saveSessionSummary() — upsert the summary into SQLite agent_memory
 */

import { randomUUID } from 'crypto';
import { getDb } from '@/lib/db';
import type { MessageRecord, AgentNoteRecord } from '../types';

const MAX_TURNS = 36; // ~18 back-and-forth exchanges
const KEEP_RECENT = 20; // Keep the 20 most recent messages after compression

export interface SessionData {
  messages: MessageRecord[];
  summary: string | null;
}

/**
 * Load the session for a conversation: recent messages + any existing summary.
 */
export function loadSession(
  conversationId: string,
  weddingId: string,
  inviteGroupId: string | null,
): SessionData {
  const db = getDb();

  const msgRows = db
    .prepare<[string, number], Record<string, unknown>>(
      `SELECT * FROM messages
       WHERE conversation_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(conversationId, MAX_TURNS + 10) as Record<string, unknown>[];

  const messages: MessageRecord[] = msgRows.reverse().map((r) => ({
    id: r.id as string,
    conversation_id: r.conversation_id as string,
    direction: r.direction as 'IN' | 'OUT',
    status: r.status as MessageRecord['status'],
    intent: r.intent as MessageRecord['intent'],
    content: r.content as string,
    platform_message_id: r.platform_message_id as string | null,
    metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata ?? null),
    created_at: r.created_at as string,
  }));

  // Load most recent conversation summary for this invite group
  const summaryRow = inviteGroupId
    ? db
        .prepare<[string, string], Record<string, unknown>>(
          `SELECT * FROM agent_memory
           WHERE wedding_id = ? AND invite_group_id = ? AND note_type = 'conversation_summary'
           ORDER BY updated_at DESC LIMIT 1`,
        )
        .get(weddingId, inviteGroupId)
    : db
        .prepare<[string], Record<string, unknown>>(
          `SELECT * FROM agent_memory
           WHERE wedding_id = ? AND invite_group_id IS NULL AND note_type = 'conversation_summary'
           ORDER BY updated_at DESC LIMIT 1`,
        )
        .get(weddingId);

  const summaryNote = summaryRow as AgentNoteRecord | undefined;

  return {
    messages,
    summary: summaryNote?.content ?? null,
  };
}

/**
 * Check if the session needs compression.
 */
export function needsCompression(messageCount: number): boolean {
  return messageCount > MAX_TURNS;
}

/**
 * Compress older messages into a summary using an LLM call.
 * Returns the summary text.
 */
export async function compressSession(
  messages: MessageRecord[],
  existingSummary: string | null,
): Promise<string> {
  const olderMessages = messages.slice(0, messages.length - KEEP_RECENT);

  if (olderMessages.length === 0) return existingSummary ?? '';

  const transcript = olderMessages
    .map((m) => {
      const role = m.direction === 'IN' ? 'Guest' : 'Agent';
      return `${role}: ${m.content}`;
    })
    .join('\n');

  const prompt = existingSummary
    ? `Previous conversation summary:\n${existingSummary}\n\nNew messages to incorporate:\n${transcript}\n\nProvide an updated conversation summary in 2-3 sentences. Focus on key facts: what the guest asked about, any preferences mentioned, RSVP details, and important context for future interactions.`
    : `Conversation transcript:\n${transcript}\n\nProvide a conversation summary in 2-3 sentences. Focus on key facts: what the guest asked about, any preferences mentioned, RSVP details, and important context for future interactions.`;

  try {
    const { chatCompletion } = await import('../loop/llm-client');
    const response = await chatCompletion(
      [
        {
          role: 'system',
          content: 'You are a conversation summarizer. Be concise and factual. Output only the summary, nothing else.',
        },
        { role: 'user', content: prompt },
      ],
      undefined,
      { temperature: 0.3, maxTokens: 300 },
    );

    return response.content || existingSummary || '';
  } catch (err) {
    console.error('Session compression failed:', err);
    return existingSummary || `Previous conversation covered ${olderMessages.length} messages.`;
  }
}

/**
 * Save or update the conversation summary in SQLite agent_memory.
 */
export function saveSessionSummary(
  weddingId: string,
  inviteGroupId: string | null,
  summaryContent: string,
): void {
  const db = getDb();
  const now = new Date().toISOString();

  const existing = inviteGroupId
    ? db
        .prepare<[string, string], { id: string }>(
          `SELECT id FROM agent_memory
           WHERE wedding_id = ? AND invite_group_id = ? AND note_type = 'conversation_summary'
           LIMIT 1`,
        )
        .get(weddingId, inviteGroupId)
    : db
        .prepare<[string], { id: string }>(
          `SELECT id FROM agent_memory
           WHERE wedding_id = ? AND invite_group_id IS NULL AND note_type = 'conversation_summary'
           LIMIT 1`,
        )
        .get(weddingId);

  if (existing) {
    db.prepare('UPDATE agent_memory SET content = ?, updated_at = ? WHERE id = ?').run(
      summaryContent,
      now,
      existing.id,
    );
  } else {
    db.prepare(`
      INSERT INTO agent_memory (id, wedding_id, invite_group_id, note_type, content, source, created_at, updated_at)
      VALUES (?, ?, ?, 'conversation_summary', ?, 'system', ?, ?)
    `).run(randomUUID(), weddingId, inviteGroupId, summaryContent, now, now);
  }
}
