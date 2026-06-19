import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { cleanupUserData } from './helpers/cleanup';

const MAIN_ENTRY = resolve(__dirname, '../../out/main/main.js');
const NOTE_TEXT = 'epsilonword: committed before an abrupt kill must survive.';

/*
 * M05.B durability proof (TD-005 remainder, ADR-0014) — DISTINCT from the M04.D-03
 * graceful-quit flush (export-and-search.spec.ts "...survives an IMMEDIATE app quit",
 * which proves the renderer pagehide → note:updateSync handshake). Here a note that is
 * ALREADY committed to SQLite (the autosave debounce fired) must survive an ABRUPT,
 * FORCEFUL process kill: no app.close(), so neither `will-quit` (no checkpoint) nor the
 * window `pagehide` (no D-03 flush) runs. The only thing that can have persisted the note
 * is the committed WAL itself — this exercises the WAL / synchronous=FULL durability layer.
 *
 * Both launches share one userData dir so the relaunched process reads the killed
 * process's SQLite file — a real abrupt-kill → relaunch, not an in-memory simulation.
 */
let userDataDir: string;

function launch(): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY],
    env: { ...process.env, MEETINGSPACE_USER_DATA: userDataDir, MEETINGSPACE_FAKE_LLM: '1' },
  });
}

test.beforeAll(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'meetingspace-durability-'));
});

test.afterAll(() => {
  // Best-effort: the abruptly-killed first process can hold a transient Windows lock on the
  // WAL/shm after termination (gotcha §10), so cleanup of this OS temp dir is not a proof
  // assertion — swallow a residual lock rather than fail the durability test on teardown.
  try {
    cleanupUserData(userDataDir);
  } catch {
    /* OS reclaims the temp dir; the durability assertion already ran in the test body. */
  }
});

test('a committed note survives an abrupt process kill → relaunch (WAL/synchronous=FULL durability)', async () => {
  const first = await launch();
  const firstWindow: Page = await first.firstWindow();
  await firstWindow.waitForLoadState('domcontentloaded');

  await firstWindow.getByRole('button', { name: 'New session' }).click();
  await expect(firstWindow.getByRole('heading', { name: 'Untitled session' })).toBeVisible();
  await firstWindow.getByRole('button', { name: 'Add note or transcript', exact: true }).click();
  await firstWindow.getByRole('textbox', { name: 'Note 1', exact: true }).fill(NOTE_TEXT);

  // Let the ~500ms autosave debounce fire and the IPC write COMMIT to SQLite BEFORE the
  // kill — we are proving a *committed* write survives, not exercising the debounce.
  await firstWindow.waitForTimeout(1_500);

  // ABRUPT, FORCEFUL kill — NOT app.close(). On Windows kill() is TerminateProcess: no
  // before-quit/will-quit (no checkpoint) and no window close/pagehide (no D-03 flush).
  const proc = first.process();
  const exited = new Promise<void>((resolveExit) => proc.once('exit', () => resolveExit()));
  proc.kill('SIGKILL');
  await exited;

  const second = await launch();
  const secondWindow: Page = await second.firstWindow();
  await secondWindow.waitForLoadState('domcontentloaded');

  // The FTS index carries the committed note (the notes_fts trigger ran in the same txn).
  await secondWindow.getByRole('searchbox', { name: /search/i }).fill('epsilonword');
  const result = secondWindow.locator('.search-result').filter({ hasText: /epsilonword/i });
  await expect(result).toBeVisible({ timeout: 5_000 });
  await result.click();

  // SQLite carries the full content after the abrupt kill.
  await expect(secondWindow.getByRole('textbox', { name: 'Note 1', exact: true })).toHaveValue(
    NOTE_TEXT,
  );
  await second.close();
});
