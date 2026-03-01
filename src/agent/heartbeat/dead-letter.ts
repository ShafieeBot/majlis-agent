/**
 * Dead Letter — retries FAILED outbound messages (max 3 attempts).
 *
 * Only retries messages that failed due to gateway/network errors.
 * Tracks retry count in metadata.retry_count (stored as JSON in SQLite).
 */

import { getDb } from '@/lib/db';
import { sendMessage } from '../gateway';
import { sendToAdmin } from '../gateway';

const MAX_RETRIES = 3;

export interface DeadLetterResult {
  retried: number;
  succeeded: number;
  permanentlyFailed: number;
}

export async function retryFailedMessages(): Promise<DeadLetterResult> {
  const db = getDb();

  // Get failed outbound messages with their conversation channel/chat_id
  const rows = db
    .prepare<[], Record<string, unknown>>(
      `SELECT m.id, m.content, m.metadata, m.conversation_id,
              c.channel, c.chat_id, c.wedding_id
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE m.direction = 'OUT' AND m.status = 'FAILED'
       ORDER BY m.created_at ASC
       LIMIT 20`,
    )
    .all() as Record<string, unknown>[];

  if (!rows.length) {
    return { retried: 0, succeeded: 0, permanentlyFailed: 0 };
  }

  let retried = 0;
  let succeeded = 0;
  let permanentlyFailed = 0;

  for (const row of rows) {
    const metadata: Record<string, unknown> =
      typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata ?? {});
    const retryCount = (metadata.retry_count as number) ?? 0;
    const now = new Date().toISOString();

    if (retryCount >= MAX_RETRIES) {
      // Permanently failed — mark as DISCARDED and notify admin
      const newMeta = JSON.stringify({ ...metadata, permanently_failed: true, last_retry_at: now });
      db.prepare("UPDATE messages SET status = 'DISCARDED', metadata = ? WHERE id = ?").run(
        newMeta,
        row.id as string,
      );

      if (row.wedding_id) {
        await sendToAdmin(row.wedding_id as string, `Message permanently failed after ${MAX_RETRIES} retries`, {
          messageId: row.id,
          content: (row.content as string).slice(0, 100),
        });
      }

      permanentlyFailed++;
      continue;
    }

    // Attempt retry
    retried++;
    try {
      const result = await sendMessage({
        channel: (row.channel as 'telegram') || 'telegram',
        chatId: row.chat_id as string,
        text: row.content as string,
      });

      const newMeta = JSON.stringify({
        ...metadata,
        retry_count: retryCount + 1,
        retried_at: now,
      });
      db.prepare("UPDATE messages SET status = 'SENT', platform_message_id = ?, metadata = ? WHERE id = ?").run(
        result.messageId,
        newMeta,
        row.id as string,
      );

      succeeded++;
    } catch {
      const newMeta = JSON.stringify({ ...metadata, retry_count: retryCount + 1, last_retry_at: now });
      db.prepare('UPDATE messages SET metadata = ? WHERE id = ?').run(newMeta, row.id as string);
    }
  }

  return { retried, succeeded, permanentlyFailed };
}
