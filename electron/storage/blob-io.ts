import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/*
 * The blob-serving security boundary (CLAUDE.md §10, M02.B). Two concerns live
 * here, both fully testable under Node so the ≥95% safety-primitive gate covers
 * them (docs/gates.md M02): (1) path confinement — every resolved blob path is
 * proven to stay within the assets root, rejecting traversal; (2) thin fs
 * wrappers for writing/removing blob files under that root.
 *
 * electron/asset-protocol.ts is the only thing on top of this: a one-line
 * protocol.handle registration that delegates to createAssetResponder. The
 * handler logic — including the ../ rejection — is the covered code here.
 */

/*
 * Resolves `<assetsRoot>/<sessionId>/<filename>` and returns it only if it stays
 * inside the assets root. Any segment that climbs out (`..`, an absolute path, a
 * `..` sessionId) yields null — the caller treats null as a hard reject. This is
 * the single confinement primitive both the write path and the serve path use.
 */
export function confinedAssetPath(
  assetsRoot: string,
  sessionId: string,
  filename: string,
): string | null {
  if (!sessionId || !filename) {
    return null;
  }
  const root = resolve(assetsRoot);
  const target = resolve(root, sessionId, filename);
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    return null;
  }
  return target;
}

type FileFetcher = (fileUrl: string) => Promise<Response> | Response;

const THUMB_SUFFIX = '.thumb.jpg';

/*
 * Optional existence/listing deps (M06.E). When supplied, the responder verifies a file is present
 * before fetching it and applies the missing-thumbnail fallback (below); without them it keeps the
 * original behavior (always fetch the confined path). Injected so the logic stays Node-testable;
 * production wires real fs (electron/asset-protocol.ts).
 */
export interface AssetFallbackDeps {
  fileExists(absolutePath: string): boolean;
  /** Filenames directly under the given session directory; [] if it doesn't exist. */
  listDir(directoryAbsolutePath: string): string[];
}

/*
 * Builds the asset:// protocol handler callback. Parses `asset://<sessionId>/
 * <file>`, decodes the path (so a percent-encoded `%2e%2e` traversal is revealed
 * before confinement, not after), confines it to the assets root, and streams
 * the file through the injected fetcher (net.fetch in production). A request that
 * escapes the root — encoded path traversal or a `..` host — is rejected with
 * 400 and the fetcher is never called. `net.fetch` is injected so this callback
 * is exercised directly in tests without an Electron runtime.
 *
 * Missing-thumbnail fallback (M06.E, resolves an M06.C-origin defect): when `deps` are supplied and
 * a requested `<id>.thumb.jpg` doesn't exist (never generated for a tiny/undecodable image, or a
 * pre-M06.C asset), serve the FULL-RES SIBLING for the SAME id instead of letting net.fetch hit a
 * dead path (which logged a renderer ERR_UNEXPECTED console error). The sibling is resolved within
 * the assets root for the same confined session + id — no new servable surface; a traversal or a
 * foreign id still 4xx's. Genuine absence (no thumb, no sibling) returns a clean 404, never an error.
 */
export function createAssetResponder(
  assetsRoot: string,
  fetchFile: FileFetcher,
  deps?: AssetFallbackDeps,
): (request: { url: string }) => Promise<Response> {
  return async (request) => {
    let parsed: URL;
    try {
      parsed = new URL(request.url);
    } catch {
      return new Response('bad asset request', { status: 400 });
    }
    const sessionId = parsed.host;
    let filename: string;
    try {
      filename = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
    } catch {
      return new Response('bad asset request', { status: 400 });
    }
    const absolutePath = confinedAssetPath(assetsRoot, sessionId, filename);
    if (!absolutePath) {
      return new Response('forbidden', { status: 400 });
    }
    // No deps → original behavior (fetch the confined path directly).
    if (!deps) {
      return fetchFile(pathToFileURL(absolutePath).toString());
    }
    if (deps.fileExists(absolutePath)) {
      return fetchFile(pathToFileURL(absolutePath).toString());
    }
    // The requested file is absent. For a missing thumbnail, fall back to the full-res sibling so
    // the grid never triggers a console resource error; everything else is a clean 404.
    if (filename.endsWith(THUMB_SUFFIX)) {
      const sibling = resolveFullResSibling(assetsRoot, sessionId, filename, deps);
      if (sibling) {
        return fetchFile(pathToFileURL(sibling).toString());
      }
    }
    return new Response('not found', { status: 404 });
  };
}

/*
 * Resolve the full-res sibling for a missing `<id>.thumb.jpg` request: the file `<id>.<ext>` in the
 * same session directory (the thumbnail's source extension was discarded by the path convention, so
 * the sibling is found by listing the confined dir, not by guessing the extension). Returns the
 * confined absolute path or null. Containment: the directory is confined to the assets root and the
 * matched filename is re-confined via confinedAssetPath, so a `..` row or a path climb can't escape.
 */
function resolveFullResSibling(
  assetsRoot: string,
  sessionId: string,
  thumbFilename: string,
  deps: AssetFallbackDeps,
): string | null {
  const root = resolve(assetsRoot);
  const sessionDir = resolve(root, sessionId);
  const rel = relative(root, sessionDir);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    return null;
  }
  const idPrefix = `${thumbFilename.slice(0, -THUMB_SUFFIX.length)}.`; // "<id>."
  for (const entry of deps.listDir(sessionDir)) {
    if (entry === thumbFilename || !entry.startsWith(idPrefix) || entry.endsWith(THUMB_SUFFIX)) {
      continue;
    }
    const candidate = confinedAssetPath(assetsRoot, sessionId, entry);
    if (candidate && deps.fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function writeBlobFile(absolutePath: string, bytes: Uint8Array): void {
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, bytes);
}

export function removeBlobFile(absolutePath: string): void {
  rmSync(absolutePath, { force: true });
}

export function removeSessionDir(assetsRoot: string, sessionId: string): void {
  if (!sessionId) {
    return;
  }
  const root = resolve(assetsRoot);
  const dir = resolve(root, sessionId);
  const rel = relative(root, dir);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    return;
  }
  rmSync(dir, { recursive: true, force: true });
}
