import type Database from 'better-sqlite3';

import type { StorageSummary } from '@shared/types';

// The soft-nudge threshold + check live in shared/limits (one source for main + renderer); kept
// re-exported here so existing storage-layer callers and tests import from one place.
export { STORAGE_THRESHOLD_BYTES, crossesStorageThreshold } from '@shared/limits';

/*
 * Storage meter (M06.B, REVIEW-V11 F28). One cheap query gives per-session + total byte usage:
 * note content bytes + document content bytes + asset blob bytes (the migration-v6 byte_size
 * column). `totalBytes` is the sum of the per-session data bytes — the number that reflects what
 * the user's content is actually costing (raw DB page math is deliberately NOT surfaced). The
 * handle is injected (no module-global state — docs/style.md). No key, no SDK.
 */

interface SummaryRow {
  session_id: string;
  name: string;
  bytes: number;
}

export class StorageStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  summary(): StorageSummary {
    // LEFT JOINs so a session with no content still reports a 0-byte row (not absent). LENGTH on
    // a BLOB cast counts UTF-8 bytes (not JS chars), matching what actually lands on disk.
    const rows = this.db
      .prepare(
        `SELECT s.id AS session_id, s.name AS name,
            COALESCE((SELECT SUM(LENGTH(CAST(n.content AS BLOB))) FROM notes n WHERE n.session_id = s.id), 0)
          + COALESCE((SELECT SUM(LENGTH(CAST(d.content AS BLOB))) FROM documents d WHERE d.session_id = s.id), 0)
          + COALESCE((SELECT SUM(a.byte_size) FROM assets a WHERE a.session_id = s.id), 0)
            AS bytes
         FROM sessions s
         ORDER BY s.updated_at DESC, s.id DESC`,
      )
      .all() as SummaryRow[];

    const perSession = rows.map((r) => ({
      sessionId: r.session_id,
      name: r.name,
      bytes: r.bytes,
    }));
    const totalBytes = perSession.reduce((sum, s) => sum + s.bytes, 0);
    return { totalBytes, perSession };
  }
}
