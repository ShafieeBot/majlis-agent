/**
 * Zod schemas for webhook payload validation.
 *
 * GAP-I1 CLOSED: All inbound payloads are validated against strict schemas
 * before being processed, preventing malformed data from reaching the handler.
 */

import { z } from 'zod';

// ── Telegram Update schema ──────────────────────────────────────────────────

const TelegramUserSchema = z.object({
  id: z.number(),
  first_name: z.string(),
  last_name: z.string().optional(),
  username: z.string().optional(),
});

const TelegramChatSchema = z.object({
  id: z.number(),
  type: z.string(),
});

const TelegramMessageSchema = z.object({
  message_id: z.number(),
  from: TelegramUserSchema.optional(),
  chat: TelegramChatSchema,
  date: z.number(),
  text: z.string().optional(),
  reply_to_message: z
    .object({ message_id: z.number() })
    .optional(),
  // Unsupported content types — just check presence
  photo: z.array(z.unknown()).optional(),
  video: z.unknown().optional(),
  sticker: z.unknown().optional(),
  voice: z.unknown().optional(),
  document: z.unknown().optional(),
});

export const TelegramUpdateSchema = z.object({
  update_id: z.number(),
  message: TelegramMessageSchema.optional(),
});

export type TelegramUpdate = z.infer<typeof TelegramUpdateSchema>;

// ── WhatsApp Cloud API webhook schema ───────────────────────────────────────

const WAContactSchema = z.object({
  profile: z.object({ name: z.string() }),
  wa_id: z.string(),
});

const WATextMessageSchema = z.object({
  from: z.string(),
  id: z.string(),
  timestamp: z.string(),
  type: z.string(),
  text: z.object({ body: z.string() }).optional(),
  image: z.object({
    id: z.string(),
    mime_type: z.string(),
    sha256: z.string().optional(),
    caption: z.string().optional(),
  }).optional(),
});

const WAValueSchema = z.object({
  messaging_product: z.string(),
  metadata: z.object({
    display_phone_number: z.string(),
    phone_number_id: z.string(),
  }),
  contacts: z.array(WAContactSchema).optional(),
  messages: z.array(WATextMessageSchema).optional(),
  statuses: z.array(z.unknown()).optional(),
});

const WAChangeSchema = z.object({
  value: WAValueSchema,
  field: z.string(),
});

const WAEntrySchema = z.object({
  id: z.string(),
  changes: z.array(WAChangeSchema),
});

export const WAWebhookPayloadSchema = z.object({
  object: z.string(),
  entry: z.array(WAEntrySchema),
});

export type WAWebhookPayload = z.infer<typeof WAWebhookPayloadSchema>;

// ── Admin send body schema ──────────────────────────────────────────────────

export const AdminSendBodySchema = z.object({
  chatId: z.string().optional(),
  inviteGroupId: z.string().optional(),
  channel: z.string().default('telegram'),
  content: z.string().min(1, 'content is required'),
});

export type AdminSendBody = z.infer<typeof AdminSendBodySchema>;
