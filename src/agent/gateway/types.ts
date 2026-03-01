/**
 * Normalised message interfaces for the pluggable channel transport layer.
 * The agent runner NEVER sees raw platform payloads — only normalised messages.
 */

export interface NormalisedInboundMessage {
  channel: 'telegram' | 'whatsapp' | 'webchat';
  chatId: string;
  senderId: string;
  senderName?: string;
  text: string;
  timestamp: Date;
  rawPayload: unknown;
  metadata: {
    isCommand?: boolean;
    commandArg?: string;
    replyToMessageId?: string;
  };
}

export interface NormalisedOutboundMessage {
  channel: 'telegram' | 'whatsapp' | 'webchat';
  chatId: string;
  text: string;
  replyToMessageId?: string;
  metadata?: Record<string, unknown>;
}

export interface ChannelAdapter {
  readonly channel: string;
  parseInbound(rawPayload: unknown): NormalisedInboundMessage | null;
  sendMessage(msg: NormalisedOutboundMessage): Promise<{ messageId: string }>;
  validateWebhook(request: Request): Promise<boolean>;
}
