import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SESSION_CHANNELS } from '../../electron/ipc/channels';
import { registerSessionHandlers } from '../../electron/ipc/session-handlers';
import { AssetStore } from '../../electron/storage/assets';
import { openDatabase } from '../../electron/storage/db';
import { SessionStore } from '../../electron/storage/sessions';

// Proves the orphan-cleanup wiring: deleting a session must remove its blob
// directory, not just FK-cascade the rows. main.ts passes
// { afterSessionDelete: id => assetStore.removeSessionAssets(id) } into the
// session handlers; this exercises that hook end to end at the store level.
type Handler = (event: unknown, ...args: unknown[]) => unknown;

let dir: string;
let db: ReturnType<typeof openDatabase>;
let assetsRoot: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meetingspace-sessioncleanup-'));
  assetsRoot = join(dir, 'assets');
  db = openDatabase(join(dir, 'store.db'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('session delete → asset cleanup hook', () => {
  it('removes the session blob directory when the session is deleted', () => {
    const sessions = new SessionStore(db);
    const assets = new AssetStore(db, assetsRoot);
    const sessionId = sessions.createSession('S').id;
    assets.saveBlob(sessionId, 'screenshot', Uint8Array.from([1, 2, 3]), 'png');
    expect(existsSync(join(assetsRoot, sessionId))).toBe(true);

    const handlers = new Map<string, Handler>();
    registerSessionHandlers({ handle: (c, h) => handlers.set(c, h) }, sessions, {
      afterSessionDelete: (id) => assets.removeSessionAssets(id),
    });

    handlers.get(SESSION_CHANNELS.delete)!({}, sessionId);

    expect(existsSync(join(assetsRoot, sessionId))).toBe(false);
    expect(assets.listAssets(sessionId)).toEqual([]);
  });
});
