import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import type { ChatMessage } from '@shared/types';

interface ChatRow {
  id: string;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  model: string | null;
  created_at: number;
}

type Clock = () => number;
type IdFactory = () => string;

/*
 * Data access for a session's persisted chat thread (M06.D, ADR-0020). The DB handle, clock, and
 * id factory are injected (no module-global state — docs/style.md) so ordering and timestamps are
 * deterministic under test. Mirrors NoteStore. The thread is what gives the model multi-turn
 * memory AND survives reload (the renderer hydrates it on session open via `llm:history`).
 *
 * The key NEVER reaches this layer — chat content is user data, not a secret (Hard Rule §10 /
 * F29 read-only lock unaffected). Cascade-on-session-delete (schema v7) keeps it orphan-free.
 */
export class ChatStore {
  private readonly db: Database.Database;
  private readonly now: Clock;
  private readonly newId: IdFactory;

  constructor(db: Database.Database, now: Clock = Date.now, newId: IdFactory = randomUUID) {
    this.db = db;
    this.now = now;
    this.newId = newId;
  }

  appendMessage(input: {
    sessionId: string;
    role: 'user' | 'assistant';
    content: string;
    model?: string | null;
  }): ChatMessage {
    const row: ChatRow = {
      id: this.newId(),
      session_id: input.sessionId,
      role: input.role,
      content: input.content,
      model: input.model ?? null,
      created_at: this.now(),
    };
    this.db
      .prepare(
        'INSERT INTO chat_messages (id, session_id, role, content, model, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(row.id, row.session_id, row.role, row.content, row.model, row.created_at);
    return toMessage(row);
  }

  listMessages(sessionId: string): ChatMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at, id')
      .all(sessionId) as ChatRow[];
    return rows.map(toMessage);
  }
}

function toMessage(row: ChatRow): ChatMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    model: row.model,
    createdAt: row.created_at,
  };
}
