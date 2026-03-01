/**
 * Notes Manager — CRUD operations for agent_memory (SQLite).
 * Handles persistent memory scoped by wedding + optionally invite group.
 */

import { randomUUID } from 'crypto';
import { getDb } from '@/lib/db';
import type { AgentNoteRecord, NoteType, NoteSource } from '../types';

function parseRow(row: Record<string, unknown>): AgentNoteRecord {
  return {
    id: row.id as string,
    wedding_id: row.wedding_id as string,
    invite_group_id: row.invite_group_id as string | null,
    note_type: row.note_type as NoteType,
    content: row.content as string,
    source: row.source as NoteSource,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

/**
 * Create a new agent note.
 */
export function createNote(params: {
  weddingId: string;
  inviteGroupId?: string;
  noteType: NoteType;
  content: string;
  source?: NoteSource;
}): AgentNoteRecord {
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();

  db.prepare(`
    INSERT INTO agent_memory (id, wedding_id, invite_group_id, note_type, content, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.weddingId,
    params.inviteGroupId || null,
    params.noteType,
    params.content,
    params.source || 'agent',
    now,
    now,
  );

  return parseRow(
    db.prepare<string, Record<string, unknown>>('SELECT * FROM agent_memory WHERE id = ?').get(id)!,
  );
}

/**
 * Get notes for a wedding, optionally filtered by invite group.
 */
export function getNotes(params: {
  weddingId: string;
  inviteGroupId?: string;
  noteType?: NoteType;
  limit?: number;
}): AgentNoteRecord[] {
  const db = getDb();
  const limit = params.limit ?? 20;

  let rows: Record<string, unknown>[];

  if (params.inviteGroupId && params.noteType) {
    rows = db
      .prepare<[string, string, string, number], Record<string, unknown>>(
        `SELECT * FROM agent_memory
         WHERE wedding_id = ? AND (invite_group_id IS NULL OR invite_group_id = ?) AND note_type = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(params.weddingId, params.inviteGroupId, params.noteType, limit);
  } else if (params.inviteGroupId) {
    rows = db
      .prepare<[string, string, number], Record<string, unknown>>(
        `SELECT * FROM agent_memory
         WHERE wedding_id = ? AND (invite_group_id IS NULL OR invite_group_id = ?)
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(params.weddingId, params.inviteGroupId, limit);
  } else if (params.noteType) {
    rows = db
      .prepare<[string, string, number], Record<string, unknown>>(
        `SELECT * FROM agent_memory
         WHERE wedding_id = ? AND note_type = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(params.weddingId, params.noteType, limit);
  } else {
    rows = db
      .prepare<[string, number], Record<string, unknown>>(
        `SELECT * FROM agent_memory
         WHERE wedding_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(params.weddingId, limit);
  }

  return rows.map(parseRow);
}

/**
 * Update a note's content.
 */
export function updateNote(noteId: string, content: string): void {
  getDb()
    .prepare('UPDATE agent_memory SET content = ?, updated_at = ? WHERE id = ?')
    .run(content, new Date().toISOString(), noteId);
}

/**
 * Delete a note.
 */
export function deleteNote(noteId: string): void {
  getDb().prepare('DELETE FROM agent_memory WHERE id = ?').run(noteId);
}
