import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ArtifactStore, ARTIFACT_RETENTION_PER_KIND } from '../../electron/gen/artifact-store';
import { openDatabase } from '../../electron/storage/db';
import { DEFAULT_SPACE_ID } from '../../electron/storage/schema';

/*
 * Revision retention (M06.B, REVIEW-V11 F27 — owner decision A: keep last N=10 per (session,
 * kind)). Only latest-per-kind is surfaced anywhere (F16), so unbounded revisions are invisible
 * growth. saveArtifact prunes older revisions of the same kind past the cap; pruning is by
 * recency (newest kept) and never crosses kinds. The storage meter (F28) still shows the rest.
 */
let dir: string;
let db: Database.Database;

function seedSession(id: string): void {
  db.prepare(
    'INSERT INTO sessions (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, DEFAULT_SPACE_ID, 'S', 1, 1);
}

function makeStore(): ArtifactStore {
  let clock = 1000;
  let seq = 0;
  return new ArtifactStore(
    db,
    () => clock++,
    () => `doc-${(seq += 1).toString().padStart(3, '0')}`,
  );
}

function countOfKind(sessionId: string, kind: string): number {
  return (
    db
      .prepare('SELECT COUNT(*) AS c FROM documents WHERE session_id = ? AND kind = ?')
      .get(sessionId, kind) as { c: number }
  ).c;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meetingspace-retention-'));
  db = openDatabase(join(dir, 'store.db'));
  seedSession('s1');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ArtifactStore revision retention', () => {
  it('exposes a retention cap of 10 per kind', () => {
    expect(ARTIFACT_RETENTION_PER_KIND).toBe(10);
  });

  it('saveArtifact keeps only the newest N revisions of a kind', () => {
    const store = makeStore();
    const total = ARTIFACT_RETENTION_PER_KIND + 2; // 12
    let last: string | null = null;
    for (let i = 0; i < total; i += 1) {
      const doc = store.saveArtifact({
        sessionId: 's1',
        kind: 'whitepaper',
        content: `<h1>rev ${i}</h1>`,
        templateId: null,
      });
      last = doc.id;
    }

    expect(countOfKind('s1', 'whitepaper')).toBe(ARTIFACT_RETENTION_PER_KIND);
    // The most-recent revision survives and is still the latest.
    expect(store.getLatestArtifact('s1', 'whitepaper')?.id).toBe(last);
    // The oldest two revisions were pruned.
    expect(store.getArtifacts('s1').some((d) => d.content === '<h1>rev 0</h1>')).toBe(false);
    expect(store.getArtifacts('s1').some((d) => d.content === '<h1>rev 1</h1>')).toBe(false);
  });

  it('prunes per kind — minutes revisions are unaffected by whitepaper saves', () => {
    const store = makeStore();
    store.saveArtifact({ sessionId: 's1', kind: 'minutes', content: 'M', templateId: null });
    for (let i = 0; i < ARTIFACT_RETENTION_PER_KIND + 5; i += 1) {
      store.saveArtifact({
        sessionId: 's1',
        kind: 'whitepaper',
        content: `<h1>${i}</h1>`,
        templateId: null,
      });
    }

    expect(countOfKind('s1', 'whitepaper')).toBe(ARTIFACT_RETENTION_PER_KIND);
    expect(countOfKind('s1', 'minutes')).toBe(1);
  });

  it('pruneArtifacts is idempotent — re-running below the cap deletes nothing', () => {
    const store = makeStore();
    store.saveArtifact({ sessionId: 's1', kind: 'whitepaper', content: 'a', templateId: null });
    store.saveArtifact({ sessionId: 's1', kind: 'whitepaper', content: 'b', templateId: null });

    expect(store.pruneArtifacts('s1', 'whitepaper')).toBe(0);
    expect(countOfKind('s1', 'whitepaper')).toBe(2);
  });
});
