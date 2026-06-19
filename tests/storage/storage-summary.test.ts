import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../electron/storage/db';
import { DEFAULT_SPACE_ID } from '../../electron/storage/schema';
import {
  StorageStore,
  crossesStorageThreshold,
  STORAGE_THRESHOLD_BYTES,
} from '../../electron/storage/storage-store';

/*
 * Storage meter (M06.B, REVIEW-V11 F28). Per-session + total byte accounting from one cheap
 * query: notes.content bytes + documents.content bytes + assets.byte_size (migration v6). The
 * threshold helper is a pure function so the "you're using a lot of storage" nudge is testable
 * without a UI.
 */
let dir: string;
let db: Database.Database;

function seedSession(id: string, name: string): void {
  db.prepare(
    'INSERT INTO sessions (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, DEFAULT_SPACE_ID, name, 1, 1);
}

function addNote(id: string, sessionId: string, content: string): void {
  db.prepare(
    'INSERT INTO notes (id, session_id, content, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, sessionId, content, 0, 1, 1);
}

function addDocument(id: string, sessionId: string, content: string): void {
  db.prepare(
    'INSERT INTO documents (id, session_id, kind, content, template_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, sessionId, 'whitepaper', content, null, 1);
}

function addAsset(id: string, sessionId: string, byteSize: number): void {
  db.prepare(
    'INSERT INTO assets (id, session_id, kind, relative_path, created_at, byte_size) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, sessionId, 'image', `${sessionId}/${id}.png`, 1, byteSize);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meetingspace-storage-'));
  db = openDatabase(join(dir, 'store.db'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('StorageStore.summary', () => {
  it('sums notes + documents + assets bytes per session', () => {
    seedSession('s1', 'Alpha');
    addNote('n1', 's1', 'hello'); // 5 bytes
    addNote('n2', 's1', 'world!'); // 6 bytes
    addDocument('d1', 's1', '<h1>x</h1>'); // 10 bytes
    addAsset('a1', 's1', 100);
    addAsset('a2', 's1', 200);

    const summary = new StorageStore(db).summary();
    const s1 = summary.perSession.find((s) => s.sessionId === 's1');
    expect(s1).toBeDefined();
    expect(s1?.name).toBe('Alpha');
    expect(s1?.bytes).toBe(5 + 6 + 10 + 100 + 200);
  });

  it('reports each session and a total across all sessions', () => {
    seedSession('s1', 'Alpha');
    seedSession('s2', 'Beta');
    addNote('n1', 's1', 'aaaa'); // 4
    addAsset('a1', 's2', 50);

    const summary = new StorageStore(db).summary();
    expect(summary.perSession.map((s) => s.sessionId).sort()).toEqual(['s1', 's2']);
    expect(summary.totalBytes).toBe(4 + 50);
  });

  it('reports a session with no content as zero bytes (not absent)', () => {
    seedSession('s1', 'Empty');

    const summary = new StorageStore(db).summary();
    const s1 = summary.perSession.find((s) => s.sessionId === 's1');
    expect(s1?.bytes).toBe(0);
  });
});

describe('crossesStorageThreshold', () => {
  it('is false below the threshold and true at/above it', () => {
    expect(crossesStorageThreshold(STORAGE_THRESHOLD_BYTES - 1)).toBe(false);
    expect(crossesStorageThreshold(STORAGE_THRESHOLD_BYTES)).toBe(true);
    expect(crossesStorageThreshold(STORAGE_THRESHOLD_BYTES + 1)).toBe(true);
  });
});
