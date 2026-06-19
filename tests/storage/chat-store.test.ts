import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../electron/storage/db';
import { DEFAULT_SPACE_ID } from '../../electron/storage/schema';
import { ChatStore } from '../../electron/storage/chat-store';
import { SessionStore } from '../../electron/storage/sessions';

/*
 * ChatStore (ADR-0020) — DB-backed in-session conversation persistence. Mirrors NoteStore's
 * injected-db + clock + id pattern so ordering and timestamps are deterministic. The thread
 * is what gives the model multi-turn memory AND survives reload.
 */
let dir: string;

function freshDb(): ReturnType<typeof openDatabase> {
  dir = mkdtempSync(join(tmpdir(), 'meetingspace-chatstore-'));
  const db = openDatabase(join(dir, 'store.db'));
  // A session to attach messages to (FK).
  db.prepare(
    'INSERT INTO sessions (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run('s1', DEFAULT_SPACE_ID, 'S', 1, 1);
  return db;
}

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ChatStore', () => {
  it('appends and lists messages in chronological order with role + content', () => {
    const db = freshDb();
    try {
      let t = 100;
      const store = new ChatStore(db, () => t++);
      store.appendMessage({ sessionId: 's1', role: 'user', content: 'q1' });
      store.appendMessage({ sessionId: 's1', role: 'assistant', content: 'a1', model: 'm-1' });
      store.appendMessage({ sessionId: 's1', role: 'user', content: 'q2' });

      const list = store.listMessages('s1');
      expect(list.map((m) => [m.role, m.content])).toEqual([
        ['user', 'q1'],
        ['assistant', 'a1'],
        ['user', 'q2'],
      ]);
      // The answering model rides the assistant row; user rows have none.
      expect(list[1]?.model).toBe('m-1');
      expect(list[0]?.model ?? null).toBeNull();
    } finally {
      db.close();
    }
  });

  it('scopes messages to their session', () => {
    const db = freshDb();
    try {
      db.prepare(
        'INSERT INTO sessions (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).run('s2', DEFAULT_SPACE_ID, 'S2', 1, 1);
      const store = new ChatStore(db);
      store.appendMessage({ sessionId: 's1', role: 'user', content: 'only-s1' });
      store.appendMessage({ sessionId: 's2', role: 'user', content: 'only-s2' });

      expect(store.listMessages('s1').map((m) => m.content)).toEqual(['only-s1']);
      expect(store.listMessages('s2').map((m) => m.content)).toEqual(['only-s2']);
    } finally {
      db.close();
    }
  });

  it('persists across reopen (the thread survives reload)', () => {
    dir = mkdtempSync(join(tmpdir(), 'meetingspace-chatreload-'));
    const path = join(dir, 'store.db');
    const db1 = openDatabase(path);
    try {
      db1
        .prepare(
          'INSERT INTO sessions (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run('s1', DEFAULT_SPACE_ID, 'S', 1, 1);
      new ChatStore(db1).appendMessage({ sessionId: 's1', role: 'user', content: 'remember me' });
    } finally {
      db1.close();
    }
    const db2 = openDatabase(path);
    try {
      expect(new ChatStore(db2).listMessages('s1').map((m) => m.content)).toEqual(['remember me']);
    } finally {
      db2.close();
    }
  });

  it('a deleted session removes its thread (cascade — orphan-free)', () => {
    const db = freshDb();
    try {
      const store = new ChatStore(db);
      store.appendMessage({ sessionId: 's1', role: 'user', content: 'q' });
      new SessionStore(db).deleteSession('s1');
      expect(store.listMessages('s1')).toEqual([]);
    } finally {
      db.close();
    }
  });
});
