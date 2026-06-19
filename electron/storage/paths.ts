import { join } from 'node:path';

/*
 * Resolves the on-disk directory for one session's asset blobs (screenshots,
 * uploaded images) under a given assets root. Pure path math — the assets root
 * itself comes from the Electron `userData` dir via app-paths.ts. Blob I/O
 * lands in M02; M01 only needs the deterministic per-session location.
 */
export function sessionAssetDir(assetsRoot: string, sessionId: string): string {
  return join(assetsRoot, sessionId);
}
