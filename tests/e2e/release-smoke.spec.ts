import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

const MAIN_ENTRY = resolve(__dirname, '../../out/main/main.js');

/*
 * M05.C RELEASE ACCEPTANCE (scope.md success criteria #1–#3): the whole v1 primary
 * flow runs end-to-end in the BUILT app with zero console errors —
 *   new session → note → screenshot → grounded chat → generate white paper →
 *   self-contained HTML export → cross-session search.
 *
 * Runs against the electron-vite `out/` build (the same harness every other e2e uses),
 * with the mocked SDK seam (MEETINGSPACE_FAKE_LLM=1 → canned-stream client + fake key
 * reader: no live key, no network). The PACKAGED NSIS build is the manual IRL teeth
 * check, not this e2e — so this never claims to run against the installer.
 *
 * This is a characterization of already-shipped M01–M04 behavior composed into one
 * release pass; it is expected to be green on arrival. Its job is to FAIL the release
 * if any leg of the primary flow regresses under packaging-stage changes.
 */
const PNG_1x1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const FAKE_ANSWER = 'Based on your notes, here is what I found.';

let app: ElectronApplication;
let window: Page;
let userDataDir: string;
let exportPath: string;
const consoleErrors: string[] = [];

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'meetingspace-release-'));
  exportPath = join(userDataDir, 'release-export.html');
  app = await electron.launch({
    args: [MAIN_ENTRY],
    env: { ...process.env, MEETINGSPACE_USER_DATA: userDataDir, MEETINGSPACE_FAKE_LLM: '1' },
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
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('release acceptance: the full primary flow runs end-to-end in the built app with no console errors', async () => {
  // Stub the native save dialog so the real assemble→write export path runs headlessly.
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath });
  }, exportPath);

  // --- New session ---
  await window.getByRole('button', { name: 'New session' }).click();
  await expect(window.getByRole('heading', { name: 'Untitled session' })).toBeVisible();

  // --- Note ---
  await window.getByRole('button', { name: 'Add note or transcript', exact: true }).click();
  await window
    .getByRole('textbox', { name: 'Note 1', exact: true })
    .fill('We decided to ship MeetingSpace v1. Owner: Kurt.');

  // --- Screenshot (file-upload path) ---
  await window.getByLabel('Add screenshot file').setInputFiles({
    name: 'shot.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_1x1_B64, 'base64'),
  });
  await expect(window.getByRole('img', { name: /screenshot 1/i })).toBeVisible();
  await window.waitForTimeout(900); // debounced autosave reaches SQLite + FTS

  // --- Grounded chat (mocked SDK seam) ---
  const composer = window.getByRole('textbox', { name: 'Ask Claude about this session' });
  await composer.fill('What did we decide?');
  await window.getByRole('button', { name: 'Send message' }).click();
  await expect(window.getByText(FAKE_ANSWER)).toBeVisible();

  // --- Generate white paper ---
  await window.getByRole('button', { name: 'White paper' }).click();
  await window.getByRole('button', { name: 'Generate white paper', exact: true }).click();
  await expect(window.locator('iframe[data-testid="generated-doc-frame"]')).toBeVisible();

  // --- Self-contained HTML export (sanitized, no script) ---
  await window.getByRole('button', { name: /export html/i }).click();
  await expect
    .poll(() => readFileSync(exportPath, 'utf8').length, { timeout: 10_000 })
    .toBeGreaterThan(0);
  const html = readFileSync(exportPath, 'utf8');
  expect(html).not.toMatch(/<script/i); // the generated-HTML control holds in the export

  // --- Cross-session search finds the session's note ---
  // Single-token term: FTS5 highlights each matched token separately, so a multi-word
  // hasText isn't a contiguous substring of the snippet (the export-and-search pattern).
  await window.getByRole('searchbox', { name: /search/i }).fill('MeetingSpace');
  await expect(window.locator('.search-result').filter({ hasText: /MeetingSpace/i })).toBeVisible({
    timeout: 5_000,
  });

  // The release bar: a clean primary-flow run with zero console errors.
  expect(consoleErrors).toEqual([]);
});
