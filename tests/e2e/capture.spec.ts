import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { cleanupUserData } from './helpers/cleanup';

const MAIN_ENTRY = resolve(__dirname, '../../out/main/main.js');

// The M02.C acceptance proof (Windows-first): in-app desktopCapturer capture
// stores a blob via the Stage B pipeline (kind='capture') and survives a full
// close → relaunch. The CI e2e job runs on windows-latest; if that runner can't
// enumerate a capturable desktop (no screen sources) this test SKIPS with a
// printed reason rather than failing — the capture service seam is unit-tested
// (tests/unit/screen-capture.test.ts) and never silently passes. macOS is
// documented but not gated (gotcha §4).
let userDataDir: string;

function launch(): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY],
    env: { ...process.env, MEETINGSPACE_USER_DATA: userDataDir },
  });
}

test.beforeAll(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'meetingspace-capture-'));
});

test.afterAll(() => {
  cleanupUserData(userDataDir);
});

test('an in-app screen capture stores a blob and survives close → relaunch', async () => {
  const first: ElectronApplication = await launch();
  const win: Page = await first.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  await win.getByRole('button', { name: 'New session' }).click();
  await expect(win.getByRole('heading', { name: 'Untitled session' })).toBeVisible();

  await win.getByRole('button', { name: 'Capture screen' }).click();
  const dialog = win.getByRole('dialog');
  await expect(dialog).toBeVisible();

  const sources = dialog.getByTestId('capture-source');
  const sourceCount = await sources.count();
  if (sourceCount === 0) {
    console.log('capture.spec: no capturable desktop on this runner — skipping the grab path.');
    await first.close();
    test.skip(true, 'desktopCapturer enumerated no screen sources on this runner');
    return;
  }

  await sources.first().click();

  const thumb = win.getByRole('img', { name: /screenshot 1/i });
  await expect(thumb).toBeVisible();
  await expect
    .poll(() => thumb.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);

  await win.waitForTimeout(500);
  await first.close();

  const second: ElectronApplication = await launch();
  const win2: Page = await second.firstWindow();
  await win2.waitForLoadState('domcontentloaded');
  await win2.getByRole('button', { name: 'Untitled session', exact: true }).click();

  const thumb2 = win2.getByRole('img', { name: /screenshot 1/i });
  await expect(thumb2).toBeVisible();
  await expect
    .poll(() => thumb2.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  await second.close();
});
