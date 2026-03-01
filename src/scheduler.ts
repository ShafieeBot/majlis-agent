/**
 * Heartbeat Scheduler
 *
 * Runs background maintenance tasks every 15 minutes:
 * - Stale support ticket reminders
 * - Unapproved draft reminders
 * - Failed message retries
 */

import cron from 'node-cron';
import { runHeartbeat } from '@/agent/heartbeat';

export function startScheduler() {
  cron.schedule('*/15 * * * *', async () => {
    console.log('[Heartbeat] Running...');
    try {
      const result = await runHeartbeat();
      console.log('[Heartbeat] Done:', result);
    } catch (err) {
      console.error('[Heartbeat] Error:', err);
    }
  });

  console.log('[Heartbeat] Scheduler started — runs every 15 minutes');
}
