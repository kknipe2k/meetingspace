import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import type { Session } from '@shared/types';

import { DEFAULT_SPACE_ID } from './schema';

interface SessionRow {
  id: string;
  space_id: string;
  name: string;
  created_at: number;
  updated_at: number;
}

type Clock = () => number;

/*
 * Data access for sessions over an open database handle. The handle is injected
 * (no module-global connection — docs/style.md), as is the clock, so timestamp-
 * ordered behavior is deterministic under test. A session's note blocks live in
 * NoteStore (electron/storage/notes.ts); screenshots/transcripts arrive later
 * in M02.
 *
 * Sessions are session-centric: createSession attaches to the seeded default
 * space (ADR-0003); multi-space management is deferred.
 */
export class SessionStore {
  private readonly db: Database.Database;
  private readonly now: Clock;

  constructor(db: Database.Database, now: Clock = Date.now) {
    this.db = db;
    this.now = now;
  }

  createSession(name: string): Session {
    const timestamp = this.now();
    const session: Session = {
      id: randomUUID(),
      spaceId: DEFAULT_SPACE_ID,
      name,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db
      .prepare(
        'INSERT INTO sessions (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(session.id, session.spaceId, session.name, session.createdAt, session.updatedAt);
    return session;
  }

  listSessions(): Session[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions ORDER BY updated_at DESC, id DESC')
      .all() as SessionRow[];
    return rows.map(toSession);
  }

  getSession(id: string): Session | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      | SessionRow
      | undefined;
    return row ? toSession(row) : undefined;
  }

  renameSession(id: string, name: string): void {
    this.db
      .prepare('UPDATE sessions SET name = ?, updated_at = ? WHERE id = ?')
      .run(name, this.now(), id);
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  /*
   * Bulk delete (M06.B). Loops the SAME single-session row delete inside ONE transaction — the FK
   * cascade (notes/assets/documents rows) is the verified one, NOT a hand-rolled second path. The
   * transaction makes the row deletes all-or-nothing; per-session blob-directory removal is
   * filesystem (not transactional) and is handled by the IPC handler's afterSessionDelete loop
   * AFTER this commits. Unknown ids are harmless (DELETE matches nothing); an empty list is a
   * no-op.
   */
  deleteSessions(ids: string[]): void {
    const del = this.db.prepare('DELETE FROM sessions WHERE id = ?');
    const apply = this.db.transaction((list: string[]) => {
      for (const id of list) {
        del.run(id);
      }
    });
    apply(ids);
  }
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    spaceId: row.space_id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
