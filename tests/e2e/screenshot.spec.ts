import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

const MAIN_ENTRY = resolve(__dirname, '../../out/main/main.js');

// A real 1×1 PNG so net.fetch over the asset:// scheme serves valid bytes the
// <img> can actually decode (naturalWidth > 0), not just a 200.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

// The M02.B acceptance proof: an uploaded screenshot stores a blob on disk and
// renders as a thumbnail served by the scoped asset:// protocol, and survives a
// full close → relaunch (read back from the per-session blob file).
let userDataDir: string;

function launch(): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY],
    env: { ...process.env, MEETINGSPACE_USER_DATA: userDataDir },
  });
}

test.beforeAll(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'meetingspace-screenshot-'));
});

test.afterAll(() => {
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('an uploaded screenshot renders via asset:// and survives close → relaunch', async () => {
  const first: ElectronApplication = await launch();
  const win: Page = await first.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  await win.getByRole('button', { name: 'New session' }).click();
  await expect(win.getByRole('heading', { name: 'Untitled session' })).toBeVisible();

  await win.getByLabel('Add screenshot file').setInputFiles({
    name: 'shot.png',
    mimeType: 'image/png',
    buffer: PNG_1x1,
  });

  const thumb = win.getByRole('img', { name: /screenshot 1/i });
  await expect(thumb).toBeVisible();
  // Served from disk over asset:// and actually decoded by the renderer.
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
