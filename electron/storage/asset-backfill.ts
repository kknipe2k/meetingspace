import { statSync } from 'node:fs';
import { join } from 'node:path';

import type Database from 'better-sqlite3';

/*
 * byte_size backfill seam (M06.B, migration v6 / F28). The v6 SQL migration adds a nullable
 * `byte_size` column but cannot fill it — the sizes live on disk under the assets ROOT, which the
 * schema/openDatabase layer deliberately does not know (it takes a db file path, not the blob
 * root). So this assetsRoot-aware, idempotent pass runs once from main.ts after openDatabase: it
 * updates exactly the rows still at the NULL sentinel, reading each blob's size from disk. A
 * missing/unreadable blob records 0 rather than crashing the pass (a leftover orphan must never
 * block startup). Idempotent: a second run finds no NULL rows and returns 0.
 *
 * `sizeOf` is injected so the logic is unit-testable under Node without real blobs; it defaults to
 * fs.statSync(path).size.
 */
type SizeOf = (absolutePath: string) => number;

function defaultSizeOf(absolutePath: string): number {
  try {
    return statSync(absolutePath).size;
  } catch {
    return 0; // missing/unreadable blob → count it as 0, never throw
  }
}

interface NullSizedRow {
  id: string;
  relative_path: string;
}

export function backfillAssetSizes(
  db: Database.Database,
  assetsRoot: string,
  sizeOf: SizeOf = defaultSizeOf,
): number {
  const rows = db
    .prepare('SELECT id, relative_path FROM assets WHERE byte_size IS NULL')
    .all() as NullSizedRow[];
  if (rows.length === 0) {
    return 0;
  }
  const update = db.prepare('UPDATE assets SET byte_size = ? WHERE id = ?');
  const apply = db.transaction((items: NullSizedRow[]) => {
    for (const row of items) {
      const bytes = sizeOf(join(assetsRoot, row.relative_path));
      update.run(bytes, row.id);
    }
  });
  apply(rows);
  return rows.length;
}
