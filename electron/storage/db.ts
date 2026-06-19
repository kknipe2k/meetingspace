import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import { migrate } from './schema';

/*
 * Opens (creating if absent) the SQLite database at `filePath`, applies the
 * connection pragmas, and runs migrations. `foreign_keys` must be set per
 * connection in SQLite — without it the ON DELETE CASCADE wiring is inert.
 *
 * The Electron `userData` path resolution lives in app-paths.ts (the
 * coverage-excluded OS seam); this function takes an explicit path so it is
 * fully testable under Node.
 */
export function openDatabase(filePath: string): Database.Database {
  // Ensure the parent directory exists before better-sqlite3 opens the file (M06.E IRL fix).
  // Electron auto-creates the DEFAULT userData dir, but a fresh or overridden path
  // (MEETINGSPACE_USER_DATA, a first run on a clean machine) has no directory yet, and
  // `new Database()` throws "unable to open database file" / "directory does not exist".
  // recursive:true is idempotent — a no-op when the directory already exists.
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  // synchronous = FULL: fsync the WAL after every commit so a committed write
  // survives a power loss / OS crash, not just an application crash. The bundled
  // SQLite is compiled DEFAULT_WAL_SYNCHRONOUS=1, so WAL mode would otherwise drop
  // to NORMAL (durable across app crashes but able to lose the last txn on power
  // loss). We raise it back to FULL for an autosave notes app where "saved = safe"
  // is the contract; the per-commit fsync cost is immaterial at our debounced write
  // cadence. Set AFTER journal_mode so it isn't overridden by the WAL default. (ADR-0014)
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

/*
 * Graceful shutdown for the DB connection (ADR-0014). Runs a TRUNCATE checkpoint —
 * folding the WAL back into the main file and zeroing the -wal file — then closes the
 * connection. Wired to Electron's `will-quit` in electron/main.ts (the thin OS-call
 * wrapper) so a clean quit leaves a consolidated, lock-free database file; the abrupt-kill
 * path stays safe via the WAL itself (synchronous=FULL above). Kept as a testable seam so
 * the checkpoint/close is exercised under Node and stays load-bearing (mutation-checked).
 */
export function closeDatabase(db: Database.Database): void {
  // Idempotent (M06.C): restore closes the DB BEFORE the file swap (to release the Windows lock),
  // then app.quit() fires the will-quit handler which calls this AGAIN. Checkpointing/closing an
  // already-closed handle throws — which would abort the clean quit and strand a zombie process
  // holding the native module (gotcha §10). A second call is a no-op.
  if (!db.open) {
    return;
  }
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
}
