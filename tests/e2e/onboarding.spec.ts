import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { cleanupUserData } from './helpers/cleanup';

const MAIN_ENTRY = resolve(__dirname, '../../out/main/main.js');

/*
 * First-run onboarding (M06.E): on a truly fresh install the welcome flow appears, sets up a
 * sample space, and then NEVER appears again (the seen flag persists). Both launches share one
 * temp userData dir so the second process reads the first's prefs — a real close → relaunch.
 *
 * The first launch opts into the first-run overlay with MEETINGSPACE_FIRST_RUN=1; every OTHER
 * e2e (which only sets MEETINGSPACE_USER_DATA) has onboarding suppressed so the existing suite
 * isn't gated by it. The second launch here omits FIRST_RUN and proves the overlay stays gone.
 */
let userDataDir: string;

function launch(firstRun: boolean): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY],
    env: {
      ...process.env,
      MEETINGSPACE_USER_DATA: userDataDir,
      ...(firstRun ? { MEETINGSPACE_FIRST_RUN: '1' } : {}),
    },
  });
}

test.beforeAll(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'meetingspace-onboarding-'));
});

test.afterAll(() => {
  cleanupUserData(userDataDir);
});

test('onboarding appears once on first run, seeds a sample space, and never returns', async () => {
  const first: ElectronApplication = await launch(true);
  const firstWindow: Page = await first.firstWindow();
  await firstWindow.waitForLoadState('domcontentloaded');

  // The first-run overlay is visible.
  const getStarted = firstWindow.getByRole('button', { name: /get started/i });
  await expect(getStarted).toBeVisible();

  // Complete it (no key) → a sample space is seeded and the overlay closes.
  await getStarted.click();
  await expect(firstWindow.getByRole('button', { name: /get started/i })).toHaveCount(0);
  await expect(firstWindow.getByText('Welcome to MeetingSpace').first()).toBeVisible();
  await firstWindow.waitForTimeout(500); // let the setPrefs(onboardingSeen) write land
  await first.close();

  // Relaunch (no FIRST_RUN): the overlay must NOT reappear; the sample space persists.
  const second: ElectronApplication = await launch(false);
  const secondWindow: Page = await second.firstWindow();
  await secondWindow.waitForLoadState('domcontentloaded');

  await expect(secondWindow.getByText('Welcome to MeetingSpace').first()).toBeVisible();
  await expect(secondWindow.getByRole('button', { name: /get started/i })).toHaveCount(0);
  await second.close();
});
