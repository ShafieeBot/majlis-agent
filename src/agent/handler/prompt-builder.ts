/**
 * Dynamic system prompt builder.
 *
 * Loads personality from workspace/SOUL.md and rules from workspace/POLICIES.md
 * once per cold start, then merges with dynamic wedding/guest/event context.
 *
 * If the DB has a system_prompt_override, it takes full precedence.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import type { AgentContext } from '../types';
import type { ToolDefinition } from '../skills/types';

// ── Load workspace files once per cold start ──

let _soulMd: string | null = null;
let _policiesMd: string | null = null;

function loadWorkspaceFile(filename: string): string {
  try {
    const filePath = join(process.cwd(), 'src', 'lib', 'agent', 'workspace', filename);
    return readFileSync(filePath, 'utf-8').trim();
  } catch {
    // Fallback for test/build environments where filesystem might not match
    return '';
  }
}

function getSoul(): string {
  if (_soulMd === null) _soulMd = loadWorkspaceFile('SOUL.md');
  return _soulMd;
}

function getPolicies(): string {
  if (_policiesMd === null) _policiesMd = loadWorkspaceFile('POLICIES.md');
  return _policiesMd;
}

/**
 * Reset cached workspace files. Useful for testing.
 */
export function _resetWorkspaceCache(): void {
  _soulMd = null;
  _policiesMd = null;
}

// ── Prompt Builder ──

export function buildSystemPrompt(context: AgentContext, availableTools: ToolDefinition[]): string {
  const { wedding, inviteGroup, events, notes, policy, isQuietHours } = context;

  // If DB has a full override, use it
  if (policy.system_prompt_override) {
    return policy.system_prompt_override;
  }

  // Load workspace files
  const soul = getSoul();
  const policies = getPolicies();

  const eventList = events
    .map(e => {
      const parts = [`- ${e.name}`];
      if (e.date) parts.push(`Date: ${e.date}`);
      if (e.start_time && e.end_time) parts.push(`Time: ${e.start_time.slice(0, 5)} - ${e.end_time.slice(0, 5)}`);
      if (e.venue_name) parts.push(`Venue: ${e.venue_name}`);
      if (e.rsvp_status) parts.push(`RSVP: ${e.rsvp_status} (${e.confirmed_pax} pax)`);
      if (e.table_number) parts.push(`Table: ${e.table_number}`);
      return parts.join('\n  ');
    })
    .join('\n');

  const notesList = notes.length > 0
    ? notes.map(n => `- [${n.note_type}] ${n.content}`).join('\n')
    : 'None';

  const toolList = availableTools.length > 0
    ? availableTools.map(t => `- ${t.name}: ${t.description}`).join('\n')
    : 'No tools available';


  // Build the prompt from workspace files + dynamic context
  const sections: string[] = [];

  // Section 1: Identity & Personality (from SOUL.md)
  if (soul) {
    sections.push(`# Identity & Personality\n${soul}`);
  } else {
    // Inline fallback if workspace file missing
    sections.push(`# Identity
You are Majlis AI, a bilingual (Bahasa Melayu / English) wedding communications assistant
for "${wedding.bride_name} & ${wedding.groom_name}".

You help the wedding hosts (tuan rumah) communicate with their guests via Telegram.
You are warm, respectful, and use appropriate Islamic greetings (Assalamualaikum, InsyaAllah, etc).`);
  }

  // Section 2: Wedding context
  sections.push(`# Wedding
- Title: ${wedding.title}
- Bride: ${wedding.bride_name}
- Groom: ${wedding.groom_name}${wedding.hashtag ? `\n- Hashtag: ${wedding.hashtag}` : ''}${wedding.instagram_handle ? `\n- Instagram: ${wedding.instagram_handle}` : ''}`);

  // Section 3: Guest context
  // Derive the correct salutation title from tags
  const titleTags = ['pehin', 'dato seri', 'datuk seri', 'dato', 'datuk', 'pg', 'pengiran', 'dr', 'doctor', 'haji', 'hajah'];
  const guestTitle = inviteGroup.tags.find(tag => titleTags.includes(tag.toLowerCase())) ?? null;
  const salutationHint = guestTitle
    ? `Address this guest as: ${guestTitle.toUpperCase()} ${inviteGroup.contact_name ?? inviteGroup.group_name}`
    : `Address this guest as: Tuan/Puan ${inviteGroup.contact_name ?? inviteGroup.group_name} (use Tuan for male, Puan for female — infer from name if possible)`;

  sections.push(`# Current Guest Context
- Guest group: ${inviteGroup.group_name}
- Contact: ${inviteGroup.contact_name || 'N/A'}
- Max pax allowed: ${inviteGroup.max_pax_allowed}
- Tags: ${inviteGroup.tags.length > 0 ? inviteGroup.tags.join(', ') : 'none'}
- Salutation: ${salutationHint}`);

  // Section 4: Events
  sections.push(`# Events\n${eventList}`);

  // Section 5: Memory
  sections.push(`# Memory (notes from previous interactions)\n${notesList}`);

  // Section 6: Policy
  sections.push(`# Policy
- Quiet hours: ${isQuietHours ? 'ACTIVE — external actions paused' : 'inactive'}`);

  // Section 7: Rules (from POLICIES.md)
  if (policies) {
    sections.push(`# Rules\n${policies}`);
  } else {
    // Inline fallback
    sections.push(`# Rules
1. Always respond in the same language the guest uses (Malay or English). If unsure, use Malay.
2. If the guest asks something you cannot answer, say so politely and offer to check with the host.
3. For RSVP changes or pax updates, always ask which specific event the guest means before calling update_rsvp. Never guess the event. If pax exceeds the limit, the tool will flag it for host review.
4. Never disclose other guests' information, table assignments of others, or internal details.
5. Keep responses concise, warm, and friendly. Use 1-3 short paragraphs max.
6. If the guest seems upset or has a complaint, use create_exception_ticket to escalate.
7. When you learn something important about the guest (dietary needs, preferences), use save_agent_note.`);
  }

  // Section 8: Available tools
  sections.push(`# Available Tools\n${toolList}`);

  return sections.join('\n\n').trim();
}
