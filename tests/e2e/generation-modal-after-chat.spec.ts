import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { cleanupUserData } from './helpers/cleanup';

const MAIN_ENTRY = resolve(__dirname, '../../out/main/main.js');

/*
 * M06.D post-IRL #1 regression: opening the generation modal AFTER a chat turn rendered a
 * white/blank box instead of the persisted artifact on the FIRST open (correct only on a reopen).
 * jsdom can't lay out or paint an iframe, so this is validated in real Electron: the exact
 * sequence — generate (persist) → close → chat a turn → reopen — and on that FIRST reopen the
 * generated-doc frame must be VISIBLE, have a NON-ZERO box, and carry the persisted artifact in
 * `srcdoc` (the frame is sandbox="" / opaque-origin, so the outer box + srcdoc is the observable
 * surface). Runs on the mocked SDK seam (no live key, no network).
 */
test.describe('generation modal after a chat turn (post-IRL #1)', () => {
  let app: ElectronApplication;
  let window: Page;
  let userDataDir: string;
  const consoleErrors: string[] = [];

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'meetingspace-modalchat-'));
    app = await electron.launch({
      args: [MAIN_ENTRY],
      env: { ...process.env, MEETINGSPACE_USER_DATA: userDataDir, MEETINGSPACE_FAKE_LLM: '1' },
    });
    window = await app.firstWindow();
    window.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    window.on('pageerror', (e) => consoleErrors.push(e.message));
    await window.waitForLoadState('domcontentloaded');
  });

  test.afterAll(async () => {
    await app.close();
    cleanupUserData(userDataDir);
  });

  test('first reopen after chatting shows the persisted artifact with a non-zero frame', async () => {
    await window.getByRole('button', { name: 'New session' }).click();
    await expect(window.getByRole('heading', { name: 'Untitled session' })).toBeVisible();

    await window.getByRole('button', { name: 'Add note or transcript', exact: true }).click();
    await window
      .getByRole('textbox', { name: 'Note 1', exact: true })
      .fill('We decided to ship MeetingSpace v1 on Friday. Owner: Kurt.');
    await window.waitForTimeout(900); // debounced autosave

    // 1) Generate a white paper so an artifact is PERSISTED, then close the modal.
    await window.getByRole('button', { name: 'White paper' }).click();
    await window.getByRole('dialog', { name: 'White paper' }).waitFor();
    await window.getByRole('button', { name: 'Generate white paper' }).click();
    const firstFrame = window.locator('iframe[data-testid="generated-doc-frame"]');
    await expect(firstFrame).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(async () => (await firstFrame.getAttribute('srcdoc')) ?? '', { timeout: 10_000 })
      .toContain('Chunked Section');
    await window.getByRole('button', { name: 'Close white paper' }).click();
    await expect(window.getByRole('dialog', { name: 'White paper' })).toBeHidden();

    // 2) Chat a turn — the bug's precondition.
    await window.getByRole('textbox', { name: 'Ask Claude about this session' }).fill('Summary?');
    await window.getByRole('button', { name: 'Send message' }).click();
    await expect(window.getByText('Based on your notes, here is what I found.')).toBeVisible({
      timeout: 10_000,
    });

    // 3) FIRST reopen after the chat — the persisted artifact must render immediately.
    await window.getByRole('button', { name: 'White paper' }).click();
    await window.getByRole('dialog', { name: 'White paper' }).waitFor();
    const frame = window.locator('iframe[data-testid="generated-doc-frame"]');
    await expect(frame).toBeVisible({ timeout: 10_000 });

    // The artifact content is present in the frame on FIRST open (no second close/open).
    await expect
      .poll(async () => (await frame.getAttribute('srcdoc')) ?? '', { timeout: 10_000 })
      .toContain('Chunked Section');

    // …and the frame has a real, non-zero box (the "white box" symptom is a collapsed/zero frame).
    const box = await frame.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(100);
    expect(box!.height).toBeGreaterThan(100);

    expect(consoleErrors).toEqual([]);
  });
});
