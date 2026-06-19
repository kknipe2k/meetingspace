import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { cleanupUserData } from './helpers/cleanup';

const MAIN_ENTRY = resolve(__dirname, '../../out/main/main.js');

let app: ElectronApplication;
let window: Page;
let userDataDir: string;
const consoleErrors: string[] = [];

test.beforeAll(async () => {
  // Isolate the launched app's storage so the CRUD pass never touches the
  // developer's real session data (MEETINGSPACE_USER_DATA, app-paths.ts).
  userDataDir = mkdtempSync(join(tmpdir(), 'meetingspace-e2e-'));
  app = await electron.launch({
    args: [MAIN_ENTRY],
    env: { ...process.env, MEETINGSPACE_USER_DATA: userDataDir },
  });
  window = await app.firstWindow();
  window.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  window.on('pageerror', (error) => {
    consoleErrors.push(error.message);
  });
  await window.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app.close();
  cleanupUserData(userDataDir);
});

test('opens exactly one window', () => {
  expect(app.windows()).toHaveLength(1);
});

test('renders the three-zone shell', async () => {
  await expect(window.getByTestId('zone-sidebar')).toBeVisible();
  await expect(window.getByTestId('zone-canvas')).toBeVisible();
  await expect(window.getByTestId('zone-llm-panel')).toBeVisible();
});

test('loads with no console errors', () => {
  expect(consoleErrors).toEqual([]);
});

test('renderer is sandboxed: bridge exposed, no Node require reachable', async () => {
  const exposure = await window.evaluate(() => {
    const surface = window as unknown as { api?: object; require?: unknown };
    return {
      hasApi: typeof surface.api !== 'undefined',
      hasRequire: typeof surface.require !== 'undefined',
      apiKeys: Object.keys(surface.api ?? {}).sort(),
    };
  });

  expect(exposure.hasApi).toBe(true);
  expect(exposure.hasRequire).toBe(false);
  // The full bridge surface as of M06: M06.A added `app`, M06.B `storage`, M06.D `catalog`+`usage`
  // (alongside the original meta/sessions/notes/assets/capture/settings/llm/gen/search).
  expect(exposure.apiKeys).toEqual([
    'app',
    'assets',
    'capture',
    'catalog',
    'gen',
    'llm',
    'meta',
    'notes',
    'search',
    'sessions',
    'settings',
    'storage',
    'usage',
  ]);
});

test('creates, renames, and deletes a session through the UI over real IPC', async () => {
  await window.getByRole('button', { name: 'New session' }).click();
  await expect(window.getByRole('heading', { name: 'Untitled session' })).toBeVisible();

  await window.getByRole('button', { name: 'Rename Untitled session' }).click();
  const nameField = window.getByRole('textbox', { name: 'Session name' });
  await nameField.fill('Sprint planning');
  await nameField.press('Enter');

  await expect(window.getByRole('heading', { name: 'Sprint planning' })).toBeVisible();
  await expect(window.getByRole('heading', { name: 'Untitled session' })).toHaveCount(0);

  // M06.B (F10): delete is immediate-with-Undo — no confirm step. The session leaves the list and
  // the canvas returns to empty; an Undo toast offers recovery.
  await window.getByRole('button', { name: 'Delete Sprint planning' }).click();

  await expect(window.getByTestId('zone-canvas').getByText('No session selected')).toBeVisible();
  expect(consoleErrors).toEqual([]);
});
