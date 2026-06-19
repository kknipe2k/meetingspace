import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase } from '../../electron/storage/db';
import { NoteStore } from '../../electron/storage/notes';
import { SessionStore } from '../../electron/storage/sessions';

/*
 * M05.B durability seam (TD-005 remainder, ADR-0014). The quit-time checkpoint/close
 * logic lives in `closeDatabase` so it is fully testable under Node; the real
 * `app.on('will-quit', …)` registration in electron/main.ts is the thin OS-call wrapper
 * (coverage-excluded, same pattern as the M01–M04 main-process injections).
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meetingspace-durability-'));
});

afterEach(() => {
  // retries: a killed/queried SQLite handle can briefly hold the file on Windows (gotcha §10).
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('closeDatabase — quit-time checkpoint + close (M05.B / ADR-0014)', () => {
  it('checkpoints (truncates the WAL) and closes the connection, leaving committed data intact on reopen', () => {
    const path = join(dir, 'durable.db');
    const db = openDatabase(path);
    const session = new SessionStore(db).createSession('Durable');
    const block = new NoteStore(db).addNote(session.id);
    new NoteStore(db).updateNote(block.id, 'survive the checkpoint');

    // Committed-but-uncheckpointed frames sit in the -wal file until a checkpoint folds
    // them back into the main DB (the autocheckpoint threshold, 1000 pages, isn't hit).
    const walPath = `${path}-wal`;
    expect(existsSync(walPath) && statSync(walPath).size > 0).toBe(true);

    closeDatabase(db);

    // After wal_checkpoint(TRUNCATE) + close the WAL is gone or zero-length (mutation #1:
    // making closeDatabase a no-op leaves the WAL populated → this fails)...
    expect(existsSync(walPath) ? statSync(walPath).size : 0).toBe(0);
    // ...and the connection is actually closed (pins db.close() independently)...
    expect(db.open).toBe(false);

    // ...and every committed row survives on reopen (no regression to close→reopen→intact).
    const reopened = openDatabase(path);
    expect(new SessionStore(reopened).getSession(session.id)?.name).toBe('Durable');
    expect(new NoteStore(reopened).listNotes(session.id)[0]?.content).toBe(
      'survive the checkpoint',
    );
    reopened.close();
  });

  it('is idempotent — a second closeDatabase is a safe no-op (M06.C: restore closes pre-swap, then will-quit closes again)', () => {
    // Restore closes the DB BEFORE the file swap (to release the Windows lock); the subsequent
    // app.quit() then fires the will-quit handler, which calls closeDatabase AGAIN. A naive
    // checkpoint-on-a-closed-handle throws — which would abort the clean quit and strand a zombie
    // process holding the native module (gotcha §10). So the second call must no-op.
    const db = openDatabase(join(dir, 'idempotent.db'));
    closeDatabase(db);
    expect(db.open).toBe(false);
    expect(() => closeDatabase(db)).not.toThrow(); // mutation: drop the open-guard → this throws
  });

  it('opens the database at synchronous = FULL (2) — power-loss durable, raised explicitly per ADR-0014', () => {
    // The app's bundled SQLite is compiled with DEFAULT_SYNCHRONOUS=2 but
    // DEFAULT_WAL_SYNCHRONOUS=1, so once WAL is active and the first write txn runs
    // (migrate()), synchronous drops to NORMAL (1) — the phase-doc premise was correct.
    // openDatabase now RAISES it back to FULL (2) to close the power-loss durability gap
    // (a committed txn is fsync'd, surviving power loss; the cost is immaterial at our
    // debounced write cadence — ADR-0014). This test fails (mutation #2) if the pragma is
    // reverted to NORMAL. The abrupt-kill e2e does NOT discriminate the level (app-crash
    // durability is synchronous-independent), so this seam test is the pragma's guard.
    const db = openDatabase(join(dir, 'sync.db'));
    expect(db.pragma('synchronous', { simple: true })).toBe(2);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    db.close();
  });
});
