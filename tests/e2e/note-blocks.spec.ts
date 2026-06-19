import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { cleanupUserData } from './helpers/cleanup';

const MAIN_ENTRY = resolve(__dirname, '../../out/main/main.js');

// The M02.A acceptance proof: multiple note blocks — added, typed into, and
// drag-reordered — survive the app fully closing and relaunching, in the
// reordered sequence. Both launches share one userData dir so the second
// process reads the first's SQLite file (a real close→reopen).
let userDataDir: string;

function launch(): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY],
    env: { ...process.env, MEETINGSPACE_USER_DATA: userDataDir },
  });
}

test.beforeAll(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'meetingspace-noteblocks-'));
});

test.afterAll(() => {
  cleanupUserData(userDataDir);
});

test('note blocks: add, type, drag-reorder, survive close → relaunch', async () => {
  const first: ElectronApplication = await launch();
  const win: Page = await first.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  await win.getByRole('button', { name: 'New session' }).click();
  await expect(win.getByRole('heading', { name: 'Untitled session' })).toBeVisible();

  const addNote = win.getByRole('button', { name: 'Add note or transcript', exact: true });
  await addNote.click();
  await addNote.click();
  await addNote.click();

  await win.getByRole('textbox', { name: 'Note 1', exact: true }).fill('alpha');
  await win.getByRole('textbox', { name: 'Note 2', exact: true }).fill('beta');
  await win.getByRole('textbox', { name: 'Note 3', exact: true }).fill('gamma');

  // Drag the last block (gamma) onto the first (alpha): order → gamma, alpha, beta.
  const lastHandle = win.getByRole('button', { name: 'Reorder note 3', exact: true });
  const firstBlock = win.getByTestId('note-block').first();
  await lastHandle.dragTo(firstBlock);

  await expect(win.getByRole('textbox', { name: 'Note 1', exact: true })).toHaveValue('gamma');

  // Let the autosave debounce + reorder IPC writes reach SQLite.
  await win.waitForTimeout(1_500);
  await first.close();

  const second: ElectronApplication = await launch();
  const win2: Page = await second.firstWindow();
  await win2.waitForLoadState('domcontentloaded');

  await win2.getByRole('button', { name: 'Untitled session', exact: true }).click();

  await expect(win2.getByRole('textbox', { name: 'Note 1', exact: true })).toHaveValue('gamma');
  await expect(win2.getByRole('textbox', { name: 'Note 2', exact: true })).toHaveValue('alpha');
  await expect(win2.getByRole('textbox', { name: 'Note 3', exact: true })).toHaveValue('beta');
  await second.close();
});
