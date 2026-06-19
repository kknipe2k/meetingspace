import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

const MAIN_ENTRY = resolve(__dirname, '../../out/main/main.js');

const PNG_120x80 = Buffer.from(
  readFileSync(resolve(__dirname, 'fixtures/screenshot-120x80.b64'), 'utf8').trim(),
  'base64',
);

/*
 * M04.D acceptance proof (mocked SDK, no key, no network):
 *  - EXPORT: a generated white paper exports to ONE self-contained HTML file that carries
 *    the session screenshot inlined as RAW base64 (no nativeImage decode — C-14 resolved),
 *    a PURE-CSS :target lightbox, and NO <script> (sanitized via the same seam). The native
 *    save dialog is stubbed so the test drives the real assemble→write path headlessly.
 *  - SEARCH: a term typed into the cross-session search box finds the matching session and
 *    clicking the result navigates to it.
 *
 * The in-app preview is text-only by design (the v1 split) — screenshots ride the EXPORT,
 * which is exactly what this asserts.
 */
let app: ElectronApplication;
let window: Page;
let userDataDir: string;
let exportPath: string;

test.beforeEach(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'meetingspace-export-'));
  exportPath = join(userDataDir, 'export-out.html');
  app = await electron.launch({
    args: [MAIN_ENTRY],
    env: { ...process.env, MEETINGSPACE_USER_DATA: userDataDir, MEETINGSPACE_FAKE_LLM: '1' },
  });
  window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
});

test.afterEach(async () => {
  await app.close();
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('exports a generated white paper to a self-contained HTML file with an inlined screenshot', async () => {
  // Stub the native save dialog to write to a known path (the assemble→write path is real).
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath });
  }, exportPath);

  await window.getByRole('button', { name: 'New session' }).click();
  await window.getByRole('button', { name: 'Add note or transcript', exact: true }).click();
  await window.getByRole('textbox', { name: 'Note 1', exact: true }).fill('Kickoff decisions.');
  await window.getByLabel('Add screenshot file').setInputFiles({
    name: 'shot.png',
    mimeType: 'image/png',
    buffer: PNG_120x80,
  });
  await expect(window.getByRole('img', { name: /screenshot 1/i })).toBeVisible();
  await window.waitForTimeout(900); // debounced autosave

  await window.getByRole('button', { name: 'White paper' }).click();
  await window.getByRole('button', { name: 'Generate white paper', exact: true }).click();
  await expect(window.locator('iframe[data-testid="generated-doc-frame"]')).toBeVisible();

  await window.getByRole('button', { name: /export html/i }).click();
  await expect
    .poll(() => readFileSync(exportPath, 'utf8').length, { timeout: 10_000 })
    .toBeGreaterThan(0);

  const html = readFileSync(exportPath, 'utf8');
  expect(html).toMatch(/data:image\/png;base64,[A-Za-z0-9+/]{40,}/); // raw screenshot inlined
  expect(html).toContain('.ms-shot-lb:target'); // pure-CSS lightbox
  expect(html).not.toMatch(/<script/i); // sanitized — the only layer in a browser
});

test('cross-session search finds a note across sessions and navigates to its session', async () => {
  // Session A holds a uniquely-worded note; session B holds another.
  await window.getByRole('button', { name: 'New session' }).click();
  await window.getByRole('button', { name: 'Add note or transcript', exact: true }).click();
  await window.getByRole('textbox', { name: 'Note 1', exact: true }).fill('alphaword planning');

  await window.getByRole('button', { name: 'New session' }).click();
  await window.getByRole('button', { name: 'Add note or transcript', exact: true }).click();
  await window.getByRole('textbox', { name: 'Note 1', exact: true }).fill('betaword retro');
  await window.waitForTimeout(900); // autosave both notes into SQLite (FTS triggers fire)

  // Search for the term unique to session A; clicking the result navigates back to it.
  await window.getByRole('searchbox', { name: /search/i }).fill('alphaword');
  const result = window.locator('.search-result').filter({ hasText: /alphaword/i });
  await expect(result).toBeVisible({ timeout: 5_000 });
  await result.click();

  await expect(window.getByRole('textbox', { name: 'Note 1', exact: true })).toHaveValue(
    'alphaword planning',
  );
});

test('an edit made within the autosave window survives a session switch AND an app restart', async () => {
  // V-2 real-path proof: type a note, then IMMEDIATELY switch sessions (well inside the
  // 500ms debounce) so the note block unmounts mid-window. The unmount flush must persist
  // the edit to SQLite + the FTS index; we then close and relaunch the app on the SAME
  // userDataDir and confirm the edit is BOTH searchable (FTS) and intact (SQLite) — no fake
  // store, the whole renderer→IPC→better-sqlite3→reopen path.
  await window.getByRole('button', { name: 'New session' }).click();
  await window.getByRole('button', { name: 'Add note or transcript', exact: true }).click();
  await window.getByRole('textbox', { name: 'Note 1', exact: true }).fill('gammaword decisions');
  await window.getByRole('button', { name: 'New session' }).click(); // unmount within the window
  await window.waitForTimeout(400); // let the flushed write reach SQLite before we kill the app

  await app.close();
  app = await electron.launch({
    args: [MAIN_ENTRY],
    env: { ...process.env, MEETINGSPACE_USER_DATA: userDataDir, MEETINGSPACE_FAKE_LLM: '1' },
  });
  window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  await window.getByRole('searchbox', { name: /search/i }).fill('gammaword');
  const result = window.locator('.search-result').filter({ hasText: /gammaword/i });
  await expect(result).toBeVisible({ timeout: 5_000 }); // FTS index has it
  await result.click();
  await expect(window.getByRole('textbox', { name: 'Note 1', exact: true })).toHaveValue(
    'gammaword decisions', // SQLite has the full content
  );
});

test('an edit made within the autosave window survives an IMMEDIATE app quit (no session switch)', async () => {
  // V-2/D-03 real-path proof: type a note, then quit the app IMMEDIATELY — within the
  // 500ms debounce, with NO session switch and NO wait. The synchronous pagehide flush
  // (note:updateSync over sendSync) must commit the write before the window closes, so
  // a hard edit-then-quit doesn't lose it. Reopen on the same userDataDir and confirm
  // the note is intact in SQLite + searchable in FTS. No fake store anywhere.
  await window.getByRole('button', { name: 'New session' }).click();
  await window.getByRole('button', { name: 'Add note or transcript', exact: true }).click();
  await window.getByRole('textbox', { name: 'Note 1', exact: true }).fill('deltaword shipped');

  // No waitForTimeout — quit straight away, inside the debounce window.
  await app.close();
  app = await electron.launch({
    args: [MAIN_ENTRY],
    env: { ...process.env, MEETINGSPACE_USER_DATA: userDataDir, MEETINGSPACE_FAKE_LLM: '1' },
  });
  window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  await window.getByRole('searchbox', { name: /search/i }).fill('deltaword');
  const result = window.locator('.search-result').filter({ hasText: /deltaword/i });
  await expect(result).toBeVisible({ timeout: 5_000 }); // FTS index has it
  await result.click();
  await expect(window.getByRole('textbox', { name: 'Note 1', exact: true })).toHaveValue(
    'deltaword shipped', // SQLite has the full content after a hard quit
  );
});
