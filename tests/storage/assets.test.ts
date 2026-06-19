import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AssetStore } from '../../electron/storage/assets';
import { openDatabase } from '../../electron/storage/db';
import { SessionStore } from '../../electron/storage/sessions';

// A deterministic id generator so blob filenames are predictable under test
// (the real store uses randomUUID). Bytes are tiny Uint8Arrays — the store does
// not care about image validity, only that bytes round-trip to disk.
function sequentialIds(prefix = 'asset'): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

let dir: string;
let assetsRoot: string;
let db: ReturnType<typeof openDatabase>;
let sessions: SessionStore;
let assets: AssetStore;
let sessionId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meetingspace-assets-'));
  assetsRoot = join(dir, 'assets');
  db = openDatabase(join(dir, 'store.db'));
  sessions = new SessionStore(db);
  assets = new AssetStore(db, assetsRoot, undefined, sequentialIds());
  sessionId = sessions.createSession('Capture').id;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('AssetStore.saveBlob', () => {
  it('writes a blob file plus a row, with an id-derived filename (never user input)', () => {
    const asset = assets.saveBlob(sessionId, 'screenshot', bytes(1, 2, 3, 4), 'png');

    expect(asset.sessionId).toBe(sessionId);
    expect(asset.kind).toBe('screenshot');
    expect(asset.relativePath).toBe(`${sessionId}/asset-1.png`);

    const onDisk = join(assetsRoot, sessionId, 'asset-1.png');
    expect(existsSync(onDisk)).toBe(true);
    expect(readFileSync(onDisk)).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it('lists a session’s assets and scopes the listing to that session', () => {
    const other = sessions.createSession('Other').id;
    const a = assets.saveBlob(sessionId, 'upload', bytes(9), 'jpg');
    assets.saveBlob(other, 'paste', bytes(8), 'png');

    expect(assets.listAssets(sessionId).map((x) => x.id)).toEqual([a.id]);
  });

  it('rejects an unknown session and leaves no orphan blob file behind', () => {
    expect(() => assets.saveBlob('no-such-session', 'upload', bytes(1), 'png')).toThrow();
    // The unknown-session pre-check fires before any disk write — no dir created.
    expect(existsSync(join(assetsRoot, 'no-such-session'))).toBe(false);
  });

  it('refuses to write when the generated id would escape the assets root (defense in depth)', () => {
    // Even if id generation were ever compromised to yield a traversal segment,
    // confinement must still reject it — no file is written.
    const escaping = new AssetStore(db, assetsRoot, undefined, () => '../../evil');
    expect(() => escaping.saveBlob(sessionId, 'upload', bytes(1), 'png')).toThrow(
      /outside the assets root/,
    );
  });

  it('unlinks the written blob when the row insert fails (no blob without a row)', () => {
    const onlyId = new AssetStore(db, assetsRoot, undefined, () => 'fixed-id');
    db.exec('DROP TABLE assets'); // force the INSERT to fail after the file write
    expect(() => onlyId.saveBlob(sessionId, 'upload', bytes(1), 'png')).toThrow();
    expect(existsSync(join(assetsRoot, sessionId, 'fixed-id.png'))).toBe(false);
  });
});

describe('AssetStore.deleteAsset', () => {
  it('removes the blob file and its row, leaving siblings intact', () => {
    const a = assets.saveBlob(sessionId, 'upload', bytes(1), 'png');
    const b = assets.saveBlob(sessionId, 'upload', bytes(2), 'png');

    assets.deleteAsset(a.id);

    expect(existsSync(join(assetsRoot, a.relativePath))).toBe(false);
    expect(existsSync(join(assetsRoot, b.relativePath))).toBe(true);
    expect(assets.listAssets(sessionId).map((x) => x.id)).toEqual([b.id]);
  });

  it('is a no-op when the asset id does not exist', () => {
    expect(() => assets.deleteAsset('no-such-asset')).not.toThrow();
  });
});

describe('AssetStore orphan safety on session delete', () => {
  it('removeSessionAssets deletes the session blob directory (FK only drops rows)', () => {
    assets.saveBlob(sessionId, 'screenshot', bytes(1), 'png');
    assets.saveBlob(sessionId, 'screenshot', bytes(2), 'png');
    expect(readdirSync(join(assetsRoot, sessionId))).toHaveLength(2);

    assets.removeSessionAssets(sessionId);

    expect(existsSync(join(assetsRoot, sessionId))).toBe(false);
  });

  it('removeSessionAssets is idempotent when the directory is already gone', () => {
    expect(() => assets.removeSessionAssets('never-had-assets')).not.toThrow();
  });

  it('leaves no orphan blob: after row-cascade + dir cleanup, the tree is empty for the session', () => {
    assets.saveBlob(sessionId, 'screenshot', bytes(1), 'png');

    sessions.deleteSession(sessionId); // FK cascade drops the asset rows
    assets.removeSessionAssets(sessionId); // explicit file cleanup

    expect(assets.listAssets(sessionId)).toEqual([]);
    expect(existsSync(join(assetsRoot, sessionId))).toBe(false);
  });
});
