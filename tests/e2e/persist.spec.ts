import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { cleanupUserData } from './helpers/cleanup';

const MAIN_ENTRY = resolve(__dirname, '../../out/main/main.js');
const NOTE_TEXT = 'Decisions: ship M01 after the persist proof.';

// The headline M01 acceptance proof: a note typed into a session survives the
// app fully closing and relaunching. Both launches share one userData dir
// (MEETINGSPACE_USER_DATA, app-paths.ts) so the second process reads the first
// process's SQLite file — a real close→reopen, not an in-memory simulation.
let userDataDir: string;

function launch(): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY],
    env: { ...process.env, MEETINGSPACE_USER_DATA: userDataDir },
  });
}

test.beforeAll(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'meetingspace-persist-'));
});

test.afterAll(() => {
  cleanupUserData(userDataDir);
});

test('a typed note block survives close → relaunch → reopen intact', async () => {
  const first: ElectronApplication = await launch();
  const firstWindow: Page = await first.firstWindow();
  await firstWindow.waitForLoadState('domcontentloaded');

  await firstWindow.getByRole('button', { name: 'New session' }).click();
  await expect(firstWindow.getByRole('heading', { name: 'Untitled session' })).toBeVisible();

  await firstWindow.getByRole('button', { name: 'Add note or transcript', exact: true }).click();
  await firstWindow.getByRole('textbox', { name: 'Note 1', exact: true }).fill(NOTE_TEXT);

  // Let the ~500ms autosave debounce fire and the IPC write reach SQLite.
  await firstWindow.waitForTimeout(1_500);
  await first.close();

  const second: ElectronApplication = await launch();
  const secondWindow: Page = await second.firstWindow();
  await secondWindow.waitForLoadState('domcontentloaded');

  // Exact match: the plain session name also appears in the "Rename/Delete
  // Untitled session" action aria-labels (M01.C gotcha — name over-matching).
  await secondWindow.getByRole('button', { name: 'Untitled session', exact: true }).click();

  await expect(secondWindow.getByRole('textbox', { name: 'Note 1', exact: true })).toHaveValue(
    NOTE_TEXT,
  );
  await second.close();
});
