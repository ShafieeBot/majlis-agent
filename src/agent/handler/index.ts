/**
 * Handler — The brain entry point.
 *
 * Pipeline:
 * 1. Save inbound message
 * 2. Load agent context
 * 3. Resolve available tools
 * 4. Build system prompt
 * 5. Assemble message history
 * 6. Run agent loop (LLM ↔ tools)
 * 7. Split response if needed
 * 8. Send directly (no approval/draft flow)
 *
 * No adapter parameter — uses gateway.sendMessage() directly.
 */

import { randomUUID } from 'crypto';
import { getDb } from '@/lib/db';
import { buildSystemPrompt } from './prompt-builder';
import { splitMessage } from './message-splitter';
import { agentLoop } from '../loop';
import { loadAgentContext } from '../memory/context-loader';
import { ALL_TOOLS } from '../skills/registry';
import { resolveAvailableTools } from '../skills/policy';
import { sendMessage, resolveMedia } from '../gateway';
import type { RoutedContext, ChatMessage, AgentContext, MessageIntent } from '../types';
import type { ToolContext } from '../skills/types';
import type { NormalisedInboundMessage } from '../gateway/types';

export interface HandlerResult {
  responseText: string;
  status: 'SENT' | 'FAILED';
  intent?: MessageIntent;
}

/**
 * Handle an inbound message through the full agent pipeline.
 */
export async function handleIncomingMessage(
  routedContext: RoutedContext,
  msg: NormalisedInboundMessage,
): Promise<HandlerResult> {
  const db = getDb();
  const { conversation, weddingId, inviteGroupId } = routedContext;
  const now = new Date().toISOString();

  // Step 1: Save the inbound message
  db.prepare(`
    INSERT INTO messages (id, conversation_id, direction, status, content, metadata, created_at)
    VALUES (?, ?, 'IN', 'RECEIVED', ?, ?, ?)
  `).run(
    randomUUID(),
    conversation.id,
    msg.text,
    JSON.stringify({ sender_name: msg.senderName, timestamp: msg.timestamp.toISOString() }),
    now,
  );

  // Handle unsupported content
  if (msg.text === '[unsupported_content]') {
    const reply = 'Maaf, saya hanya boleh menerima mesej teks dan gambar buat masa ini. 🙏';
    await doSend(conversation.id, reply, 'GENERAL', msg.channel, msg.chatId);
    return { responseText: reply, status: 'SENT', intent: 'GENERAL' };
  }

  // Step 1b: Resolve pending media downloads (e.g., WhatsApp images)
  const resolved = await resolveMedia(msg);

  // Step 2: Load full context
  let context: AgentContext;
  try {
    context = await loadAgentContext(conversation, weddingId, inviteGroupId);
  } catch (err) {
    console.error('Failed to load agent context:', err);
    const reply = 'Maaf, sistem sedang sibuk. Kami akan membalas segera. 🙏';
    await doSend(conversation.id, reply, 'GENERAL', msg.channel, msg.chatId);
    return { responseText: reply, status: 'SENT', intent: 'GENERAL' };
  }

  // Step 3: Resolve available tools
  const availableTools = resolveAvailableTools(
    ALL_TOOLS,
    context.policy,
    conversation.routing_state as 'RESOLVED',
    new Date(),
  );

  // Step 4: Build system prompt
  const systemPrompt = buildSystemPrompt(context, availableTools);

  // Step 5: Assemble messages array
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
  ];

  // Add recent conversation history
  for (const m of context.recentMessages) {
    if (m.direction === 'IN') {
      messages.push({ role: 'user', content: m.content });
    } else if (m.status !== 'DISCARDED') {
      messages.push({ role: 'assistant', content: m.content });
    }
  }

  // Add current message (with media context if present)
  if (resolved.media) {
    const caption = resolved.media.caption ? `Caption: "${resolved.media.caption}"` : 'No caption provided.';
    messages.push({
      role: 'user',
      content: `[Guest sent a photo. ${caption}]\n\n${resolved.media.caption || ''}`.trim(),
    });
  } else {
    messages.push({ role: 'user', content: msg.text });
  }

  // Step 6: Run agent loop
  const toolContext: ToolContext = {
    weddingId,
    inviteGroupId,
    conversationId: conversation.id,
    agentContext: context,
    pendingMedia: resolved.media,
  };

  const loopResult = await agentLoop(messages, availableTools, toolContext, weddingId);

  // Step 7: Split long response
  const chunks = splitMessage(loopResult.responseText);
  const fullResponse = loopResult.responseText;

  // Step 8: Send directly
  const intent: MessageIntent = 'GENERAL';
  let finalStatus: 'SENT' | 'FAILED' = 'SENT';

  for (const chunk of chunks) {
    const ok = await doSend(conversation.id, chunk, intent, msg.channel, msg.chatId);
    if (!ok) finalStatus = 'FAILED';
  }

  // Update conversation last_message_at
  db.prepare('UPDATE conversations SET last_message_at = ?, updated_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    new Date().toISOString(),
    conversation.id,
  );

  return { responseText: fullResponse, status: finalStatus, intent };
}

/**
 * Send a message and record it in SQLite. Returns true on success, false on failure.
 */
async function doSend(
  conversationId: string,
  text: string,
  intent: MessageIntent,
  channel: string,
  chatId: string,
): Promise<boolean> {
  const db = getDb();
  const now = new Date().toISOString();

  try {
    const result = await sendMessage({
      channel: channel as 'telegram',
      chatId,
      text,
    });

    db.prepare(`
      INSERT INTO messages (id, conversation_id, direction, status, intent, content, platform_message_id, created_at)
      VALUES (?, ?, 'OUT', 'SENT', ?, ?, ?, ?)
    `).run(randomUUID(), conversationId, intent, text, result.messageId, now);

    return true;
  } catch (err) {
    console.error('Failed to send message:', err);

    db.prepare(`
      INSERT INTO messages (id, conversation_id, direction, status, intent, content, created_at)
      VALUES (?, ?, 'OUT', 'FAILED', ?, ?, ?)
    `).run(randomUUID(), conversationId, intent, text, now);

    return false;
  }
}
