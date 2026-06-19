import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ArtifactStore } from '../../electron/gen/artifact-store';
import { openDatabase } from '../../electron/storage/db';
import { DEFAULT_SPACE_ID } from '../../electron/storage/schema';

/*
 * Persisted generated artifacts (M04.A): the FOCUS doc (and later whitepaper /
 * minutes / raw) live in a session-scoped `documents` table (migration v3) so
 * Part 2 can re-run without redoing Part 1. The KEY never lands here. FK cascade
 * cleans up a deleted session's artifacts. Clock + id generator injected for
 * determinism.
 */
let dir: string;
let db: Database.Database;

function seedSession(id: string): void {
  const now = Date.now();
  db.prepare(
    'INSERT INTO sessions (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, DEFAULT_SPACE_ID, 'S', now, now);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meetingspace-artifacts-'));
  db = openDatabase(join(dir, 'store.db'));
  seedSession('s1');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ArtifactStore', () => {
  it('saves a FOCUS artifact and reads it back as the latest of its kind', () => {
    const store = new ArtifactStore(
      db,
      () => 1000,
      () => 'doc-1',
    );

    const saved = store.saveArtifact({
      sessionId: 's1',
      kind: 'focus',
      content: 'the focus doc',
      templateId: 'default',
    });

    expect(saved).toMatchObject({
      id: 'doc-1',
      sessionId: 's1',
      kind: 'focus',
      content: 'the focus doc',
    });
    expect(store.getLatestArtifact('s1', 'focus')).toEqual(saved);
  });

  it('returns the newest artifact of a kind when Part 1 is re-run', () => {
    let clock = 1000;
    let n = 0;
    const store = new ArtifactStore(
      db,
      () => (clock += 10),
      () => `doc-${(n += 1)}`,
    );

    store.saveArtifact({ sessionId: 's1', kind: 'focus', content: 'first', templateId: null });
    const second = store.saveArtifact({
      sessionId: 's1',
      kind: 'focus',
      content: 'second',
      templateId: null,
    });

    expect(store.getLatestArtifact('s1', 'focus')?.content).toBe('second');
    expect(store.getLatestArtifact('s1', 'focus')?.id).toBe(second.id);
  });

  it('lists every artifact for a session', () => {
    let n = 0;
    const store = new ArtifactStore(
      db,
      () => 1000,
      () => `doc-${(n += 1)}`,
    );
    store.saveArtifact({ sessionId: 's1', kind: 'focus', content: 'a', templateId: null });
    store.saveArtifact({ sessionId: 's1', kind: 'focus', content: 'b', templateId: null });

    expect(store.getArtifacts('s1')).toHaveLength(2);
  });

  it('returns null when no artifact of the kind exists yet', () => {
    expect(new ArtifactStore(db).getLatestArtifact('s1', 'whitepaper')).toBeNull();
  });

  it('getLatestArtifacts returns ONE row per kind, newest-first (F16 — not every revision)', () => {
    let clock = 1000;
    let n = 0;
    const store = new ArtifactStore(
      db,
      () => (clock += 10),
      () => `doc-${(n += 1)}`,
    );
    // Three whitepaper revisions + two minutes revisions — a well-used session.
    store.saveArtifact({
      sessionId: 's1',
      kind: 'whitepaper',
      content: 'wp-v1',
      templateId: 'default',
    });
    store.saveArtifact({ sessionId: 's1', kind: 'minutes', content: 'min-v1', templateId: null });
    store.saveArtifact({
      sessionId: 's1',
      kind: 'whitepaper',
      content: 'wp-v2',
      templateId: 'default',
    });
    store.saveArtifact({
      sessionId: 's1',
      kind: 'whitepaper',
      content: 'wp-v3',
      templateId: 'default',
    });
    const newestMinutes = store.saveArtifact({
      sessionId: 's1',
      kind: 'minutes',
      content: 'min-v2',
      templateId: null,
    });

    const latest = store.getLatestArtifacts('s1');

    // Exactly one row per kind that exists (no dozens of revisions crossing IPC).
    expect(latest).toHaveLength(2);
    expect(latest.map((d) => `${d.kind}:${d.content}`).sort()).toEqual([
      'minutes:min-v2',
      'whitepaper:wp-v3',
    ]);
    // Newest-first so the renderer can pick the most-recently generated mode to reopen on.
    expect(latest[0]).toEqual(newestMinutes);
  });

  it('cascade-deletes a session’s artifacts when the session is removed (no orphans)', () => {
    const store = new ArtifactStore(
      db,
      () => 1000,
      () => 'doc-1',
    );
    store.saveArtifact({ sessionId: 's1', kind: 'focus', content: 'x', templateId: null });

    db.prepare('DELETE FROM sessions WHERE id = ?').run('s1');

    expect(store.getArtifacts('s1')).toEqual([]);
  });
});
