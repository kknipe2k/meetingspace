import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ASSET_CHANNELS } from '../../electron/ipc/channels';
import { MAX_BLOB_BYTES, registerAssetHandlers } from '../../electron/ipc/asset-handlers';
import { AssetStore } from '../../electron/storage/assets';
import { openDatabase } from '../../electron/storage/db';
import { SessionStore } from '../../electron/storage/sessions';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function fakeRegistrar(): {
  handle: (c: string, h: Handler) => void;
  handlers: Map<string, Handler>;
} {
  const handlers = new Map<string, Handler>();
  return { handle: (channel, handler) => handlers.set(channel, handler), handlers };
}

let dir: string;
let db: ReturnType<typeof openDatabase>;
let handlers: Map<string, Handler>;
let sessionId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meetingspace-assethandlers-'));
  db = openDatabase(join(dir, 'store.db'));
  sessionId = new SessionStore(db).createSession('S').id;
  const registrar = fakeRegistrar();
  registerAssetHandlers(registrar, new AssetStore(db, join(dir, 'assets')));
  handlers = registrar.handlers;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function call(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel);
  if (!handler) {
    throw new Error(`no handler for ${channel}`);
  }
  return handler({}, ...args);
}

function png(byteLength = 4): ArrayBuffer {
  return new Uint8Array(byteLength).fill(7).buffer;
}

describe('asset IPC handlers', () => {
  it('registers exactly the three asset channels', () => {
    expect([...handlers.keys()].sort()).toEqual(
      [ASSET_CHANNELS.save, ASSET_CHANNELS.list, ASSET_CHANNELS.delete].sort(),
    );
  });

  it('save → list → delete round-trips through the handlers', () => {
    const a = call(ASSET_CHANNELS.save, sessionId, png(), 'image/png', 'screenshot') as {
      id: string;
      relativePath: string;
    };
    expect(
      (call(ASSET_CHANNELS.list, sessionId) as Array<{ id: string }>).map((x) => x.id),
    ).toEqual([a.id]);

    call(ASSET_CHANNELS.delete, a.id);
    expect(call(ASSET_CHANNELS.list, sessionId)).toEqual([]);
  });

  it('derives the on-disk extension from the mime type (png/jpeg/webp/gif)', () => {
    const j = call(ASSET_CHANNELS.save, sessionId, png(), 'image/jpeg', 'upload') as {
      relativePath: string;
    };
    expect(j.relativePath.endsWith('.jpg')).toBe(true);
  });

  it('rejects a non-image mime at the main-process boundary', () => {
    expect(() =>
      call(ASSET_CHANNELS.save, sessionId, png(), 'application/x-msdownload', 'upload'),
    ).toThrow();
  });

  it('rejects an oversized blob', () => {
    expect(() =>
      call(ASSET_CHANNELS.save, sessionId, png(MAX_BLOB_BYTES + 1), 'image/png', 'upload'),
    ).toThrow();
  });

  it('rejects an unknown asset kind', () => {
    expect(() => call(ASSET_CHANNELS.save, sessionId, png(), 'image/png', 'malware')).toThrow();
  });

  it('validates argument types at the boundary', () => {
    expect(() => call(ASSET_CHANNELS.save, 123, png(), 'image/png', 'upload')).toThrow(TypeError);
    expect(() => call(ASSET_CHANNELS.save, sessionId, 'not-bytes', 'image/png', 'upload')).toThrow(
      TypeError,
    );
    expect(() => call(ASSET_CHANNELS.list, 123)).toThrow(TypeError);
    expect(() => call(ASSET_CHANNELS.delete, 123)).toThrow(TypeError);
  });
});
