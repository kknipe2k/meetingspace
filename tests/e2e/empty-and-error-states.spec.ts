import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

const MAIN_ENTRY = resolve(__dirname, '../../out/main/main.js');

/*
 * M05.A acceptance: every app surface has a designed empty / loading / error state
 * (docs/design-specs/M05A-states.md). Launched WITHOUT MEETINGSPACE_FAKE_LLM and with a
 * fresh userData (no key), so the key-error affordance is exercised on the REAL path:
 * with no key configured, asking a question surfaces the typed NO_KEY error + Open
 * Settings (the M03 taxonomy, reused — no new error model). No live network is reached
 * because the key check fails before any SDK call.
 */
let app: ElectronApplication;
let window: Page;
let userDataDir: string;

function launch(): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY, '--force-device-scale-factor=1'],
    env: { ...process.env, MEETINGSPACE_USER_DATA: userDataDir },
  });
}

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'meetingspace-states-'));
  app = await launch();
  window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app.close();
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('fresh app shows the no-session empty state in the canvas and the assistant panel', async () => {
  // Both the canvas and the assistant panel carry a no-session empty state — scope each.
  await expect(window.getByTestId('zone-canvas').getByText('No session selected')).toBeVisible();
  await expect(window.getByTestId('zone-llm-panel').getByText('No session selected')).toBeVisible();
  // The no-session canvas offers a primary action to create one (distinct label from the
  // sidebar's always-present "New session" button, so each is unambiguously targetable).
  await expect(
    window.getByTestId('zone-canvas').getByRole('button', { name: 'Create a session' }),
  ).toBeVisible();
});

test('a new empty session shows the no-notes and no-screenshots empty states', async () => {
  await window.getByTestId('zone-sidebar').getByRole('button', { name: 'New session' }).click();
  await expect(window.getByRole('heading', { name: 'Untitled session' })).toBeVisible();

  await expect(window.getByText('No notes yet')).toBeVisible();
  await expect(window.getByText('No screenshots yet')).toBeVisible();
  // The capture/add affordances stay available alongside the empty state.
  await expect(
    window.getByRole('button', { name: 'Add note or transcript', exact: true }),
  ).toBeVisible();
});

test('asking a question with no key shows the typed key error + Open Settings', async () => {
  const composer = window.getByRole('textbox', { name: 'Ask Claude about this session' });
  await composer.fill('What did we decide?');
  await window.getByRole('button', { name: 'Send message' }).click();

  // The M03 NO_KEY taxonomy message + the per-code affordance (not Retry).
  await expect(window.getByText(/no anthropic api key is configured/i)).toBeVisible();
  await expect(window.getByRole('button', { name: 'Open Settings' })).toBeVisible();
});

test('search with no match shows the empty-result state and does not crash', async () => {
  const search = window.getByRole('searchbox', { name: 'Search all sessions' });
  await search.fill('zzzznomatchanywhere');
  await expect(window.getByText(/no matches across your sessions/i)).toBeVisible();
  // App still responsive afterwards (the canvas heading is still there).
  await expect(window.getByRole('heading', { name: 'Untitled session' })).toBeVisible();
});

test('the assistant panel collapses to a drawer below ~960px (TD-003)', async () => {
  // Pin a narrow content size below the collapse threshold.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(720, 720);
  });
  await window.waitForTimeout(200); // let the media-query reflow settle

  const toggle = window.getByRole('button', { name: 'Toggle assistant panel' });
  await expect(toggle).toBeVisible();
  // Drawer starts closed: the assistant zone is hidden until toggled.
  await expect(window.getByTestId('zone-llm-panel')).not.toBeVisible();

  await toggle.click();
  await expect(window.getByTestId('zone-llm-panel')).toBeVisible();

  // Widening restores the three-zone layout and hides the toggle.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800);
  });
  await window.waitForTimeout(200);
  await expect(window.getByTestId('zone-llm-panel')).toBeVisible();
  await expect(toggle).not.toBeVisible();
});
