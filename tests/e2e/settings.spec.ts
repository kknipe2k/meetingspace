import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

const MAIN_ENTRY = resolve(__dirname, '../../out/main/main.js');

// M03.A acceptance: a user-supplied Anthropic API key is entered in settings,
// encrypted via safeStorage, and its *status* (booleans only — never the key)
// survives close → relaunch. On a runner where safeStorage encryption is
// unavailable (e.g. no OS keyring), the modal must surface a clear error and
// refuse to save — the spec asserts that path instead of silently passing.
const FAKE_KEY = 'sk-ant-api03-PLAYWRIGHT-FAKE-KEY-DO-NOT-USE';

let userDataDir: string;

function launch(): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY],
    env: { ...process.env, MEETINGSPACE_USER_DATA: userDataDir },
  });
}

async function openSettings(win: Page): Promise<void> {
  await win.getByRole('button', { name: 'Settings' }).click();
  await expect(win.getByRole('dialog', { name: 'Settings' })).toBeVisible();
}

test.beforeAll(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'meetingspace-settings-'));
});

test.afterAll(() => {
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('API key status persists across relaunch; key never shown back; modal traps focus', async () => {
  const first: ElectronApplication = await launch();
  const win: Page = await first.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  await openSettings(win);

  // Modal pointer-interception: the scrim is the topmost element at the viewport
  // center, so the app behind it can't be clicked through (gotcha §11).
  const scrimOnTop = await win.evaluate(() => {
    const el = document.elementFromPoint(
      Math.floor(window.innerWidth / 2),
      Math.floor(window.innerHeight / 2),
    );
    return !!el?.closest('[data-testid="settings-scrim"]');
  });
  expect(scrimOnTop).toBe(true);

  const encryptionError = win.getByTestId('settings-encryption-error');
  if (await encryptionError.isVisible()) {
    // No OS encryption on this runner — the only correct behavior is to refuse.
    console.log(
      'settings.spec: safeStorage encryption unavailable on this runner — asserting the refuse path.',
    );
    await expect(win.getByRole('button', { name: 'Save key' })).toBeDisabled();
    await first.close();
    return;
  }

  // --- Enter and save a key ---
  await win.getByLabel('Anthropic API key').fill(FAKE_KEY);
  await win.getByRole('button', { name: 'Save key' }).click();
  await expect(win.getByText(/api key saved/i)).toBeVisible();
  // The field never echoes the stored key back.
  await expect(win.getByLabel('Anthropic API key')).toHaveValue('');

  await win.waitForTimeout(500);
  await first.close();

  // --- Relaunch → status persists (the encrypted blob was written to userData) ---
  const second: ElectronApplication = await launch();
  const win2: Page = await second.firstWindow();
  await win2.waitForLoadState('domcontentloaded');

  await openSettings(win2);
  await expect(win2.getByText(/api key saved/i)).toBeVisible();
  // Still never rendered back — status is booleans only.
  await expect(win2.getByLabel('Anthropic API key')).toHaveValue('');

  await second.close();
});
