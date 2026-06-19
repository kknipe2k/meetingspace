import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { cleanupUserData } from './helpers/cleanup';

const MAIN_ENTRY = resolve(__dirname, '../../out/main/main.js');

/*
 * M07.C fix #4 — the FAILURE SURFACES, pinned end to end (the owner's regen died with
 * a blind UNKNOWN; the surface that fired was the MODAL's role="alert" block — the
 * app toast only covered the TIMEOUT_ tiers). Both real paths now carry the
 * step-tagged copy:
 *   (a) modal OPEN at failure  → the modal's persistent alert block;
 *   (b) modal CLOSED at failure → the app-level error toast (a run never dies blind).
 * Runs against the mocked-SDK seam with MEETINGSPACE_FAKE_GEN_FAIL=css: the fake's
 * CSS route returns rule-less prose, so the pipeline fails typed with
 * "Styling the document failed — stylesheet validation." — static copy, no content.
 */
const FAILURE_COPY = /Styling the document failed — stylesheet validation/;

test.describe('generation failure surfaces — step-tagged copy on both paths', () => {
  let app: ElectronApplication;
  let window: Page;
  let userDataDir: string;

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'meetingspace-genfail-'));
    app = await electron.launch({
      args: [MAIN_ENTRY],
      env: {
        ...process.env,
        MEETINGSPACE_USER_DATA: userDataDir,
        MEETINGSPACE_FAKE_LLM: '1',
        MEETINGSPACE_FAKE_GEN_FAIL: 'css',
        // Hold each fake stream open so the modal-close window in (b) is real. The
        // failing run is 4 calls (focus/plan/css×2) ≈ 3.2s total.
        MEETINGSPACE_FAKE_GEN_DELAY_MS: '800',
      },
    });
    window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    await window.getByRole('button', { name: 'New session' }).click();
    await expect(window.getByRole('heading', { name: 'Untitled session' })).toBeVisible();
    await window.getByRole('button', { name: 'Add note or transcript', exact: true }).click();
    await window
      .getByRole('textbox', { name: 'Note 1', exact: true })
      .fill('Decision: ship v1 Friday.');
    await window.waitForTimeout(900); // debounced autosave
  });

  test.afterAll(async () => {
    await app.close();
    cleanupUserData(userDataDir);
  });

  test('(a) modal OPEN: the failure lands in the modal’s alert block with the step-tagged copy', async () => {
    await window.getByRole('button', { name: 'White paper' }).click();
    const dialog = window.getByRole('dialog', { name: 'White paper' });
    await dialog.waitFor();
    await window.getByRole('button', { name: 'Generate white paper' }).click();

    // The surface the owner actually saw on the regen death — now with the step copy.
    const alert = dialog.getByRole('alert');
    await expect(alert).toBeVisible({ timeout: 15_000 });
    await expect(alert).toContainText(FAILURE_COPY);

    await window.getByRole('button', { name: 'Close white paper' }).click();
    await expect(dialog).toBeHidden();
  });

  test('(b) modal CLOSED: the failure lands as an app-level error toast — a run never dies blind', async () => {
    await window.getByRole('button', { name: 'White paper' }).click();
    const dialog = window.getByRole('dialog', { name: 'White paper' });
    await dialog.waitFor();
    await window.getByRole('button', { name: 'Generate white paper' }).click();

    // Close while the run is live — the failure must surface OUTSIDE the modal.
    await window.getByRole('button', { name: 'Close white paper' }).click();
    await expect(dialog).toBeHidden();

    const toastAlert = window.getByTestId('toast-host').getByRole('alert');
    await expect(toastAlert).toBeVisible({ timeout: 15_000 });
    await expect(toastAlert).toContainText(FAILURE_COPY);
  });
});
