import { existsSync, readdirSync } from 'node:fs';

import { net, protocol } from 'electron';

import { createAssetResponder } from './storage/blob-io';

/*
 * The scoped blob-serving protocol (M02.B, §10 security boundary). Thumbnails in
 * the sandboxed renderer load from `asset://<sessionId>/<file>`; this is the only
 * way image bytes reach the renderer — no raw file:// path, no arbitrary-read
 * channel. The handler logic (parse → confine to the assets root → reject ../
 * with 400 → stream) lives in the Node-tested createAssetResponder; the two
 * functions here are the thin Electron registration wrappers (the only lines not
 * unit-covered, like preload.ts / main.ts).
 *
 * Web-verified for Electron 41 (protocol.registerSchemesAsPrivileged +
 * protocol.handle + net.fetch; protocol.registerFileProtocol is deprecated).
 */
export const ASSET_SCHEME = 'asset';

/*
 * Must run before the app `ready` event — registering a privileged scheme later
 * has no effect. Standard + secure so the renderer treats it like a normal
 * origin; supportFetchAPI + stream so <img> and fetch can load from it.
 */
export function registerAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ASSET_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

export function registerAssetProtocol(assetsRoot: string): void {
  // The fs deps activate the missing-thumbnail fallback (M06.E): a `<id>.thumb.jpg` that was never
  // generated serves the full-res sibling instead of erroring (the responder keeps confinement).
  // Thin OS wrappers (coverage-excluded, like the rest of this registration); the fallback logic +
  // its containment are the Node-tested createAssetResponder seam.
  const respond = createAssetResponder(assetsRoot, (fileUrl) => net.fetch(fileUrl), {
    fileExists: (absolutePath) => existsSync(absolutePath),
    listDir: (directoryAbsolutePath) => {
      try {
        return readdirSync(directoryAbsolutePath);
      } catch {
        return [];
      }
    },
  });
  protocol.handle(ASSET_SCHEME, (request) => respond({ url: request.url }));
}
