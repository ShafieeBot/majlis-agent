/**
 * Tool Policy Cascade.
 * Each layer can ONLY narrow (never expand) the available tool set.
 *
 * Layer 1: Global Registry (all tools)
 * Layer 2: Wedding Policy (blocked_tools filter)
 * Layer 3: Routing State Gate (defense-in-depth)
 * Layer 4: Quiet Hours Gate (strip external tools)
 */

import type { ToolDefinition } from './types';
import type { AgentPolicyRecord, RoutingState } from '../types';

/**
 * Check if the current time falls within quiet hours.
 */
export function isQuietHours(
  currentTime: Date,
  policy: AgentPolicyRecord,
): boolean {
  if (!policy.quiet_hours_start || !policy.quiet_hours_end) return false;

  // Convert current time to the policy timezone
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: policy.quiet_hours_timezone || 'Asia/Brunei',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const timeParts = formatter.formatToParts(currentTime);
  const hour = parseInt(timeParts.find(p => p.type === 'hour')?.value ?? '0');
  const minute = parseInt(timeParts.find(p => p.type === 'minute')?.value ?? '0');
  const currentMinutes = hour * 60 + minute;

  const [startH, startM] = policy.quiet_hours_start.split(':').map(Number);
  const [endH, endM] = policy.quiet_hours_end.split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  // Handle overnight quiet hours (e.g., 22:00 - 07:00)
  if (startMinutes > endMinutes) {
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }

  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

/**
 * Resolve available tools through the cascading policy layers.
 */
export function resolveAvailableTools(
  allTools: ToolDefinition[],
  policy: AgentPolicyRecord,
  routingState: RoutingState,
  currentTime: Date,
): ToolDefinition[] {
  let tools = [...allTools];

  // Layer 2: Wedding policy — remove blocked tools
  if (policy.blocked_tools && policy.blocked_tools.length > 0) {
    tools = tools.filter(t => !policy.blocked_tools.includes(t.name));
  }

  // Layer 3: Routing state gate (defense-in-depth)
  if (routingState !== 'RESOLVED') {
    return [];
  }

  // Layer 4: Quiet hours — strip external tools (e.g. don't send WhatsApp at 3am)
  if (isQuietHours(currentTime, policy)) {
    tools = tools.filter(t => t.sideEffect !== 'external');
  }

  return tools;
}
