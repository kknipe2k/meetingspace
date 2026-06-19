import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import type { GenDocument, GenKind } from '@shared/types';

interface DocumentRow {
  id: string;
  session_id: string;
  kind: string;
  content: string;
  template_id: string | null;
  created_at: number;
  // The model that produced this doc (migration v5, M05.A) — NULL for pre-v5 rows.
  model: string | null;
}

type Clock = () => number;
type IdGenerator = () => string;

/*
 * Revision retention cap (M06.B, REVIEW-V11 F27 — owner decision A). Only the latest revision of
 * each kind is surfaced anywhere (getLatestArtifacts / F16), so older revisions are invisible
 * storage growth. saveArtifact keeps the newest N per (session, kind) and prunes the rest; the
 * storage meter (F28) still makes the retained cost visible. Reversible — raise N here later.
 */
export const ARTIFACT_RETENTION_PER_KIND = 10;

/*
 * Data access for persisted generated artifacts (M04.A — the `documents` table,
 * migration v3). The FOCUS doc (and later whitepaper / minutes / raw) persists
 * per session so Part 2 can re-run without redoing Part 1. The database handle,
 * clock, and id generator are injected (no module-global state — docs/style.md),
 * so writes are deterministic under test.
 *
 * The API KEY NEVER lands here — only generated content does. Artifacts are
 * session-scoped (FK ON DELETE CASCADE), so deleting a session removes its
 * documents with no orphan rows.
 */
export class ArtifactStore {
  private readonly db: Database.Database;
  private readonly now: Clock;
  private readonly newId: IdGenerator;

  constructor(db: Database.Database, now: Clock = Date.now, newId: IdGenerator = randomUUID) {
    this.db = db;
    this.now = now;
    this.newId = newId;
  }

  saveArtifact(input: {
    sessionId: string;
    kind: GenKind;
    content: string;
    templateId: string | null;
    // The answering model (M05.A migration v5); optional so the no-SDK / raw paths and
    // existing callers stay valid. Absent → stored NULL (no badge).
    model?: string | null;
  }): GenDocument {
    const row: DocumentRow = {
      id: this.newId(),
      session_id: input.sessionId,
      kind: input.kind,
      content: input.content,
      template_id: input.templateId,
      created_at: this.now(),
      model: input.model ?? null,
    };
    this.db
      .prepare(
        'INSERT INTO documents (id, session_id, kind, content, template_id, created_at, model) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        row.id,
        row.session_id,
        row.kind,
        row.content,
        row.template_id,
        row.created_at,
        row.model,
      );
    // Bound invisible revision growth (F27): keep only the newest N of this kind.
    this.pruneArtifacts(input.sessionId, input.kind);
    return toDocument(row);
  }

  /*
   * Prunes revisions of a (session, kind) beyond the newest `keep`, oldest-first. Returns the
   * number deleted. Idempotent: with at-or-below the cap, deletes nothing and returns 0. Recency
   * matches getLatestArtifact's ordering (created_at DESC, id DESC) so the kept set always
   * includes the latest revision.
   */
  pruneArtifacts(sessionId: string, kind: GenKind, keep = ARTIFACT_RETENTION_PER_KIND): number {
    const result = this.db
      .prepare(
        `DELETE FROM documents
          WHERE session_id = ? AND kind = ?
            AND id NOT IN (
              SELECT id FROM documents
               WHERE session_id = ? AND kind = ?
               ORDER BY created_at DESC, id DESC
               LIMIT ?
            )`,
      )
      .run(sessionId, kind, sessionId, kind, keep);
    return result.changes;
  }

  // The most recently generated artifact of a kind (newest first) — what Part 2
  // re-reads so it can re-run without redoing Part 1.
  getLatestArtifact(sessionId: string, kind: GenKind): GenDocument | null {
    const row = this.db
      .prepare(
        'SELECT * FROM documents WHERE session_id = ? AND kind = ? ORDER BY created_at DESC, id DESC LIMIT 1',
      )
      .get(sessionId, kind) as DocumentRow | undefined;
    return row ? toDocument(row) : null;
  }

  getArtifacts(sessionId: string): GenDocument[] {
    const rows = this.db
      .prepare('SELECT * FROM documents WHERE session_id = ? ORDER BY created_at DESC, id DESC')
      .all(sessionId) as DocumentRow[];
    return rows.map(toDocument);
  }

  // The latest revision of each user-facing kind for a session, newest-first (M07.B; F16).
  // The modal needs only the most-recent whitepaper + minutes — NOT every revision's full
  // content — so this reuses the tested per-kind query instead of shipping the whole table
  // over IPC each open. `focus` is an internal intermediate and `raw` is never persisted, so
  // only the two rendered kinds are returned; absent kinds are simply omitted.
  getLatestArtifacts(sessionId: string): GenDocument[] {
    return (['whitepaper', 'minutes'] as const)
      .map((kind) => this.getLatestArtifact(sessionId, kind))
      .filter((doc): doc is GenDocument => doc !== null)
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
  }
}

function toDocument(row: DocumentRow): GenDocument {
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind as GenKind,
    content: row.content,
    templateId: row.template_id,
    createdAt: row.created_at,
    model: row.model ?? null,
  };
}
