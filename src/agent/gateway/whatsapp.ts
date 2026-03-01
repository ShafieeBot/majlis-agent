/**
 * WhatsApp channel adapter (stub for future implementation).
 * Follows the same ChannelAdapter interface as Telegram.
 */

import type { ChannelAdapter, NormalisedInboundMessage, NormalisedOutboundMessage } from './types';

export class WhatsAppAdapter implements ChannelAdapter {
  readonly channel = 'whatsapp';

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async validateWebhook(_request: Request): Promise<boolean> {
    throw new Error('WhatsApp adapter not yet implemented');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  parseInbound(_rawPayload: unknown): NormalisedInboundMessage | null {
    throw new Error('WhatsApp adapter not yet implemented');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async sendMessage(_msg: NormalisedOutboundMessage): Promise<{ messageId: string }> {
    throw new Error('WhatsApp adapter not yet implemented');
  }
}
