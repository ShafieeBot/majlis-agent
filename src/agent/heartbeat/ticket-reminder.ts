/**
 * Ticket Reminder — finds stale OPEN tickets (>2 hours) and notifies admin.
 * Stale tickets are fetched via the majlis API.
 */

import { getStaleTickets } from '@/lib/api-client';
import { sendToAdmin } from '../gateway';

export interface TicketReminderResult {
  staleCount: number;
  notifiedWeddings: string[];
}

export async function checkStaleTickets(): Promise<TicketReminderResult> {
  const staleTickets = await getStaleTickets();

  if (!staleTickets.length) {
    return { staleCount: 0, notifiedWeddings: [] };
  }

  // Group by wedding
  const byWedding = new Map<string, typeof staleTickets>();
  for (const ticket of staleTickets) {
    const existing = byWedding.get(ticket.wedding_id) ?? [];
    existing.push(ticket);
    byWedding.set(ticket.wedding_id, existing);
  }

  const notifiedWeddings: string[] = [];

  for (const [weddingId, tickets] of byWedding) {
    const summary = tickets
      .map((t) => `- ${t.type} (${t.id.slice(0, 8)}) — open since ${t.created_at}`)
      .join('\n');

    await sendToAdmin(weddingId, `Stale tickets reminder:\n${summary}`, {
      ticketCount: tickets.length,
      oldestTicketId: tickets[0].id,
    });

    notifiedWeddings.push(weddingId);
  }

  return {
    staleCount: staleTickets.length,
    notifiedWeddings,
  };
}
