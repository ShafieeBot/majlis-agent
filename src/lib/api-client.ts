/**
 * HTTP client for the majlis Next.js app API.
 * All data reads (guests, weddings, RSVPs, policy) and business writes (RSVPs, tickets)
 * go through here. The agent never touches Supabase directly.
 */

import type { AgentPolicyRecord, TicketType } from '@/agent/types';

function getBaseUrl(): string {
  const url = process.env.APP_URL;
  if (!url) throw new Error('APP_URL env var is not set');
  return url.replace(/\/$/, '');
}

function getSecret(): string {
  return process.env.AGENT_SERVICE_SECRET ?? '';
}

async function apiRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${getBaseUrl()}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-agent-secret': getSecret(),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`majlis API ${method} ${path} → ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

// ── Context ────────────────────────────────────────────────────────────────────

export interface RsvpData {
  event_id: string;
  status: string;
  confirmed_pax: number;
  dietary_notes: string | null;
  guest_names: string[] | null;
}

export interface TableAssignmentData {
  event_id: string;
  table_number: number | null;
}

export interface AgentContextPayload {
  inviteGroup: {
    id: string;
    group_name: string;
    max_pax_allowed: number;
    contact_name: string | null;
    contact_phone: string | null;
    tags: string[];
    notes: string | null;
  } | null;
  rsvps: RsvpData[];
  tableAssignments: TableAssignmentData[];
  wedding: {
    id: string;
    title: string;
    bride_name: string;
    groom_name: string;
    hashtag: string | null;
    instagram_handle: string | null;
  } | null;
  events: Array<{
    id: string;
    name: string;
    date: string | null;
    start_time: string | null;
    end_time: string | null;
    venue_name: string | null;
    venue_address: string | null;
  }>;
  policy: AgentPolicyRecord | null;
}

export async function getAgentContext(
  weddingId: string,
  inviteGroupId: string,
): Promise<AgentContextPayload> {
  const params = new URLSearchParams({ weddingId, inviteGroupId });
  return apiRequest<AgentContextPayload>('GET', `/api/agent/context?${params}`);
}

export interface LookupResult {
  inviteGroupId: string;
  weddingId: string;
}

export async function lookupByHash(
  type: 'pin' | 'ref',
  hash: string,
): Promise<LookupResult | null> {
  const params = new URLSearchParams({ type, hash });
  const res = await fetch(
    `${getBaseUrl()}/api/agent/context/lookup?${params}`,
    { headers: { 'x-agent-secret': getSecret() } },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`lookup failed: ${res.status}`);
  return res.json() as Promise<LookupResult>;
}

export async function lookupByPhone(phone: string): Promise<LookupResult[]> {
  const params = new URLSearchParams({ type: 'phone', phone });
  const res = await fetch(
    `${getBaseUrl()}/api/agent/context/lookup?${params}`,
    { headers: { 'x-agent-secret': getSecret() } },
  );
  if (!res.ok) throw new Error(`phone lookup failed: ${res.status}`);
  const data = (await res.json()) as { matches: LookupResult[] };
  return data.matches;
}

export async function listWeddings(): Promise<{ id: string; title: string }[]> {
  return apiRequest<{ id: string; title: string }[]>('GET', '/api/agent/context/weddings');
}

// ── RSVPs ──────────────────────────────────────────────────────────────────────

export interface RsvpUpdatePayload {
  weddingId: string;
  inviteGroupId: string;
  eventUpdates: Array<{
    eventId?: string;
    eventName?: string;
    status: string;
    confirmedPax: number;
    dietaryNotes?: string | null;
  }>;
}

export interface RsvpUpdateResult {
  success: boolean;
  updated: Array<{ eventId: string; status: string; confirmedPax: number }>;
}

export async function upsertRsvp(payload: RsvpUpdatePayload): Promise<RsvpUpdateResult> {
  return apiRequest<RsvpUpdateResult>('POST', '/api/agent/rsvp', payload);
}

// ── Tickets ────────────────────────────────────────────────────────────────────

export interface CreateTicketPayload {
  weddingId: string;
  conversationId: string;
  inviteGroupId?: string | null;
  type: TicketType;
  details: Record<string, unknown>;
}

export async function createTicket(payload: CreateTicketPayload): Promise<{ ticketId: string }> {
  return apiRequest<{ ticketId: string }>('POST', '/api/agent/tickets', payload);
}

// ── Conversation Sync ─────────────────────────────────────────────────────────

export interface SyncConversationPayload {
  id: string;
  channel: string;
  chatId: string;
  senderId: string | null;
  senderName: string | null;
  routingState: string;
  weddingId: string | null;
  inviteGroupId: string | null;
  metadata: Record<string, unknown>;
  lastMessageAt: string;
}

export async function syncConversation(payload: SyncConversationPayload): Promise<void> {
  await apiRequest<{ conversationId: string }>('POST', '/api/agent/conversations', payload);
}

// ── Heartbeat ──────────────────────────────────────────────────────────────────

export interface StaleTicket {
  id: string;
  wedding_id: string;
  type: string;
  details: Record<string, unknown>;
  created_at: string;
}

export async function getStaleTickets(): Promise<StaleTicket[]> {
  return apiRequest<StaleTicket[]>('GET', '/api/agent/stale-tickets');
}
