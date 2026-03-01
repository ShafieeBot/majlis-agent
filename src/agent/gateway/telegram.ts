/**
 * Telegram channel adapter.
 * Parses Telegram Update payloads into NormalisedInboundMessages
 * and sends outbound messages via the Telegram Bot API.
 */

import type { ChannelAdapter, NormalisedInboundMessage, NormalisedOutboundMessage } from './types';
import { withRetry, isRetryableHttpError } from '@/lib/retry';

// Telegram Update types (minimal subset we use)
interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  reply_to_message?: { message_id: number };
  // Unsupported content types
  photo?: unknown[];
  video?: unknown;
  sticker?: unknown;
  voice?: unknown;
  document?: unknown;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export class TelegramAdapter implements ChannelAdapter {
  readonly channel = 'telegram';

  private botToken: string;
  private webhookSecret: string;

  constructor(botToken: string, webhookSecret: string) {
    this.botToken = botToken;
    this.webhookSecret = webhookSecret;
  }

  /**
   * Validate the Telegram webhook request using the secret token header.
   */
  async validateWebhook(request: Request): Promise<boolean> {
    const secretHeader = request.headers.get('x-telegram-bot-api-secret-token');
    if (!secretHeader) return false;
    // Use timing-safe comparison to prevent timing attacks
    const { timingSafeEqual } = require('crypto');
    try {
      const a = Buffer.from(secretHeader);
      const b = Buffer.from(this.webhookSecret);
      return a.length === b.length && timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  /**
   * Parse a Telegram Update into a NormalisedInboundMessage.
   * Returns null if the update is not a processable text message.
   */
  parseInbound(rawPayload: unknown): NormalisedInboundMessage | null {
    const update = rawPayload as TelegramUpdate;

    if (!update.message) return null;

    const msg = update.message;
    const hasUnsupportedContent = msg.photo || msg.video || msg.sticker || msg.voice || msg.document;

    // Build display name
    const senderName = msg.from
      ? [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ')
      : undefined;

    // Handle unsupported content types
    if (hasUnsupportedContent && !msg.text) {
      return {
        channel: 'telegram',
        chatId: String(msg.chat.id),
        senderId: String(msg.from?.id ?? msg.chat.id),
        senderName,
        text: '[unsupported_content]',
        timestamp: new Date(msg.date * 1000),
        rawPayload,
        metadata: {},
      };
    }

    if (!msg.text) return null;

    // Detect /start commands with reference codes
    const isCommand = msg.text.startsWith('/');
    let commandArg: string | undefined;

    if (isCommand && msg.text.startsWith('/start ')) {
      commandArg = msg.text.split(' ')[1]?.trim();
    }

    return {
      channel: 'telegram',
      chatId: String(msg.chat.id),
      senderId: String(msg.from?.id ?? msg.chat.id),
      senderName,
      text: msg.text,
      timestamp: new Date(msg.date * 1000),
      rawPayload,
      metadata: {
        isCommand,
        commandArg,
        replyToMessageId: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
      },
    };
  }

  /**
   * Send a message via the Telegram Bot API.
   */
  async sendMessage(msg: NormalisedOutboundMessage): Promise<{ messageId: string }> {
    return withRetry(
      async () => {
        const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;

        const body: Record<string, unknown> = {
          chat_id: msg.chatId,
          text: msg.text,
          parse_mode: 'HTML',
        };

        if (msg.replyToMessageId) {
          body.reply_to_message_id = Number(msg.replyToMessageId);
        }

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const errBody = await res.text();
          throw new Error(`Telegram API error ${res.status}: ${errBody}`);
        }

        const data = await res.json() as { result?: { message_id?: number } };
        return { messageId: String(data.result?.message_id ?? '') };
      },
      { maxAttempts: 3, initialDelayMs: 500, isRetryable: isRetryableHttpError },
    );
  }
}

/**
 * Create a TelegramAdapter from environment variables.
 */
export function createTelegramAdapter(): TelegramAdapter {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET ?? '';

  if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN is not set');

  return new TelegramAdapter(botToken, webhookSecret);
}
