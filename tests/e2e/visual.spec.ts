import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

const MAIN_ENTRY = resolve(__dirname, '../../out/main/main.js');

// A stable fixture image (120×80) so the open-modal baselines are identical pixels on
// every machine (TD-008). Same determinism recipe as the canvas baseline above.
const FIXTURE_PNG = Buffer.from(
  readFileSync(resolve(__dirname, 'fixtures/screenshot-120x80.b64'), 'utf8').trim(),
  'base64',
);

// Visual-regression gate (docs/gates.md M02): a screenshot baseline of the
// capture canvas with note blocks. Cross-machine pixel baselines are fragile —
// window size and DPI differ between the dev box and the CI runner — so we make
// the capture deterministic: force device-scale-factor=1 and pin the window's
// content size via the main process, so the canvas renders at identical pixels
// everywhere. The human approved the visual baseline at the M02.A IRL review.
const CONTENT_WIDTH = 1000;
const CONTENT_HEIGHT = 720;

let userDataDir: string;

function launch(): Promise<ElectronApplication> {
  return electron.launch({
    // --force-device-scale-factor=1 removes the DPI variable from the capture.
    args: [MAIN_ENTRY, '--force-device-scale-factor=1'],
    env: { ...process.env, MEETINGSPACE_USER_DATA: userDataDir },
  });
}

test.beforeAll(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'meetingspace-visual-'));
});

test.afterAll(() => {
  // Windows can briefly hold the SQLite file after the app closes — retry the
  // cleanup rather than failing the run on an EBUSY unlink race.
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('capture canvas with note blocks matches the approved visual baseline', async () => {
  const app: ElectronApplication = await launch();
  const win: Page = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  // Pin the web-content size deterministically (independent of the runner's
  // screen size and window frame), so the captured element is identical pixels.
  await app.evaluate(
    ({ BrowserWindow }, { w, h }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window?.setContentSize(w, h);
    },
    { w: CONTENT_WIDTH, h: CONTENT_HEIGHT },
  );
  await win.waitForTimeout(200); // let the flex layout settle at the new size

  await win.getByRole('button', { name: 'New session' }).click();
  await expect(win.getByRole('heading', { name: 'Untitled session' })).toBeVisible();
  await win.getByRole('button', { name: 'Add note or transcript', exact: true }).click();
  await win.getByRole('textbox', { name: 'Note 1', exact: true }).fill('Design review notes');

  // Snapshot the canvas zone (deterministic size; avoids list timestamps elsewhere).
  await expect(win.getByTestId('zone-canvas')).toHaveScreenshot('capture-canvas.png');
  await app.close();
});

// M04.B visual baseline: the generated-document surface (the white-paper modal with
// the sandboxed render). Deterministic via the mocked-SDK seam (MEETINGSPACE_FAKE_LLM
// — canned generation client, no live key/network), so the captured white paper is
// identical pixels everywhere. The human approved this baseline at the M04.B IRL.
test('generated white-paper surface matches the approved visual baseline', async () => {
  const genUserDataDir = mkdtempSync(join(tmpdir(), 'meetingspace-visual-gen-'));
  const app: ElectronApplication = await electron.launch({
    args: [MAIN_ENTRY, '--force-device-scale-factor=1'],
    env: { ...process.env, MEETINGSPACE_USER_DATA: genUserDataDir, MEETINGSPACE_FAKE_LLM: '1' },
  });
  try {
    const win: Page = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await app.evaluate(
      ({ BrowserWindow }, { w, h }) => {
        const window = BrowserWindow.getAllWindows()[0];
        window?.setContentSize(w, h);
      },
      { w: CONTENT_WIDTH, h: CONTENT_HEIGHT },
    );
    await win.waitForTimeout(200);

    await win.getByRole('button', { name: 'New session' }).click();
    await expect(win.getByRole('heading', { name: 'Untitled session' })).toBeVisible();
    await win.getByRole('button', { name: 'Add note or transcript', exact: true }).click();
    await win
      .getByRole('textbox', { name: 'Note 1', exact: true })
      .fill('Design review: ship MeetingSpace v1 on Friday. Owner: Kurt.');
    await win.waitForTimeout(900); // debounced autosave

    await win.getByRole('button', { name: 'White paper' }).click();
    await win.getByRole('dialog', { name: 'White paper' }).waitFor();
    await win.getByRole('button', { name: 'Generate white paper' }).click();

    const frame = win.locator('iframe[data-testid="generated-doc-frame"]');
    await expect
      .poll(async () => (await frame.getAttribute('srcdoc')) ?? '', { timeout: 10_000 })
      .toContain('Chunked Section'); // M07.C: the assembled chunked doc
    await win.waitForTimeout(400); // let the sandboxed iframe paint

    await expect(win.locator('.generated-doc-modal')).toHaveScreenshot('generated-doc.png');
  } finally {
    await app.close();
    rmSync(genUserDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

// TD-008: deterministic open-modal pixel baselines (the regression guard M02 deferred).
// Both modals are behaviour-tested elsewhere (full-capture / capture specs); these add a
// visual-regression baseline of the OPEN modal, captured against a stable fixture image
// at a pinned content size so the pixels are identical on the dev box and CI.
test('open Lightbox matches the approved visual baseline (TD-008)', async () => {
  const lbDir = mkdtempSync(join(tmpdir(), 'meetingspace-visual-lightbox-'));
  const app: ElectronApplication = await electron.launch({
    args: [MAIN_ENTRY, '--force-device-scale-factor=1'],
    env: { ...process.env, MEETINGSPACE_USER_DATA: lbDir },
  });
  try {
    const win: Page = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await app.evaluate(
      ({ BrowserWindow }, { w, h }) => {
        BrowserWindow.getAllWindows()[0]?.setContentSize(w, h);
      },
      { w: CONTENT_WIDTH, h: CONTENT_HEIGHT },
    );
    await win.waitForTimeout(200);

    await win.getByRole('button', { name: 'New session' }).click();
    await expect(win.getByRole('heading', { name: 'Untitled session' })).toBeVisible();
    await win.getByLabel('Add screenshot file').setInputFiles({
      name: 'shot.png',
      mimeType: 'image/png',
      buffer: FIXTURE_PNG,
    });

    const thumb = win.getByRole('img', { name: /screenshot 1/i });
    await expect(thumb).toBeVisible();
    await thumb.click();

    const lightbox = win.getByRole('dialog');
    await expect(lightbox).toBeVisible();
    await win.waitForTimeout(300); // let the portal scrim + image paint
    await expect(win.getByTestId('lightbox-scrim')).toHaveScreenshot('lightbox-open.png');
  } finally {
    await app.close();
    rmSync(lbDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

// The CapturePicker grid shows live desktop sources, which are NOT pixel-stable across
// machines — so determinism comes from the MEETINGSPACE_FAKE_CAPTURE seam (mirrors the
// FAKE_LLM seam): canned sources + the fixture thumbnail, so the picker renders identical
// pixels everywhere. No live desktopCapturer enumeration in this baseline.
test('open CapturePicker grid matches the approved visual baseline (TD-008)', async () => {
  const cpDir = mkdtempSync(join(tmpdir(), 'meetingspace-visual-picker-'));
  const app: ElectronApplication = await electron.launch({
    args: [MAIN_ENTRY, '--force-device-scale-factor=1'],
    env: { ...process.env, MEETINGSPACE_USER_DATA: cpDir, MEETINGSPACE_FAKE_CAPTURE: '1' },
  });
  try {
    const win: Page = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await app.evaluate(
      ({ BrowserWindow }, { w, h }) => {
        BrowserWindow.getAllWindows()[0]?.setContentSize(w, h);
      },
      { w: CONTENT_WIDTH, h: CONTENT_HEIGHT },
    );
    await win.waitForTimeout(200);

    await win.getByRole('button', { name: 'New session' }).click();
    await expect(win.getByRole('heading', { name: 'Untitled session' })).toBeVisible();
    await win.getByRole('button', { name: 'Capture screen' }).click();

    const dialog = win.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // The fake seam always yields sources, so the grid is populated + deterministic.
    await expect(dialog.getByTestId('capture-source').first()).toBeVisible();
    await win.waitForTimeout(200);
    await expect(dialog).toHaveScreenshot('capture-picker-open.png');
  } finally {
    await app.close();
    rmSync(cpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
