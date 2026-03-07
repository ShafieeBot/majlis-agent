// ─────────────────────────────────────────────────────────────────────────────
// Central type definitions for the Majlis agent system.
// ─────────────────────────────────────────────────────────────────────────────

// ── Routing ───────────────────────────────────────────────────────────────────

export type RoutingState =
  | 'RESOLVED'
  | 'NEEDS_SELECTION'
  | 'AWAITING_SELECTION'
  | 'AWAITING_PHONE'
  | 'AWAITING_CODE'
  | 'UNKNOWN';

// ── Database records ──────────────────────────────────────────────────────────

export interface ConversationRecord {
  id: string;
  channel: string;
  chat_id: string;
  sender_id: string | null;
  sender_name: string | null;
  wedding_id: string | null;
  invite_group_id: string | null;
  routing_state: RoutingState;
  pin_attempts: number;
  metadata: Record<string, unknown> | null;
  last_message_at: string;
  created_at: string;
  updated_at: string;
}

export type MessageIntent =
  | 'GENERAL'
  | 'RSVP'
  | 'DIETARY'
  | 'VENUE'
  | 'SCHEDULE'
  | 'ESCALATION';

export interface MessageRecord {
  id: string;
  conversation_id: string;
  direction: 'IN' | 'OUT';
  status: 'RECEIVED' | 'DRAFT' | 'SENT' | 'FAILED' | 'DISCARDED';
  intent: MessageIntent | null;
  content: string;
  platform_message_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export type NoteType =
  | 'preference'
  | 'dietary'
  | 'important_detail'
  | 'conversation_summary';

export type NoteSource = 'agent' | 'admin' | 'system';

export interface AgentNoteRecord {
  id: string;
  wedding_id: string;
  invite_group_id: string | null;
  note_type: NoteType;
  content: string;
  source: NoteSource;
  created_at: string;
  updated_at: string;
}

export interface AgentPolicyRecord {
  id: string;
  wedding_id: string;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  quiet_hours_timezone: string;
  blocked_tools: string[];
  system_prompt_override: string | null;
  created_at: string;
  updated_at: string;
}

export type TicketType =
  | 'EXTRA_PAX'
  | 'RSVP_CHANGE_REQUEST'
  | 'DIETARY_CHANGE'
  | 'UNKNOWN_SENDER'
  | 'COMPLAINT'
  | 'GENERAL_INQUIRY'
  | 'ESCALATION'
  | 'SYSTEM_ERROR';

export type TicketStatus =
  | 'OPEN'
  | 'IN_PROGRESS'
  | 'RESOLVED'
  | 'DISMISSED';

export interface ExceptionTicketRecord {
  id: string;
  conversation_id: string | null;
  wedding_id: string;
  invite_group_id: string | null;
  type: TicketType;
  status: TicketStatus;
  details: Record<string, unknown>;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

// ── Agent context (assembled at runtime, not a DB row) ────────────────────────

export interface RoutedContext {
  conversation: ConversationRecord;
  weddingId: string;
  inviteGroupId: string;
}

export interface AgentContext {
  conversation: ConversationRecord;
  wedding: {
    id: string;
    title: string;
    bride_name: string;
    groom_name: string;
    hashtag: string | null;
    instagram_handle: string | null;
  };
  inviteGroup: {
    id: string;
    group_name: string;
    max_pax_allowed: number;
    contact_name: string | null;
    contact_phone: string | null;
    tags: string[];
  };
  events: Array<{
    id: string;
    name: string;
    date: string | null;
    start_time: string | null;
    end_time: string | null;
    venue_name: string | null;
    venue_address: string | null;
    rsvp_status: string | null;
    confirmed_pax: number;
    table_number: number | null;
  }>;
  notes: AgentNoteRecord[];
  policy: AgentPolicyRecord;
  recentMessages: MessageRecord[];
  isQuietHours: boolean;
}

// ── LLM / tool types ──────────────────────────────────────────────────────────

export type ToolSideEffect = 'read' | 'write' | 'external';

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface LLMResponse {
  content: string | null;
  tool_calls: ToolCall[] | null;
  finish_reason: string;
}
