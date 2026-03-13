/**
 * Tool definition interface for the agent's tool registry.
 */

import { z } from 'zod';
import type { ToolSideEffect, AgentContext } from '../types';
import type { MediaAttachment } from '../gateway/types';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  sideEffect: ToolSideEffect;
  requiresScope: {
    weddingId: boolean;
    inviteGroupId?: boolean;
  };
  execute: (input: unknown, context: ToolContext) => Promise<unknown>;
}

export interface ToolContext {
  weddingId: string;
  inviteGroupId?: string;
  conversationId: string;
  agentContext?: AgentContext;
  pendingMedia?: MediaAttachment;
}

/**
 * Convert a ToolDefinition to OpenAI-compatible function format for the LLM.
 */
export function toolToFunctionDef(tool: ToolDefinition) {
  // Convert Zod schema to a JSON Schema-like object for the LLM
  const jsonSchema = zodToJsonSchema(tool.inputSchema);

  return {
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: jsonSchema,
    },
  };
}

/**
 * Simple Zod → JSON Schema converter for tool parameters.
 * Handles the basic types used by our tools.
 */
function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  // For Zod v4, we use a simplified approach
  // We describe tool params inline since our tools have simple schemas
  const description = schema.description;

  // Try to extract type info from the schema
  if (schema instanceof z.ZodObject) {
    const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      const fieldSchema = value as z.ZodType;
      properties[key] = zodTypeToJson(fieldSchema);

      // Check if field is required (not optional/nullable)
      if (!isOptional(fieldSchema)) {
        required.push(key);
      }
    }

    return {
      type: 'object',
      properties,
      required: required.length > 0 ? required : undefined,
    };
  }

  return { type: 'object', properties: {}, description };
}

function zodTypeToJson(schema: z.ZodType): Record<string, unknown> {
  if (schema instanceof z.ZodString) {
    return { type: 'string', description: schema.description };
  }
  if (schema instanceof z.ZodNumber) {
    return { type: 'number', description: schema.description };
  }
  if (schema instanceof z.ZodBoolean) {
    return { type: 'boolean', description: schema.description };
  }
  if (schema instanceof z.ZodArray) {
    return { type: 'array', items: zodTypeToJson((schema as z.ZodArray<z.ZodType>).element) };
  }
  if (schema instanceof z.ZodOptional) {
    return zodTypeToJson((schema as z.ZodOptional<z.ZodType>).unwrap());
  }
  if (schema instanceof z.ZodNullable) {
    return zodTypeToJson((schema as z.ZodNullable<z.ZodType>).unwrap());
  }
  if (schema instanceof z.ZodEnum) {
    const enumSchema = schema as z.ZodEnum;
    const opts = enumSchema.options ?? Object.values(enumSchema.enum ?? {});
    return { type: 'string', enum: opts };
  }
  return { type: 'string' };
}

function isOptional(schema: z.ZodType): boolean {
  return schema instanceof z.ZodOptional || schema instanceof z.ZodNullable;
}
