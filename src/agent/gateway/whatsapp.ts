/**
 * WhatsApp Cloud API channel adapter.
 * Parses Meta webhook payloads into NormalisedInboundMessages
 * and sends outbound messages via the WhatsApp Cloud API.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import type { ChannelAdapter, NormalisedInboundMessage, NormalisedOutboundMessage } from './types';
import { withRetry, isRetryableHttpError } from '@/lib/retry';

// ── Meta Cloud API webhook payload types ─────────────────────────────────────

interface WAContact {
  profile: { name: string };
  wa_id: string;
}

interface WATextMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
}

interface WAValue {
  messaging_product: string;
  metadata: { display_phone_number: string; phone_number_id: string };
  contacts?: WAContact[];
  messages?: WATextMessage[];
  statuses?: unknown[];
}

interface WAChange {
  value: WAValue;
  field: string;
}

interface WAEntry {
  id: string;
  changes: WAChange[];
}

interface WAWebhookPayload {
  object: string;
  entry: WAEntry[];
}

// ── Adapter ──────────────────────────────────────────────────────────────────

export class WhatsAppAdapter implements ChannelAdapter {
  readonly channel = 'whatsapp';

  private phoneNumberId: string;
  private accessToken: string;
  private appSecret: string;

  constructor(phoneNumberId: string, accessToken: string, appSecret: string) {
    this.phoneNumberId = phoneNumberId;
    this.accessToken = accessToken;
    this.appSecret = appSecret;
  }

  /**
   * Validate the Meta webhook signature using X-Hub-Signature-256 header.
   * Note: In the proxy architecture, signature validation happens at the
   * Next.js layer. This method is available for direct webhook setups.
   */
  async validateWebhook(request: Request): Promise<boolean> {
    const signature = request.headers.get('x-hub-signature-256');
    if (!signature) return false;

    const body = await request.text();
    const expectedSig = 'sha256=' + createHmac('sha256', this.appSecret).update(body).digest('hex');

    try {
      const a = Buffer.from(signature);
      const b = Buffer.from(expectedSig);
      return a.length === b.length && timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  /**
   * Parse a Meta Cloud API webhook payload into a NormalisedInboundMessage.
   * Returns null if the payload is not a processable message (e.g. status updates).
   */
  parseInbound(rawPayload: unknown): NormalisedInboundMessage | null {
    const payload = rawPayload as WAWebhookPayload;

    if (payload.object !== 'whatsapp_business_account') return null;

    const entry = payload.entry?.[0];
    if (!entry) return null;

    const change = entry.changes?.[0];
    if (!change || change.field !== 'messages') return null;

    const value = change.value;

    // Status updates (delivered, read, etc.) — ignore
    if (!value.messages || value.messages.length === 0) return null;

    const msg = value.messages[0];
    const contact = value.contacts?.[0];
    const senderName = contact?.profile?.name;

    // Handle non-text message types (image, video, audio, document, sticker, location, etc.)
    if (msg.type !== 'text') {
      return {
        channel: 'whatsapp',
        chatId: msg.from,
        senderId: msg.from,
        senderName,
        text: '[unsupported_content]',
        timestamp: new Date(parseInt(msg.timestamp, 10) * 1000),
        rawPayload,
        metadata: {},
      };
    }

    const text = msg.text?.body;
    if (!text) return null;

    return {
      channel: 'whatsapp',
      chatId: msg.from,
      senderId: msg.from,
      senderName,
      text,
      timestamp: new Date(parseInt(msg.timestamp, 10) * 1000),
      rawPayload,
      metadata: {},
    };
  }

  /**
   * Send a text message via the WhatsApp Cloud API.
   */
  async sendMessage(msg: NormalisedOutboundMessage): Promise<{ messageId: string }> {
    return withRetry(
      async () => {
        const url = `https://graph.facebook.com/v21.0/${this.phoneNumberId}/messages`;

        const body = {
          messaging_product: 'whatsapp',
          to: msg.chatId,
          type: 'text',
          text: { body: msg.text },
        };

        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.accessToken}`,
          },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const errBody = await res.text();
          if (res.status === 401 || errBody.includes('OAuthException')) {
            console.error('[WhatsApp] Access token expired or invalid. Generate a new one at https://developers.facebook.com');
          }
          throw new Error(`WhatsApp API error ${res.status}: ${errBody}`);
        }

        const data = (await res.json()) as { messages?: Array<{ id: string }> };
        return { messageId: data.messages?.[0]?.id ?? '' };
      },
      { maxAttempts: 3, initialDelayMs: 500, isRetryable: isRetryableHttpError },
    );
  }
}

/**
 * Create a WhatsAppAdapter from environment variables.
 */
export function createWhatsAppAdapter(): WhatsAppAdapter {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const appSecret = process.env.WHATSAPP_APP_SECRET ?? '';

  if (!phoneNumberId) throw new Error('WHATSAPP_PHONE_NUMBER_ID is not set');
  if (!accessToken) throw new Error('WHATSAPP_ACCESS_TOKEN is not set');

  return new WhatsAppAdapter(phoneNumberId, accessToken, appSecret);
}
