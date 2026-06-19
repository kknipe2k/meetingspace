import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../electron/storage/db';
import { SessionStore } from '../../electron/storage/sessions';

/*
 * Bulk session delete (M06.B, REVIEW-V11 §4 bulk note). deleteSessions loops the EXISTING
 * per-session row delete inside ONE transaction — it does NOT hand-roll a second delete path,
 * so the FK cascade (notes/assets/documents rows) stays the verified one. Blob-directory
 * removal is filesystem (not transactional) and is the IPC handler's job, exercised in
 * tests/ipc/session-handlers.test.ts. Here: row-level orphan-freedom + multi-delete.
 */
let dir: string;
let db: Database.Database;
let store: SessionStore;

function incrementingClock(start = 1_000): () => number {
  let value = start;
  return () => value++;
}

function addNote(id: string, sessionId: string): void {
  db.prepare(
    'INSERT INTO notes (id, session_id, content, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, sessionId, 'text', 0, 1, 1);
}

function addAsset(id: string, sessionId: string): void {
  db.prepare(
    'INSERT INTO assets (id, session_id, kind, relative_path, created_at, byte_size) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, sessionId, 'image', `${sessionId}/${id}.png`, 1, 10);
}

function addDocument(id: string, sessionId: string): void {
  db.prepare(
    'INSERT INTO documents (id, session_id, kind, content, template_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, sessionId, 'whitepaper', '<h1>x</h1>', null, 1);
}

function rowCount(table: string, sessionId: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE session_id = ?`).get(sessionId) as {
      c: number;
    }
  ).c;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meetingspace-bulk-'));
  db = openDatabase(join(dir, 'store.db'));
  store = new SessionStore(db, incrementingClock());
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('SessionStore.deleteSessions (bulk)', () => {
  it('deletes every listed session and cascades to its notes/assets/documents rows', () => {
    const a = store.createSession('A');
    const b = store.createSession('B');
    for (const s of [a, b]) {
      addNote(`note-${s.id}`, s.id);
      addAsset(`asset-${s.id}`, s.id);
      addDocument(`doc-${s.id}`, s.id);
    }

    store.deleteSessions([a.id, b.id]);

    for (const s of [a, b]) {
      expect(store.getSession(s.id)).toBeUndefined();
      expect(rowCount('notes', s.id)).toBe(0);
      expect(rowCount('assets', s.id)).toBe(0);
      expect(rowCount('documents', s.id)).toBe(0);
    }
  });

  it('leaves sessions NOT in the delete set untouched', () => {
    const a = store.createSession('A');
    const keep = store.createSession('Keep');
    addNote('note-keep', keep.id);

    store.deleteSessions([a.id]);

    expect(store.getSession(keep.id)?.name).toBe('Keep');
    expect(rowCount('notes', keep.id)).toBe(1);
  });

  it('is a no-op for an empty list and tolerant of unknown ids', () => {
    const keep = store.createSession('Keep');

    expect(() => store.deleteSessions([])).not.toThrow();
    expect(() => store.deleteSessions(['does-not-exist'])).not.toThrow();
    expect(store.getSession(keep.id)).toBeDefined();
  });
});
