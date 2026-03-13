/**
 * LLM Client — OpenAI-compatible chat completion client.
 * Works with Claude (via Anthropic API), OpenAI, OpenRouter, or local models.
 *
 * Configured via environment variables:
 * - LLM_BASE_URL: API base URL (default: https://api.openai.com/v1)
 * - LLM_API_KEY: API key
 * - LLM_MODEL: Model name (default: gpt-4o)
 * - LLM_FALLBACK_MODEL: Fallback model when primary is overloaded (default: claude-haiku-4-5-20251001)
 */

import type { ChatMessage, LLMResponse, ToolCall } from '../types';
import type { ToolDefinition } from '../skills/types';
import { toolToFunctionDef } from '../skills/types';
import { withRetry, isRetryableHttpError } from '@/lib/retry';

interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

function getConfig(): LLMConfig {
  return {
    baseUrl: process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || 'gpt-4o',
  };
}

/**
 * Check if we're using the Anthropic API (Claude).
 */
function isAnthropicApi(baseUrl: string): boolean {
  return baseUrl.includes('anthropic.com');
}

/**
 * Check if an error is an overloaded (529) error.
 */
function isOverloadedError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('529');
}

/**
 * Call the LLM with messages and optional tools.
 * Supports both OpenAI and Anthropic API formats.
 *
 * If the primary model returns 529 (overloaded), automatically retries
 * with a fallback model (Haiku by default).
 */
export async function chatCompletion(
  messages: ChatMessage[],
  tools?: ToolDefinition[],
  options?: { temperature?: number; maxTokens?: number },
): Promise<LLMResponse> {
  const config = getConfig();

  if (!config.apiKey) {
    throw new Error('LLM_API_KEY is not configured');
  }

  const callWithConfig = (cfg: LLMConfig) =>
    withRetry(
      () => {
        if (isAnthropicApi(cfg.baseUrl)) {
          return callAnthropic(cfg, messages, tools, options);
        }
        return callOpenAI(cfg, messages, tools, options);
      },
      { maxAttempts: 3, initialDelayMs: 1000, isRetryable: isRetryableHttpError },
    );

  try {
    return await callWithConfig(config);
  } catch (err) {
    // If primary model is overloaded, fall back to a smaller model
    const fallbackModel = process.env.LLM_FALLBACK_MODEL || 'claude-haiku-4-5-20251001';
    if (isOverloadedError(err) && fallbackModel !== config.model) {
      console.warn(`[LLM] Primary model ${config.model} overloaded, falling back to ${fallbackModel}`);
      return callWithConfig({ ...config, model: fallbackModel });
    }
    throw err;
  }
}

/**
 * Call Anthropic's Messages API (Claude).
 */
async function callAnthropic(
  config: LLMConfig,
  messages: ChatMessage[],
  tools?: ToolDefinition[],
  options?: { temperature?: number; maxTokens?: number },
): Promise<LLMResponse> {
  // Extract system message
  const systemMsg = messages.find(m => m.role === 'system');
  const nonSystemMessages = messages.filter(m => m.role !== 'system');

  // Convert messages to Anthropic format
  const anthropicMessages = convertToAnthropicMessages(nonSystemMessages);

  // Build request body
  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: options?.maxTokens || 1024,
    messages: anthropicMessages,
  };

  if (systemMsg) {
    body.system = systemMsg.content;
  }

  if (options?.temperature !== undefined) {
    body.temperature = options.temperature;
  }

  if (tools && tools.length > 0) {
    body.tools = tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: toolToFunctionDef(t).function.parameters,
    }));
  }

  const res = await fetch(`${config.baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${errText}`);
  }

  const data = await res.json() as Record<string, unknown>;
  return parseAnthropicResponse(data);
}

/**
 * Call OpenAI-compatible API.
 */
async function callOpenAI(
  config: LLMConfig,
  messages: ChatMessage[],
  tools?: ToolDefinition[],
  options?: { temperature?: number; maxTokens?: number },
): Promise<LLMResponse> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages: messages.map(m => {
      if (m.role === 'tool') {
        return { role: 'tool', content: m.content, tool_call_id: m.tool_call_id };
      }
      if (m.tool_calls) {
        return { role: 'assistant', content: m.content, tool_calls: m.tool_calls };
      }
      return { role: m.role, content: m.content };
    }),
    max_tokens: options?.maxTokens || 1024,
  };

  if (options?.temperature !== undefined) {
    body.temperature = options.temperature;
  }

  if (tools && tools.length > 0) {
    body.tools = tools.map(t => toolToFunctionDef(t));
  }

  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${errText}`);
  }

  const data = await res.json() as {
    choices?: Array<{
      message?: { content?: string | null; tool_calls?: unknown[] | null };
      finish_reason?: string;
    }>;
  };
  const choice = data.choices?.[0];

  return {
    content: choice?.message?.content || null,
    tool_calls: (choice?.message?.tool_calls as LLMResponse['tool_calls']) || null,
    finish_reason: choice?.finish_reason || 'stop',
  };
}

/**
 * Convert ChatMessage[] to Anthropic message format.
 * Handles multimodal content (text + images) by passing content block arrays directly.
 */
function convertToAnthropicMessages(messages: ChatMessage[]): unknown[] {
  const result: unknown[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      // If content is an array (multimodal: text + images), pass directly to Anthropic
      result.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const content: unknown[] = [];
        if (msg.content) {
          content.push({ type: 'text', text: msg.content });
        }
        for (const tc of msg.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments),
          });
        }
        result.push({ role: 'assistant', content });
      } else {
        result.push({ role: 'assistant', content: msg.content });
      }
    } else if (msg.role === 'tool') {
      result.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.tool_call_id,
            content: msg.content,
          },
        ],
      });
    }
  }

  return result;
}

/**
 * Parse Anthropic's response format into our LLMResponse.
 */
function parseAnthropicResponse(data: Record<string, unknown>): LLMResponse {
  const content = data.content as Array<Record<string, unknown>> | undefined;
  const stopReason = data.stop_reason as string;

  if (!content || content.length === 0) {
    return { content: null, tool_calls: null, finish_reason: stopReason || 'stop' };
  }

  let textContent = '';
  const toolCalls: ToolCall[] = [];

  for (const block of content) {
    if (block.type === 'text') {
      textContent += (block.text as string) || '';
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id as string,
        type: 'function',
        function: {
          name: block.name as string,
          arguments: JSON.stringify(block.input),
        },
      });
    }
  }

  return {
    content: textContent || null,
    tool_calls: toolCalls.length > 0 ? toolCalls : null,
    finish_reason: stopReason === 'tool_use' ? 'tool_calls' : (stopReason || 'stop'),
  };
}
