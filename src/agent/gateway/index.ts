/**
 * Gateway — Channel-agnostic message transport layer.
 *
 * Exports standalone functions: sendMessage(), sendToAdmin(), parseInbound(), validateWebhook().
 * Handler code NEVER receives an adapter parameter — it calls gateway functions directly.
 *
 * The gateway lazy-loads the correct channel adapter based on the channel parameter
 * or defaults to Telegram.
 */

import type { NormalisedInboundMessage, NormalisedOutboundMessage, ChannelAdapter } from './types';

// Re-export types for convenience
export type { NormalisedInboundMessage, NormalisedOutboundMessage, ChannelAdapter } from './types';
// ── Adapter cache (one per channel per cold start) ──

const adapterCache = new Map<string, ChannelAdapter>();

function getAdapter(channel: string = 'telegram'): ChannelAdapter {
  const cached = adapterCache.get(channel);
  if (cached) return cached;

  let adapter: ChannelAdapter;

  switch (channel) {
    case 'telegram': {
      // Lazy import to avoid loading Telegram deps when not needed
      const { createTelegramAdapter } = require('./telegram');
      adapter = createTelegramAdapter();
      break;
    }
    case 'whatsapp': {
      const { createWhatsAppAdapter } = require('./whatsapp');
      adapter = createWhatsAppAdapter();
      break;
    }
    default:
      throw new Error(`Unknown channel: ${channel}`);
  }

  adapterCache.set(channel, adapter);
  return adapter;
}

// ── Public API ──

/**
 * Validate an inbound webhook request.
 */
export async function validateWebhook(request: Request, channel: string = 'telegram'): Promise<boolean> {
  return getAdapter(channel).validateWebhook(request);
}

/**
 * Parse a raw inbound payload into a NormalisedInboundMessage.
 * Returns null if the payload is not processable.
 */
export function parseInbound(rawPayload: unknown, channel: string = 'telegram'): NormalisedInboundMessage | null {
  return getAdapter(channel).parseInbound(rawPayload);
}

/**
 * Send a message to a guest via their channel.
 */
export async function sendMessage(msg: NormalisedOutboundMessage): Promise<{ messageId: string }> {
  return getAdapter(msg.channel).sendMessage(msg);
}

/**
 * Send a notification to the admin / host.
 * For now, this logs to console. In the future, can push to admin panel or separate Telegram group.
 */
export async function sendToAdmin(
  weddingId: string,
  text: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  // TODO: Implement admin notification channel (e.g., admin Telegram group, push notification)
  console.log(`[Admin Notification] Wedding ${weddingId}: ${text}`, metadata ?? '');
}

/**
 * Reset the adapter cache. Useful for testing.
 */
export function _resetAdapterCache(): void {
  adapterCache.clear();
}
