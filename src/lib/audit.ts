/**
 * Audit Logger — Records sensitive admin operations to SQLite.
 *
 * GAP-L3 CLOSED: All admin actions (send, read, reply) are now logged
 * with actor, action, target, and metadata for accountability.
 */

import { randomUUID } from 'crypto';
import { getDb } from './db';
import { createModuleLogger } from './logger';

const log = createModuleLogger('audit');

export interface AuditEntry {
  action: string;
  actor: string;
  target_type: string;
  target_id: string;
  metadata?: Record<string, unknown>;
  ip_address?: string;
}

/**
 * Record an audit log entry.
 */
export function recordAudit(entry: AuditEntry): void {
  try {
    const db = getDb();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO audit_log (id, action, actor, target_type, target_id, metadata, ip_address, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      entry.action,
      entry.actor,
      entry.target_type,
      entry.target_id,
      JSON.stringify(entry.metadata ?? {}),
      entry.ip_address ?? null,
      now,
    );

    log.info(
      { action: entry.action, actor: entry.actor, target: `${entry.target_type}:${entry.target_id}` },
      'Audit event recorded',
    );
  } catch (err) {
    // Audit logging must never crash the request
    log.error({ err }, 'Failed to record audit entry');
  }
}
