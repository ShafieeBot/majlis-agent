/**
 * Tool registry: all available tools for the agent.
 * READ tools retrieve wedding/event/guest data from the context already loaded.
 * WRITE tools call the majlis API or write to local SQLite.
 * EXTERNAL tools send messages (subject to policy gates).
 */

import { z } from 'zod';
import { upsertRsvp, createTicket, submitMemory } from '@/lib/api-client';
import { createNote } from '../memory/notes-manager';
import { retrievePendingMedia } from '../gateway/pending-media-store';
import type { ToolDefinition, ToolContext } from './types';

// ── READ Tools ──

const getWeddingInfo: ToolDefinition = {
  name: 'get_wedding_info',
  description: 'Get wedding details including bride/groom names, title, hashtag, and Instagram handle.',
  inputSchema: z.object({}),
  sideEffect: 'read',
  requiresScope: { weddingId: true },
  async execute(_input: unknown, ctx: ToolContext) {
    return ctx.agentContext?.wedding ?? { error: 'Wedding data not loaded' };
  },
};

const getEventInfo: ToolDefinition = {
  name: 'get_event_info',
  description: 'Get details for all events in this wedding including date, time, venue, and address.',
  inputSchema: z.object({}),
  sideEffect: 'read',
  requiresScope: { weddingId: true },
  async execute(_input: unknown, ctx: ToolContext) {
    return ctx.agentContext?.events ?? [];
  },
};

const getInviteGroupContext: ToolDefinition = {
  name: 'get_invite_group_context',
  description: "Get the current guest's invite group details: name, max pax, RSVP status, confirmed pax, table assignments, and dietary notes.",
  inputSchema: z.object({}),
  sideEffect: 'read',
  requiresScope: { weddingId: true, inviteGroupId: true },
  async execute(_input: unknown, ctx: ToolContext) {
    if (!ctx.inviteGroupId) return { error: 'No invite group in context' };

    const ac = ctx.agentContext;
    if (!ac) return { error: 'Agent context not loaded' };

    return {
      ...ac.inviteGroup,
      rsvps: ac.events.map((e) => ({
        event_id: e.id,
        event_name: e.name,
        status: e.rsvp_status,
        confirmed_pax: e.confirmed_pax,
        table_number: e.table_number,
      })),
    };
  },
};

// ── WRITE Tools ──

const createExceptionTicket: ToolDefinition = {
  name: 'create_exception_ticket',
  description:
    'Log a question or issue for the hosts to follow up on. Use when the guest asks something you cannot answer (e.g. whether they are invited to a specific event, parking details, dress code specifics), has a complaint, or needs a human response. After calling this tool, always tell the guest warmly that their question has been noted and the hosts will get back to them personally.',
  inputSchema: z.object({
    type: z
      .enum(['EXTRA_PAX', 'RSVP_CHANGE_REQUEST', 'DIETARY_CHANGE', 'UNKNOWN_SENDER', 'COMPLAINT', 'GENERAL_INQUIRY', 'ESCALATION', 'SYSTEM_ERROR'])
      .describe('The type of exception'),
    details: z
      .string()
      .describe("Full description of the guest's question or issue, including any relevant context"),
  }),
  sideEffect: 'write',
  requiresScope: { weddingId: true },
  async execute(input: unknown, ctx: ToolContext) {
    const { type, details } = input as { type: string; details: string };

    const result = await createTicket({
      weddingId: ctx.weddingId,
      conversationId: ctx.conversationId,
      inviteGroupId: ctx.inviteGroupId || null,
      type: type as Parameters<typeof createTicket>[0]['type'],
      details: { description: details },
    });

    return { ticket_id: result.ticketId, status: 'OPEN' };
  },
};

const updateRsvp: ToolDefinition = {
  name: 'update_rsvp',
  description:
    "Directly update a guest's RSVP status and/or confirmed pax count for a specific event. Only call this when the guest has clearly specified which event they mean. If the guest has not specified an event, use get_event_info first to list the events, then ask the guest which event(s) they are referring to before calling this tool. Changes are applied immediately — no approval needed.",
  inputSchema: z.object({
    event_id: z
      .string()
      .describe('Event UUID or event name (e.g. "Nikah", "Bersanding"). Must be a specific event — do NOT guess.'),
    status: z
      .enum(['attending', 'not_attending', 'pending'])
      .optional()
      .describe('New RSVP status'),
    confirmed_pax: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Number of people attending (must not exceed max_pax_allowed)'),
    dietary_notes: z.string().optional().describe('Any dietary requirements mentioned by the guest'),
  }),
  sideEffect: 'write',
  requiresScope: { weddingId: true, inviteGroupId: true },
  async execute(input: unknown, ctx: ToolContext) {
    if (!ctx.inviteGroupId) return { error: 'No invite group in context' };

    const { event_id, status, confirmed_pax, dietary_notes } = input as {
      event_id: string;
      status?: 'attending' | 'not_attending' | 'pending';
      confirmed_pax?: number;
      dietary_notes?: string;
    };

    const result = await upsertRsvp({
      weddingId: ctx.weddingId,
      inviteGroupId: ctx.inviteGroupId,
      eventUpdates: [
        {
          ...(event_id.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
            ? { eventId: event_id }
            : { eventName: event_id }),
          status: status ?? 'pending',
          confirmedPax: confirmed_pax ?? 0,
          dietaryNotes: dietary_notes,
        },
      ],
    });

    return { success: result.success, updated_events: result.updated };
  },
};

const saveAgentNote: ToolDefinition = {
  name: 'save_agent_note',
  description:
    'Save a memory note about this guest or wedding. Use when you learn important information like dietary preferences, language preference, or important details.',
  inputSchema: z.object({
    content: z.string().describe('The note content'),
    note_type: z.enum(['preference', 'dietary', 'important_detail']).describe('Type of note'),
  }),
  sideEffect: 'write',
  requiresScope: { weddingId: true },
  async execute(input: unknown, ctx: ToolContext) {
    const { content, note_type } = input as { content: string; note_type: string };

    const note = createNote({
      weddingId: ctx.weddingId,
      inviteGroupId: ctx.inviteGroupId || undefined,
      noteType: note_type as 'preference' | 'dietary' | 'important_detail',
      content,
      source: 'agent',
    });

    return { note_id: note.id };
  },
};

// ── MEMORY Tools ──

const submitPhoto: ToolDefinition = {
  name: 'submit_photo',
  description:
    'Submit a photo from the guest as a memory for the wedding gallery. Call this when the guest sends a photo to save, or when they confirm a previously sent photo should be saved. The photo is taken from the current message or from a recently sent photo in the conversation.',
  inputSchema: z.object({}),
  sideEffect: 'write',
  requiresScope: { weddingId: true, inviteGroupId: true },
  async execute(_input: unknown, ctx: ToolContext) {
    if (!ctx.inviteGroupId) return { error: 'No invite group in context' };

    // Try current message media first, then check pending store
    const media = ctx.pendingMedia ?? retrievePendingMedia(ctx.conversationId);
    if (!media) return { error: 'No photo available. The guest may need to resend the photo.' };

    const result = await submitMemory({
      weddingId: ctx.weddingId,
      inviteGroupId: ctx.inviteGroupId,
      photo: {
        buffer: media.buffer,
        mimeType: media.mimeType,
        filename: media.filename,
      },
    });

    return { success: result.ok, photo_uploaded: result.photo_uploaded };
  },
};

const submitGreeting: ToolDefinition = {
  name: 'submit_greeting',
  description:
    'Submit a greeting message from the guest for the wedding memories. Use this when the guest provides a greeting/wish for the bride and groom. Note: each guest can only have one greeting — calling this again will update the previous one.',
  inputSchema: z.object({
    message: z.string().describe('The greeting message from the guest for the bride and groom'),
  }),
  sideEffect: 'write',
  requiresScope: { weddingId: true, inviteGroupId: true },
  async execute(input: unknown, ctx: ToolContext) {
    if (!ctx.inviteGroupId) return { error: 'No invite group in context' };

    const { message } = input as { message: string };

    const result = await submitMemory({
      weddingId: ctx.weddingId,
      inviteGroupId: ctx.inviteGroupId,
      message,
    });

    return { success: result.ok, greeting_stored: result.greeting_stored };
  },
};

// ── Registry ──

export const ALL_TOOLS: ToolDefinition[] = [
  getWeddingInfo,
  getEventInfo,
  getInviteGroupContext,
  createExceptionTicket,
  updateRsvp,
  saveAgentNote,
  submitPhoto,
  submitGreeting,
];

/**
 * Get a tool by name from the registry.
 */
export function getToolByName(name: string): ToolDefinition | undefined {
  return ALL_TOOLS.find((t) => t.name === name);
}
