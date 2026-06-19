import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import type { Note } from '@shared/types';

interface NoteRow {
  id: string;
  session_id: string;
  content: string;
  position: number;
  created_at: number;
  updated_at: number;
}

type Clock = () => number;

/*
 * Data access for a session's ordered note blocks (M02.A — replaces M01's single
 * note). The database handle and clock are injected (no module-global state —
 * docs/style.md), so ordering and timestamps are deterministic under test.
 *
 * `position` is an internal ordering concern and is not part of the renderer-
 * facing `Note` contract; blocks are returned in order by `listNotes`.
 */
export class NoteStore {
  private readonly db: Database.Database;
  private readonly now: Clock;

  constructor(db: Database.Database, now: Clock = Date.now) {
    this.db = db;
    this.now = now;
  }

  addNote(sessionId: string): Note {
    return this.insertNote(sessionId, '');
  }

  /*
   * Adds a block already populated with content, in a single insert (M02.D — the
   * upload path). An uploaded text file becomes an ordinary note block this way,
   * so it autosaves, reorders, and persists exactly like a typed note. Used by the
   * note:addWithContent IPC channel, which byte-caps the content at the boundary.
   */
  addNoteWithContent(sessionId: string, content: string): Note {
    return this.insertNote(sessionId, content);
  }

  private insertNote(sessionId: string, content: string): Note {
    const timestamp = this.now();
    const nextPosition =
      (
        this.db
          .prepare('SELECT MAX(position) AS max FROM notes WHERE session_id = ?')
          .get(sessionId) as { max: number | null }
      ).max ?? -1;
    const row: NoteRow = {
      id: randomUUID(),
      session_id: sessionId,
      content,
      position: nextPosition + 1,
      created_at: timestamp,
      updated_at: timestamp,
    };
    this.db
      .prepare(
        'INSERT INTO notes (id, session_id, content, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(row.id, row.session_id, row.content, row.position, row.created_at, row.updated_at);
    return toNote(row);
  }

  listNotes(sessionId: string): Note[] {
    const rows = this.db
      .prepare('SELECT * FROM notes WHERE session_id = ? ORDER BY position, created_at')
      .all(sessionId) as NoteRow[];
    return rows.map(toNote);
  }

  updateNote(id: string, content: string): Note {
    const timestamp = this.now();
    this.db
      .prepare('UPDATE notes SET content = ?, updated_at = ? WHERE id = ?')
      .run(content, timestamp, id);
    const row = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow | undefined;
    if (!row) {
      throw new Error(`note not found: ${id}`);
    }
    return toNote(row);
  }

  deleteNote(id: string): void {
    this.db.prepare('DELETE FROM notes WHERE id = ?').run(id);
  }

  /*
   * Persists a reorder as a single transaction that rewrites every block's
   * position to its index in `orderedIds`. `orderedIds` must be a permutation of
   * exactly the session's current block ids — otherwise the whole operation
   * throws before any write, so a bad order can never leave duplicate or
   * contradictory positions (the failure mode a per-row update loop would hit).
   */
  reorderNotes(sessionId: string, orderedIds: string[]): void {
    const currentIds = new Set(
      (
        this.db.prepare('SELECT id FROM notes WHERE session_id = ?').all(sessionId) as Array<{
          id: string;
        }>
      ).map((r) => r.id),
    );
    const seen = new Set<string>();
    for (const id of orderedIds) {
      if (!currentIds.has(id) || seen.has(id)) {
        throw new Error(`reorderNotes: ${id} is not a unique block of session ${sessionId}`);
      }
      seen.add(id);
    }
    if (seen.size !== currentIds.size) {
      throw new Error(
        `reorderNotes: expected a permutation of ${currentIds.size} blocks, got ${seen.size}`,
      );
    }

    const timestamp = this.now();
    const update = this.db.prepare(
      'UPDATE notes SET position = ?, updated_at = ? WHERE id = ? AND session_id = ?',
    );
    const apply = this.db.transaction((ids: string[]) => {
      ids.forEach((id, index) => update.run(index, timestamp, id, sessionId));
    });
    apply(orderedIds);
  }
}

function toNote(row: NoteRow): Note {
  return {
    id: row.id,
    sessionId: row.session_id,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
