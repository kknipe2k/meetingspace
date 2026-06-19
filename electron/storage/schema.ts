import type Database from 'better-sqlite3';

/*
 * Schema + idempotent migrations. Versioned via SQLite's `user_version` pragma:
 * migrations run in order, each gated by its version number, so reopening an
 * existing database applies only the steps it is missing and re-running on an
 * up-to-date database is a no-op. The default space is seeded exactly once
 * (see ADR-0003).
 *
 * Migrations are append-only and additive: never edit a shipped step, never
 * rewrite existing rows. Add the next numbered step and bump CURRENT_VERSION.
 */

export const DEFAULT_SPACE_ID = 'space-default';
const DEFAULT_SPACE_NAME = 'My Space';
const CURRENT_VERSION = 8;

const MIGRATION_V1 = `
  CREATE TABLE IF NOT EXISTS spaces (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    space_id   TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notes (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    content    TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS assets (
    id            TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_space ON sessions(space_id);
  CREATE INDEX IF NOT EXISTS idx_notes_session ON notes(session_id);
  CREATE INDEX IF NOT EXISTS idx_assets_session ON assets(session_id);
`;

/*
 * v2 — note blocks. Adds an ordering column to notes so a session can hold
 * multiple ordered blocks (M02.A). Additive: `ADD COLUMN ... NOT NULL DEFAULT 0`
 * backfills every existing row to position 0, so the single M01 note is
 * preserved unchanged as the first block. The index backs `ORDER BY position`.
 */
const MIGRATION_V2 = `
  ALTER TABLE notes ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX IF NOT EXISTS idx_notes_session_position ON notes(session_id, position);
`;

/*
 * v3 — generated artifacts (M04.A). Adds the `documents` table holding generated
 * content per session (FOCUS doc now; whitepaper / minutes / raw later) so Part 2
 * can re-run without redoing Part 1. Additive: a new table, no existing row is
 * touched, so close→reopen→intact does not regress. The API key NEVER lands here —
 * only generated content. ON DELETE CASCADE cleans up a deleted session's
 * documents. Stage D adds full-text search as migration v4 on top of this.
 */
const MIGRATION_V3 = `
  CREATE TABLE IF NOT EXISTS documents (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,
    content     TEXT NOT NULL,
    template_id TEXT,
    created_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_documents_session ON documents(session_id, kind, created_at);
`;

/*
 * v4 — cross-session full-text search (M04.D, ADR-0011). Adds FTS5 virtual tables over
 * note content and session names so a query can find anything across every session.
 * FTS5 ships in the bundled better-sqlite3 SQLite — no new native dependency.
 *
 * `notes_fts` is a STANDALONE FTS5 table that stores `session_id` (UNINDEXED) alongside
 * the indexed content — deliberately NOT external-content. An external-content table
 * would force the search query to JOIN back to `notes` by rowid, and that JOIN would
 * silently hide a deleted note even if the index were stale — making the delete/update
 * sync NOT load-bearing (a stale index could never be observed, and the mutation guard
 * could never catch it). Storing session_id in the index means the query trusts the
 * index alone, so the sync triggers are genuinely load-bearing and verifiable.
 * `sessions_fts` (session names) is external-content over the tiny `sessions` table.
 *
 * Both are kept in sync by AFTER INSERT/UPDATE/DELETE triggers — defined once here, so
 * no store code path can forget to maintain the index — and BACKFILLED from existing
 * rows so pre-M04 content is searchable. Additive: new virtual tables + triggers only;
 * no existing row is touched, so close→reopen→intact and the v3 `documents` table do not
 * regress. The API key never lands here — only note content + session names already in the DB.
 */
const MIGRATION_V4 = `
  CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(content, session_id UNINDEXED);

  CREATE TRIGGER notes_fts_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, content, session_id) VALUES (new.rowid, new.content, new.session_id);
  END;
  CREATE TRIGGER notes_fts_ad AFTER DELETE ON notes BEGIN
    DELETE FROM notes_fts WHERE rowid = old.rowid;
  END;
  CREATE TRIGGER notes_fts_au AFTER UPDATE ON notes BEGIN
    DELETE FROM notes_fts WHERE rowid = old.rowid;
    INSERT INTO notes_fts(rowid, content, session_id) VALUES (new.rowid, new.content, new.session_id);
  END;

  CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(name, content='sessions', content_rowid='rowid');

  CREATE TRIGGER sessions_fts_ai AFTER INSERT ON sessions BEGIN
    INSERT INTO sessions_fts(rowid, name) VALUES (new.rowid, new.name);
  END;
  CREATE TRIGGER sessions_fts_ad AFTER DELETE ON sessions BEGIN
    INSERT INTO sessions_fts(sessions_fts, rowid, name) VALUES ('delete', old.rowid, old.name);
  END;
  CREATE TRIGGER sessions_fts_au AFTER UPDATE ON sessions BEGIN
    INSERT INTO sessions_fts(sessions_fts, rowid, name) VALUES ('delete', old.rowid, old.name);
    INSERT INTO sessions_fts(rowid, name) VALUES (new.rowid, new.name);
  END;

  INSERT INTO notes_fts(rowid, content, session_id) SELECT rowid, content, session_id FROM notes;
  INSERT INTO sessions_fts(rowid, name) SELECT rowid, name FROM sessions;
`;

/*
 * v5 — persisted-doc model (M05.A). Adds a nullable `model` column to `documents` so a
 * generated doc reloaded from storage shows which model produced it (the persisted-doc
 * model badge — M04 🟢). Additive: `ALTER TABLE … ADD COLUMN` only — no existing row is
 * rewritten (each gets NULL, which the UI renders as "no badge", exactly the pre-v5
 * behaviour), so close→reopen→intact and the v3 `documents` / v4 FTS tables do not
 * regress. The version gate runs this step exactly once (same as the v2 ALTER); the API
 * key NEVER lands here — only the model id (e.g. `claude-sonnet-4-6`).
 */
const MIGRATION_V5 = `
  ALTER TABLE documents ADD COLUMN model TEXT;
`;

/*
 * v6 — storage meter (M06.B, REVIEW-V11 F28). Adds a nullable `byte_size` column to `assets` so
 * the storage meter is a single cheap query (SUM(byte_size)) instead of an fs walk per open.
 * Additive: `ALTER TABLE … ADD COLUMN` only — no existing row is rewritten (each gets NULL,
 * meaning "size unknown / not yet backfilled"), so close→reopen→intact and the v3/v4/v5 tables do
 * not regress. The version gate runs this step exactly once. Two things finish the picture and
 * are deliberately NOT in this pure SQL step (they need the assets ROOT, which the schema layer
 * does not know): AssetStore.saveBlob records the real size going forward, and the idempotent
 * backfillAssetSizes seam (electron/storage/asset-backfill.ts) fills the NULL rows from disk —
 * keeping this migration trivially idempotent and Node-testable. The API key NEVER lands here.
 */
const MIGRATION_V6 = `
  ALTER TABLE assets ADD COLUMN byte_size INTEGER;
`;

/*
 * v7 — in-session conversation persistence (M06.D, ADR-0020). Adds a `chat_messages` table so
 * the in-app chat thread is saved and retrievable later (today it is renderer-only and evaporates
 * on reload — the one thing that contradicts "everything autosaves"). Additive: a new table, no
 * existing row is touched, so close→reopen→intact and the v3–v6 tables do not regress. Backfill is
 * trivial — no prior chat was ever persisted. `model` rides the ASSISTANT row (which model answered);
 * user rows store NULL. ON DELETE CASCADE keeps the orphan-free invariant (mirror the assets/
 * documents cascade). The API key NEVER lands here — only conversation content (user data, ADR-0020).
 */
const MIGRATION_V7 = `
  CREATE TABLE IF NOT EXISTS chat_messages (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    model      TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, created_at);
`;

/*
 * v8 — real-usage token counter (M06.D, ADR-0021). Adds a `usage` table recording every call's
 * ACTUAL token usage (input / output / cache_read / cache_creation) tagged with session_id + a
 * timestamp, so the passive counter can roll up this-session and today (per-day) windows. Granular
 * per-call rows mean other windows (all-time, this-month) are trivial future adds. Additive: a new
 * table only — close→reopen→intact and v3–v7 do not regress. ON DELETE CASCADE keeps it orphan-free
 * (a deleted session takes its usage rows with it). Cost is NOT stored — it is computed at read time
 * from the updatable pricing config (ADR-0021), so a price change never rewrites history. The API
 * key NEVER lands here — only token counts + the answering model id.
 */
const MIGRATION_V8 = `
  CREATE TABLE IF NOT EXISTS usage (
    id                    TEXT PRIMARY KEY,
    session_id            TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    kind                  TEXT NOT NULL,
    model                 TEXT,
    input_tokens          INTEGER NOT NULL,
    output_tokens         INTEGER NOT NULL,
    cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    created_at            INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_usage_session ON usage(session_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_usage_created ON usage(created_at);
`;

interface MigrationStep {
  readonly version: number;
  readonly sql: string;
  readonly after?: (db: Database.Database) => void;
}

const MIGRATIONS: readonly MigrationStep[] = [
  { version: 1, sql: MIGRATION_V1, after: seedDefaultSpace },
  { version: 2, sql: MIGRATION_V2 },
  { version: 3, sql: MIGRATION_V3 },
  { version: 4, sql: MIGRATION_V4 },
  { version: 5, sql: MIGRATION_V5 },
  { version: 6, sql: MIGRATION_V6 },
  { version: 7, sql: MIGRATION_V7 },
  { version: 8, sql: MIGRATION_V8 },
];

export function migrate(db: Database.Database): void {
  let version = db.pragma('user_version', { simple: true }) as number;
  for (const step of MIGRATIONS) {
    if (version >= step.version) {
      continue;
    }
    db.exec(step.sql);
    step.after?.(db);
    db.pragma(`user_version = ${step.version}`);
    version = step.version;
  }
}

export const SCHEMA_VERSION = CURRENT_VERSION;

function seedDefaultSpace(db: Database.Database): void {
  const now = Date.now();
  db.prepare(
    'INSERT OR IGNORE INTO spaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
  ).run(DEFAULT_SPACE_ID, DEFAULT_SPACE_NAME, now, now);
}
