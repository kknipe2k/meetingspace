import { rmSync } from 'node:fs';

/**
 * Best-effort removal of an e2e temp user-data dir.
 *
 * Each e2e spec launches the real Electron app against a throwaway user-data dir
 * and deletes it in teardown. On Windows the app can briefly hold the SQLite file
 * handle (`meetingspace.db`) after it closes, so a hard `rmSync` can throw `EBUSY`
 * even though the test itself passed — and because that throw happens in
 * `afterAll`/`finally`, it fails the whole Playwright worker (which test-level
 * retries can't rescue). Leaking an OS temp dir on an ephemeral CI runner is
 * harmless; failing the run on a cleanup race is a false red. So: retry, then
 * swallow.
 */
export function cleanupUserData(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    // Best-effort: ignore EBUSY / locked-file races on teardown.
  }
}
