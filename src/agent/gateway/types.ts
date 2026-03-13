/**
 * Normalised message interfaces for the pluggable channel transport layer.
 * The agent runner NEVER sees raw platform payloads — only normalised messages.
 */

export interface MediaAttachment {
  type: 'image';
  buffer: Buffer;
  mimeType: string;
  filename: string;
  caption?: string;
}

export interface PendingMediaDownload {
  mediaId: string;
  mimeType: string;
}

export interface NormalisedInboundMessage {
  channel: 'telegram' | 'whatsapp' | 'webchat';
  chatId: string;
  senderId: string;
  senderName?: string;
  text: string;
  timestamp: Date;
  rawPayload: unknown;
  media?: MediaAttachment;
  /** Set by adapter when media needs to be downloaded before processing. */
  _pendingMediaDownload?: PendingMediaDownload;
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
