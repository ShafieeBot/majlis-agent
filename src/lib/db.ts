import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const dbPath = process.env.DB_PATH ?? './data/agent.db';
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id                TEXT PRIMARY KEY,
      channel           TEXT NOT NULL,
      chat_id           TEXT NOT NULL,
      sender_id         TEXT,
      sender_name       TEXT,
      routing_state     TEXT NOT NULL DEFAULT 'UNKNOWN',
      wedding_id        TEXT,
      invite_group_id   TEXT,
      pin_attempts      INTEGER DEFAULT 0,
      metadata          TEXT DEFAULT '{}',
      last_message_at   TEXT NOT NULL,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      UNIQUE(channel, chat_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id                  TEXT PRIMARY KEY,
      conversation_id     TEXT NOT NULL REFERENCES conversations(id),
      direction           TEXT NOT NULL,
      content             TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'RECEIVED',
      intent              TEXT,
      platform_message_id TEXT,
      metadata            TEXT DEFAULT '{}',
      created_at          TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation
      ON messages(conversation_id, created_at);

    CREATE TABLE IF NOT EXISTS agent_memory (
      id              TEXT PRIMARY KEY,
      wedding_id      TEXT NOT NULL,
      invite_group_id TEXT,
      note_type       TEXT NOT NULL,
      content         TEXT NOT NULL,
      source          TEXT NOT NULL DEFAULT 'agent',
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_wedding
      ON agent_memory(wedding_id, invite_group_id, note_type);
  `);

  return _db;
}
