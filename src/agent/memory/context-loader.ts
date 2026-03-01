/**
 * Context loader — loads all required context for the agent handler.
 *
 * Business data (wedding, events, invite group, RSVPs, tables, policy) comes
 * from the majlis API via a single getAgentContext() call.
 * Agent memory (notes, recent messages) is loaded from local SQLite.
 */

import { getAgentContext } from '@/lib/api-client';
import { getDb } from '@/lib/db';
import { isQuietHours } from '../skills/policy';
import type { AgentContext, ConversationRecord, MessageRecord, AgentPolicyRecord, AgentNoteRecord } from '../types';

const DEFAULT_POLICY: AgentPolicyRecord = {
  id: '',
  wedding_id: '',
  quiet_hours_start: null,
  quiet_hours_end: null,
  quiet_hours_timezone: 'Asia/Brunei',
  blocked_tools: [],
  system_prompt_override: null,
  created_at: '',
  updated_at: '',
};

const RECENT_MESSAGES_LIMIT = 20;
const NOTES_LIMIT = 20;

/**
 * Load the full agent context for a resolved conversation.
 * Business data → majlis API. Memory → SQLite.
 */
export async function loadAgentContext(
  conversation: ConversationRecord,
  weddingId: string,
  inviteGroupId: string,
): Promise<AgentContext> {
  const db = getDb();

  // ── Business data from majlis API ──────────────────────────────────────────

  const payload = await getAgentContext(weddingId, inviteGroupId);

  // ── Agent memory from SQLite ───────────────────────────────────────────────

  // Notes scoped to this wedding and invite group (include global wedding notes too)
  const notesRows = db
    .prepare<[string, string, number], Record<string, unknown>>(
      `SELECT * FROM agent_memory
       WHERE wedding_id = ? AND (invite_group_id IS NULL OR invite_group_id = ?)
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(weddingId, inviteGroupId, NOTES_LIMIT) as Record<string, unknown>[];

  const notes: AgentNoteRecord[] = notesRows.map((r) => ({
    id: r.id as string,
    wedding_id: r.wedding_id as string,
    invite_group_id: r.invite_group_id as string | null,
    note_type: r.note_type as AgentNoteRecord['note_type'],
    content: r.content as string,
    source: r.source as AgentNoteRecord['source'],
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  }));

  // Recent messages for this conversation
  const msgRows = db
    .prepare<[string, number], Record<string, unknown>>(
      `SELECT * FROM messages
       WHERE conversation_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(conversation.id, RECENT_MESSAGES_LIMIT) as Record<string, unknown>[];

  const recentMessages: MessageRecord[] = msgRows
    .reverse()
    .map((r) => ({
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

  // ── Build RSVP/table lookup maps ───────────────────────────────────────────

  const rsvpMap = new Map(payload.rsvps.map((r) => [r.event_id, r]));
  const tableMap = new Map(payload.tableAssignments.map((t) => [t.event_id, t.table_number]));

  const policy: AgentPolicyRecord = payload.policy
    ? payload.policy
    : { ...DEFAULT_POLICY, wedding_id: weddingId };

  const wedding = payload.wedding;
  const group = payload.inviteGroup;

  if (!wedding) throw new Error(`Wedding ${weddingId} not found in context API response`);
  if (!group) throw new Error(`Invite group ${inviteGroupId} not found in context API response`);

  return {
    conversation,
    wedding: {
      id: wedding.id,
      title: wedding.title,
      bride_name: wedding.bride_name,
      groom_name: wedding.groom_name,
      hashtag: wedding.hashtag,
      instagram_handle: wedding.instagram_handle,
    },
    inviteGroup: {
      id: group.id,
      group_name: group.group_name,
      max_pax_allowed: group.max_pax_allowed,
      contact_name: group.contact_name,
      contact_phone: group.contact_phone,
      tags: group.tags ?? [],
    },
    events: payload.events.map((e) => {
      const rsvp = rsvpMap.get(e.id);
      return {
        id: e.id,
        name: e.name,
        date: e.date,
        start_time: e.start_time,
        end_time: e.end_time,
        venue_name: e.venue_name,
        venue_address: e.venue_address,
        rsvp_status: rsvp?.status ?? null,
        confirmed_pax: rsvp?.confirmed_pax ?? 0,
        table_number: tableMap.get(e.id) ?? null,
      };
    }),
    notes,
    policy,
    recentMessages,
    isQuietHours: isQuietHours(new Date(), policy),
  };
}
