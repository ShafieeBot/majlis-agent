/**
 * Heartbeat — Orchestrator for periodic background tasks.
 *
 * Runs:
 * 1. Stale ticket reminders (OPEN > 2 hours)
 * 2. Dead letter retry (FAILED messages, max 3 attempts)
 *
 * Called by the cron scheduler every 15 minutes.
 */

import { checkStaleTickets, type TicketReminderResult } from './ticket-reminder';
import { retryFailedMessages, type DeadLetterResult } from './dead-letter';

export interface HeartbeatResult {
  tickets: TicketReminderResult;
  deadLetters: DeadLetterResult;
  durationMs: number;
}

export async function runHeartbeat(): Promise<HeartbeatResult> {
  const start = Date.now();

  const [tickets, deadLetters] = await Promise.all([checkStaleTickets(), retryFailedMessages()]);

  const durationMs = Date.now() - start;

  console.log(
    `[Heartbeat] Done in ${durationMs}ms — ` +
      `tickets: ${tickets.staleCount}, ` +
      `dead-letters: ${deadLetters.retried} retried (${deadLetters.succeeded} ok, ${deadLetters.permanentlyFailed} failed)`,
  );

  return { tickets, deadLetters, durationMs };
}
