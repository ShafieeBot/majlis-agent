/**
 * Agent Loop — Multi-turn tool-use loop.
 *
 * GAP-L1 CLOSED: Error messages in ticket details are sanitized.
 * GAP-L2 CLOSED: Uses structured pino logger.
 * GAP-O2 CLOSED: Sentry captures LLM and tool execution errors.
 */

import { chatCompletion } from './llm-client';
import { createTicket } from '@/lib/api-client';
import { getToolByName } from '../skills/registry';
import { createModuleLogger } from '@/lib/logger';
import { captureException } from '@/lib/sentry';
import type { ChatMessage, ToolCall } from '../types';
import type { ToolDefinition, ToolContext } from '../skills/types';

const log = createModuleLogger('loop');
const MAX_ITERATIONS = 10;

export interface AgentLoopResult {
  responseText: string;
  toolCallsMade: number;
}

// GAP-L1 CLOSED: Sanitize error details before sending to external systems
function sanitizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Strip API keys, tokens, and URLs with credentials
  return msg
    .replace(/sk-[a-zA-Z0-9_-]+/g, '[API_KEY_REDACTED]')
    .replace(/Bearer [a-zA-Z0-9_.-]+/g, 'Bearer [REDACTED]')
    .replace(/x-api-key:\s*\S+/gi, 'x-api-key: [REDACTED]')
    .slice(0, 500); // Limit error length
}

/**
 * Run the agent loop: LLM ↔ tools until a text response is produced.
 */
export async function agentLoop(
  messages: ChatMessage[],
  availableTools: ToolDefinition[],
  toolContext: ToolContext,
  weddingId: string,
): Promise<AgentLoopResult> {
  let toolCallsMade = 0;
  let iteration = 0;

  while (iteration < MAX_ITERATIONS) {
    iteration++;

    let llmResponse;
    try {
      llmResponse = await chatCompletion(messages, availableTools, {
        temperature: 0.7,
        maxTokens: 1024,
      });
    } catch (err) {
      log.error({ err, weddingId, iteration }, 'LLM call failed');
      captureException(err, { weddingId, iteration, phase: 'llm_call' });

      // GAP-L1: Sanitize error before putting in ticket details
      await createTicket({
        weddingId,
        conversationId: toolContext.conversationId,
        inviteGroupId: toolContext.inviteGroupId || null,
        type: 'SYSTEM_ERROR',
        details: { error: sanitizeError(err), iteration },
      }).catch((ticketErr) => log.error({ err: ticketErr }, 'Failed to create system error ticket'));

      return {
        responseText: 'Maaf, sistem sedang sibuk. Kami akan membalas segera. 🙏',
        toolCallsMade,
      };
    }

    // If LLM returned tool calls, execute them
    if (llmResponse.tool_calls && llmResponse.tool_calls.length > 0) {
      messages.push({
        role: 'assistant',
        content: llmResponse.content || '',
        tool_calls: llmResponse.tool_calls,
      });

      for (const toolCall of llmResponse.tool_calls) {
        const tool = getToolByName(toolCall.function.name);
        const startTime = Date.now();

        if (!tool) {
          messages.push({
            role: 'tool',
            content: JSON.stringify({ error: `Unknown tool: ${toolCall.function.name}` }),
            tool_call_id: toolCall.id,
          });
          continue;
        }

        // Check if tool is in available set
        const isAvailable = availableTools.some((t) => t.name === tool.name);
        if (!isAvailable) {
          log.warn({ tool: tool.name }, 'Tool blocked by policy');
          messages.push({
            role: 'tool',
            content: JSON.stringify({ error: 'Tool is not available due to policy restrictions' }),
            tool_call_id: toolCall.id,
          });
          continue;
        }

        // Parse input
        let input: unknown;
        try {
          input = JSON.parse(toolCall.function.arguments);
        } catch {
          input = {};
        }

        // Execute tool
        try {
          const result = await tool.execute(input, toolContext);
          const duration = Date.now() - startTime;
          toolCallsMade++;

          log.info({ tool: tool.name, duration }, 'Tool executed');

          messages.push({
            role: 'tool',
            content: JSON.stringify(result),
            tool_call_id: toolCall.id,
          });
        } catch (err) {
          const duration = Date.now() - startTime;
          toolCallsMade++;
          log.error({ err, tool: tool.name, duration }, 'Tool execution failed');
          captureException(err, { tool: tool.name, weddingId, phase: 'tool_execution' });

          messages.push({
            role: 'tool',
            content: JSON.stringify({ error: `Tool execution failed: ${sanitizeError(err)}` }),
            tool_call_id: toolCall.id,
          });
        }
      }

      continue;
    }

    // LLM returned text content (final response)
    return {
      responseText:
        llmResponse.content ||
        'Maaf, saya tidak pasti bagaimana hendak menjawab. Sila hubungi tuan rumah.',
      toolCallsMade,
    };
  }

  // Max iterations reached
  return {
    responseText: 'Maaf, saya tidak pasti bagaimana hendak menjawab. Sila hubungi tuan rumah. 🙏',
    toolCallsMade,
  };
}

export { sanitizeError };
