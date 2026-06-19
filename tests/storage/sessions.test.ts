import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../electron/storage/db';
import { DEFAULT_SPACE_ID } from '../../electron/storage/schema';
import { SessionStore } from '../../electron/storage/sessions';

// An injected, strictly increasing clock makes timestamp-ordered behavior
// (listSessions, updatedAt bumps) deterministic without depending on the wall
// clock (docs/style.md — no reliance on real time without explicit seeding).
function incrementingClock(start = 1_000): () => number {
  let value = start;
  return () => value++;
}

let dir: string;
let db: ReturnType<typeof openDatabase>;
let store: SessionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meetingspace-sessions-'));
  db = openDatabase(join(dir, 'store.db'));
  store = new SessionStore(db, incrementingClock());
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('SessionStore sessions', () => {
  it('round-trips a created session unchanged through getSession', () => {
    const created = store.createSession('Design review');

    expect(store.getSession(created.id)).toEqual(created);
  });

  it('assigns a stable, unique id and attaches the session to the default space', () => {
    const a = store.createSession('A');
    const b = store.createSession('B');

    expect(a.id).not.toBe('');
    expect(b.id).not.toBe(a.id);
    expect(store.getSession(a.id)?.id).toBe(a.id);
    expect(a.spaceId).toBe(DEFAULT_SPACE_ID);
  });

  it('returns undefined for an unknown session id', () => {
    expect(store.getSession('does-not-exist')).toBeUndefined();
  });

  it('renames a session and the new name persists', () => {
    const session = store.createSession('Old name');

    store.renameSession(session.id, 'New name');

    expect(store.getSession(session.id)?.name).toBe('New name');
  });

  it('lists sessions most-recently-updated first', () => {
    const a = store.createSession('A');
    const b = store.createSession('B');
    expect(store.listSessions().map((s) => s.id)).toEqual([b.id, a.id]);

    store.renameSession(a.id, 'A renamed');

    expect(store.listSessions().map((s) => s.id)).toEqual([a.id, b.id]);
  });
});

describe('SessionStore deletion', () => {
  it('cascades deletion to the session’s notes and assets', () => {
    const session = store.createSession('Doomed');
    // Note blocks now live in NoteStore (M02.A); insert a note row directly here
    // to prove the ON DELETE CASCADE wiring fires for notes and assets alike.
    db.prepare(
      'INSERT INTO notes (id, session_id, content, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('note-1', session.id, 'note text', 0, 1, 1);
    db.prepare(
      'INSERT INTO assets (id, session_id, kind, relative_path, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('asset-1', session.id, 'image', 'shot.png', 123);

    store.deleteSession(session.id);

    expect(store.getSession(session.id)).toBeUndefined();
    const notes = db.prepare('SELECT id FROM notes WHERE session_id = ?').all(session.id) as Array<{
      id: string;
    }>;
    expect(notes).toHaveLength(0);
    const assets = db
      .prepare('SELECT id FROM assets WHERE session_id = ?')
      .all(session.id) as Array<{ id: string }>;
    expect(assets).toHaveLength(0);
  });
});
