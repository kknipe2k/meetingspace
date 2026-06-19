import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  confinedAssetPath,
  createAssetResponder,
  removeSessionDir,
  writeBlobFile,
} from '../../electron/storage/blob-io';

// The security boundary of the blob-serving layer (CLAUDE.md §10, M02.B scope
// lock): no request may resolve to a path outside the assets root. These tests
// exercise BOTH the pure confinement primitive AND the responder callback the
// protocol handler delegates to — the traversal request must be rejected by the
// handler itself, not only by the helper (per the M02.B plan refinement).
const ROOT = resolve('/tmp/meetingspace-assets-root');
const SESSION = 'session-abc';

describe('confinedAssetPath', () => {
  it('resolves a legitimate in-root blob path', () => {
    const path = confinedAssetPath(ROOT, SESSION, 'id-1.png');
    expect(path).toBe(resolve(ROOT, SESSION, 'id-1.png'));
  });

  it('rejects a filename that climbs out of the assets root', () => {
    expect(confinedAssetPath(ROOT, SESSION, '../../secret.txt')).toBeNull();
  });

  it('rejects a sessionId that climbs out of the assets root', () => {
    expect(confinedAssetPath(ROOT, '../../etc', 'passwd')).toBeNull();
  });

  it('rejects an absolute filename', () => {
    const absolute = `${resolve('/etc/passwd')}`;
    expect(confinedAssetPath(ROOT, SESSION, absolute)).toBeNull();
  });

  it('rejects empty segments', () => {
    expect(confinedAssetPath(ROOT, '', 'x.png')).toBeNull();
    expect(confinedAssetPath(ROOT, SESSION, '')).toBeNull();
  });
});

describe('createAssetResponder (the protocol handler callback)', () => {
  it('serves an in-root blob via the injected file fetcher', async () => {
    const fetchFile = vi.fn(async (fileUrl: string) => new Response(fileUrl, { status: 200 }));
    const respond = createAssetResponder(ROOT, fetchFile);

    const response = await respond({ url: `asset://${SESSION}/id-1.png` });

    expect(response.status).toBe(200);
    expect(fetchFile).toHaveBeenCalledTimes(1);
    // The fetched URL is a file:// URL pointing at the confined absolute path
    // (pathToFileURL emits forward slashes on every platform).
    const fetched = fetchFile.mock.calls[0]![0];
    expect(fetched.startsWith('file://')).toBe(true);
    expect(decodeURIComponent(fetched)).toContain(`${SESSION}/id-1.png`);
  });

  // The WHATWG URL parser collapses a raw `/../../` pathname before the handler
  // sees it, so the real post-normalization attack vectors are (a) PERCENT-
  // ENCODED traversal in the path and (b) a host segment of `..`. The handler
  // must reject both with 400 and never reach the file fetcher.
  it('REJECTS a percent-encoded ../ traversal through the handler with 400 and never fetches', async () => {
    const fetchFile = vi.fn(async () => new Response('should-not-happen', { status: 200 }));
    const respond = createAssetResponder(ROOT, fetchFile);

    const response = await respond({ url: `asset://${SESSION}/%2e%2e%2f%2e%2e%2fsecret.txt` });

    expect(response.status).toBe(400);
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it('REJECTS a host that climbs out of the assets root (asset://../secret) with 400', async () => {
    const fetchFile = vi.fn(async () => new Response('should-not-happen', { status: 200 }));
    const respond = createAssetResponder(ROOT, fetchFile);

    const response = await respond({ url: 'asset://../secret.txt' });

    expect(response.status).toBe(400);
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it('rejects an empty-host url with 400', async () => {
    const fetchFile = vi.fn(async () => new Response('x', { status: 200 }));
    const respond = createAssetResponder(ROOT, fetchFile);

    const response = await respond({ url: 'asset://' });

    expect(response.status).toBe(400);
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it('rejects an unparseable url with 400', async () => {
    const fetchFile = vi.fn(async () => new Response('x', { status: 200 }));
    const respond = createAssetResponder(ROOT, fetchFile);

    const response = await respond({ url: '::::not a url::::' });

    expect(response.status).toBe(400);
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it('rejects a path with malformed percent-encoding with 400', async () => {
    const fetchFile = vi.fn(async () => new Response('x', { status: 200 }));
    const respond = createAssetResponder(ROOT, fetchFile);

    // `%E0%A4%A` is an incomplete UTF-8 sequence — decodeURIComponent throws.
    const response = await respond({ url: `asset://${SESSION}/%E0%A4%A` });

    expect(response.status).toBe(400);
    expect(fetchFile).not.toHaveBeenCalled();
  });
});

/*
 * Missing-thumbnail fallback (M06.E; resolves an M06.C-origin defect). When the renderer requests
 * a `<id>.thumb.jpg` that was never generated (a tiny/undecodable image, or a pre-M06.C asset
 * before backfill), the old behavior let net.fetch hit a non-existent file → a renderer
 * "Failed to load resource: net::ERR_UNEXPECTED" console error (which release-smoke's zero-console-
 * errors bar catches). With fallback deps, the responder serves the FULL-RES SIBLING for the same
 * id instead — 200, no error, render unaffected. Containment is preserved: the sibling is resolved
 * within the assets root for the SAME requested id; a traversal or foreign-id request still 4xx's.
 */
describe('createAssetResponder — missing-thumbnail fallback (M06.E)', () => {
  const fullAbs = resolve(ROOT, SESSION, 'id-1.png');
  const thumbAbs = resolve(ROOT, SESSION, 'id-1.thumb.jpg');
  const ok = () => vi.fn(async (u: string) => new Response(u, { status: 200 }));

  it('serves the full-res sibling when the requested .thumb.jpg is absent', async () => {
    const fetchFile = ok();
    const respond = createAssetResponder(ROOT, fetchFile, {
      fileExists: (abs) => abs === fullAbs, // thumb absent, full-res present
      listDir: () => ['id-1.png', 'id-2.png'],
    });

    const response = await respond({ url: `asset://${SESSION}/id-1.thumb.jpg` });

    expect(response.status).toBe(200);
    const fetched = decodeURIComponent(fetchFile.mock.calls[0]![0]);
    expect(fetched).toContain(`${SESSION}/id-1.png`);
    expect(fetched).not.toContain('thumb');
  });

  it('serves the thumbnail directly when it DOES exist (the normal path)', async () => {
    const fetchFile = ok();
    const respond = createAssetResponder(ROOT, fetchFile, {
      fileExists: (abs) => abs === thumbAbs,
      listDir: () => ['id-1.png'],
    });

    const response = await respond({ url: `asset://${SESSION}/id-1.thumb.jpg` });

    expect(response.status).toBe(200);
    expect(decodeURIComponent(fetchFile.mock.calls[0]![0])).toContain(`${SESSION}/id-1.thumb.jpg`);
  });

  it('returns a clean 404 (never errors) when neither thumb nor any sibling exists', async () => {
    const fetchFile = ok();
    const respond = createAssetResponder(ROOT, fetchFile, {
      fileExists: () => false,
      listDir: () => [],
    });

    const response = await respond({ url: `asset://${SESSION}/id-1.thumb.jpg` });

    expect(response.status).toBe(404);
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it('never serves a DIFFERENT asset id (foreign sibling) — 404', async () => {
    const fetchFile = ok();
    const respond = createAssetResponder(ROOT, fetchFile, {
      fileExists: () => false,
      listDir: () => ['other-id.png'], // a sibling exists, but not for id-1
    });

    const response = await respond({ url: `asset://${SESSION}/id-1.thumb.jpg` });

    expect(response.status).toBe(404);
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it('still REJECTS a percent-encoded traversal thumb request with 400 (containment preserved)', async () => {
    const fetchFile = ok();
    const respond = createAssetResponder(ROOT, fetchFile, {
      fileExists: () => true,
      listDir: () => ['secret.png'],
    });

    const response = await respond({ url: `asset://${SESSION}/%2e%2e%2f%2e%2e%2fid.thumb.jpg` });

    expect(response.status).toBe(400);
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it('returns 404 for a missing FULL-RES (non-thumb) request rather than fetching a dead path', async () => {
    const fetchFile = ok();
    const respond = createAssetResponder(ROOT, fetchFile, {
      fileExists: () => false,
      listDir: () => ['id-1.png'],
    });

    const response = await respond({ url: `asset://${SESSION}/id-1.png` });

    expect(response.status).toBe(404);
    expect(fetchFile).not.toHaveBeenCalled();
  });
});

describe('removeSessionDir', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'meetingspace-rmdir-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('removes a confined session directory', () => {
    const root = join(dir, 'assets');
    writeBlobFile(join(root, 'sess', 'a.png'), Uint8Array.from([1]));
    expect(existsSync(join(root, 'sess'))).toBe(true);

    removeSessionDir(root, 'sess');

    expect(existsSync(join(root, 'sess'))).toBe(false);
  });

  it('is a no-op for an empty sessionId', () => {
    const root = join(dir, 'assets');
    writeBlobFile(join(root, 'keep', 'a.png'), Uint8Array.from([1]));

    removeSessionDir(root, '');

    expect(existsSync(join(root, 'keep'))).toBe(true);
  });

  it('refuses to remove anything outside the assets root', () => {
    const root = join(dir, 'assets');
    writeBlobFile(join(root, 'keep', 'a.png'), Uint8Array.from([1]));
    const sentinel = join(dir, 'sibling.txt');
    writeFileSync(sentinel, 'do not delete');

    // A `..` sessionId would resolve to `dir` itself — the guard must reject it.
    removeSessionDir(root, '..');

    expect(existsSync(sentinel)).toBe(true);
    expect(existsSync(root)).toBe(true);
  });
});
