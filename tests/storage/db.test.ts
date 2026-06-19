import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../electron/storage/db';
import { NoteStore } from '../../electron/storage/notes';
import { DEFAULT_SPACE_ID } from '../../electron/storage/schema';
import { SessionStore } from '../../electron/storage/sessions';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meetingspace-db-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('openDatabase', () => {
  it('creates the database file and schema when the path does not exist', () => {
    const path = join(dir, 'fresh.db');
    expect(existsSync(path)).toBe(false);

    const db = openDatabase(path);

    expect(existsSync(path)).toBe(true);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(tables).toEqual(expect.arrayContaining(['spaces', 'sessions', 'notes', 'assets']));
    db.close();
  });

  it('creates a missing parent directory before opening (fresh/overridden userData path)', () => {
    // M06.E IRL fix: a fresh machine or a MEETINGSPACE_USER_DATA override points at a
    // directory Electron has not auto-created, so better-sqlite3 would throw "unable to open
    // database file". openDatabase now mkdir -p's the parent first.
    const nestedDir = join(dir, 'does', 'not', 'exist', 'yet');
    const path = join(nestedDir, 'fresh.db');
    expect(existsSync(nestedDir)).toBe(false);

    const db = openDatabase(path);

    expect(existsSync(path)).toBe(true);
    db.close();
  });

  it('seeds exactly one default space', () => {
    const db = openDatabase(join(dir, 'seed.db'));

    const spaces = db.prepare('SELECT id FROM spaces').all() as Array<{ id: string }>;

    expect(spaces).toHaveLength(1);
    expect(spaces[0]?.id).toBe(DEFAULT_SPACE_ID);
    db.close();
  });

  it('enables foreign-key enforcement on the connection', () => {
    const db = openDatabase(join(dir, 'fk.db'));

    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('runs migrations idempotently: reopening does not duplicate the seeded space', () => {
    const path = join(dir, 'idempotent.db');
    openDatabase(path).close();

    const db = openDatabase(path);

    const count = db.prepare('SELECT COUNT(*) AS c FROM spaces').get() as { c: number };
    expect(count.c).toBe(1);
    db.close();
  });

  it('persists a session and its note block across close and reopen', () => {
    const path = join(dir, 'persist.db');
    const first = openDatabase(path);
    const session = new SessionStore(first).createSession('Kickoff');
    const block = new NoteStore(first).addNote(session.id);
    new NoteStore(first).updateNote(block.id, 'agenda: ship M01');
    first.close();

    const second = openDatabase(path);

    expect(new SessionStore(second).getSession(session.id)?.name).toBe('Kickoff');
    expect(new NoteStore(second).listNotes(session.id)[0]?.content).toBe('agenda: ship M01');
    second.close();
  });
});
