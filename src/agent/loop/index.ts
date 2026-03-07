/**
 * Agent Loop — Multi-turn tool-use loop.
 *
 * Receives system prompt + messages, iterates up to MAX_ITERATIONS,
 * executing tools and feeding results back to the LLM until it
 * produces a final text response.
 */

import { chatCompletion } from './llm-client';
import { createTicket } from '@/lib/api-client';
import { getToolByName } from '../skills/registry';
import type { ChatMessage, ToolCall } from '../types';
import type { ToolDefinition, ToolContext } from '../skills/types';

const MAX_ITERATIONS = 10;

export interface AgentLoopResult {
  responseText: string;
  toolCallsMade: number;
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
      console.error('LLM call failed:', err);

      // Create exception ticket via majlis API
      await createTicket({
        weddingId,
        conversationId: toolContext.conversationId,
        inviteGroupId: toolContext.inviteGroupId || null,
        type: 'OTHER',
        details: { error: String(err), iteration },
      }).catch((ticketErr) => console.error('Failed to create system error ticket:', ticketErr));

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
          console.warn(`[Loop] Tool ${tool.name} blocked by policy`);
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

          console.log(`[Loop] Tool ${tool.name} executed in ${duration}ms`);

          messages.push({
            role: 'tool',
            content: JSON.stringify(result),
            tool_call_id: toolCall.id,
          });
        } catch (err) {
          const duration = Date.now() - startTime;
          toolCallsMade++;
          console.error(`[Loop] Tool ${tool.name} failed in ${duration}ms:`, err);

          messages.push({
            role: 'tool',
            content: JSON.stringify({ error: `Tool execution failed: ${String(err)}` }),
            tool_call_id: toolCall.id,
          });
        }
      }

      continue; // Go back to LLM with tool results
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
