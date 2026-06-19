import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { cleanupUserData } from './helpers/cleanup';

const MAIN_ENTRY = resolve(__dirname, '../../out/main/main.js');

// A real 1×1 PNG (base64) so the bytes that cross over real IPC decode to a valid
// image the <img> can render (naturalWidth > 0) on every screenshot path.
const PNG_1x1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// The M02.D milestone proof (scope.md AC4): a full session — note blocks captured
// two ways (typed + uploaded text file) and screenshots via all four paths
// (drag-drop, clipboard paste, file upload, in-app capture) — survives close →
// relaunch → intact, and a stored screenshot expands in the flicker-safe lightbox.
// Uploaded text becomes an ordinary note block, so it persists exactly like a typed
// note (the IRL persistence regression, driven through the real upload flow).
// Drag-drop and paste inject a real File built in page context and dispatch the
// genuine DOM events, so the bytes travel the real asset:save path (not a stub).
// Capture rides desktopCapturer; on a runner with no capturable desktop the capture
// sub-step skips with a printed reason (the service seam is unit-tested), never a
// silent pass.
let userDataDir: string;

const UPLOADED_NOTE = 'upload.md\n\nuploaded note body';

function launch(): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY],
    env: { ...process.env, MEETINGSPACE_USER_DATA: userDataDir },
  });
}

// Drives one screenshot byte-path (drag-drop or clipboard paste) by building a
// real File + DataTransfer in the page and dispatching the genuine DOM event at
// the drop zone, with the transfer pinned via defineProperty so React's onDrop /
// onPaste sees `dataTransfer` / `clipboardData` regardless of how the synthetic
// event is constructed. The bytes then travel the real asset:save IPC path.
function injectImage(
  win: Page,
  eventType: 'drop' | 'paste',
  property: 'dataTransfer' | 'clipboardData',
  filename: string,
): Promise<void> {
  return win.evaluate(
    ({ b64, name, type, prop }) => {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], name, { type: 'image/png' }));
      const zone = document.querySelector('[data-testid="screenshot-drop"]');
      if (!zone) {
        throw new Error('screenshot drop zone not found');
      }
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, prop, { value: transfer });
      zone.dispatchEvent(event);
    },
    { b64: PNG_1x1_B64, name: filename, type: eventType, prop: property },
  );
}

test.beforeAll(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'meetingspace-fullcapture-'));
});

test.afterAll(() => {
  cleanupUserData(userDataDir);
});

test('full session — typed + uploaded notes + 4 screenshot paths — survives close → relaunch', async () => {
  const first: ElectronApplication = await launch();
  const win: Page = await first.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  await win.getByRole('button', { name: 'New session' }).click();
  await expect(win.getByRole('heading', { name: 'Untitled session' })).toBeVisible();

  // --- Note blocks: one typed, one uploaded from a text file ---
  await win.getByRole('button', { name: 'Add note or transcript', exact: true }).click();
  await win.getByRole('textbox', { name: 'Note 1', exact: true }).fill('agenda');

  await win.getByLabel('Add note or transcript file').setInputFiles({
    name: 'upload.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('uploaded note body'),
  });
  // The uploaded text becomes a real note block, seeded with a filename header.
  await expect(win.getByRole('textbox', { name: 'Note 2', exact: true })).toHaveValue(
    UPLOADED_NOTE,
  );

  // --- Screenshot path 1: file upload ---
  await win.getByLabel('Add screenshot file').setInputFiles({
    name: 'upload.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_1x1_B64, 'base64'),
  });

  // --- Screenshot path 2: drag-drop (genuine DataTransfer + File over real IPC) ---
  await injectImage(win, 'drop', 'dataTransfer', 'drop.png');

  // --- Screenshot path 3: clipboard paste ---
  await injectImage(win, 'paste', 'clipboardData', 'paste.png');

  await expect(win.getByTestId('screenshot-thumb')).toHaveCount(3);

  // --- Screenshot path 4: in-app capture (skips cleanly if the runner has none) ---
  let expectedShots = 3;
  await win.getByRole('button', { name: 'Capture screen' }).click();
  const dialog = win.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const sources = dialog.getByTestId('capture-source');
  if ((await sources.count()) > 0) {
    await sources.first().click();
    expectedShots = 4;
    await expect(win.getByTestId('screenshot-thumb')).toHaveCount(expectedShots);
  } else {
    console.log('full-capture.spec: no capturable desktop on this runner — skipping capture path.');
    await win.getByRole('button', { name: 'Cancel' }).click();
  }

  // Let every autosave debounce + IPC write reach SQLite/disk before relaunch.
  await win.waitForTimeout(1_500);
  await first.close();

  // --- Relaunch → reopen → everything intact ---
  const second: ElectronApplication = await launch();
  const win2: Page = await second.firstWindow();
  await win2.waitForLoadState('domcontentloaded');
  await win2.getByRole('button', { name: 'Untitled session', exact: true }).click();

  await expect(win2.getByRole('textbox', { name: 'Note 1', exact: true })).toHaveValue('agenda');
  // The uploaded note survives close → reopen exactly like the typed one.
  await expect(win2.getByRole('textbox', { name: 'Note 2', exact: true })).toHaveValue(
    UPLOADED_NOTE,
  );

  const thumbs = win2.getByTestId('screenshot-thumb');
  await expect(thumbs).toHaveCount(expectedShots);
  const firstImg = win2.getByRole('img', { name: /screenshot 1/i });
  await expect(firstImg).toBeVisible();
  await expect
    .poll(() => firstImg.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);

  // --- Lightbox: expand a stored screenshot; verify no flicker + full-res ---
  await win2.getByRole('button', { name: 'Expand screenshot 1' }).click();
  const lightbox = win2.getByRole('dialog');
  await expect(lightbox).toBeVisible();
  const fullImg = lightbox.getByRole('img');
  await expect
    .poll(() => fullImg.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);

  // Flicker fix, half 2: the scrim intercepts pointer events — the full-viewport
  // overlay is the topmost element over the app content (canvas/thumbnails), so a
  // mousemove anywhere on screen never reaches the app behind it to repaint it.
  const overlayOnTop = await win2.evaluate(() => {
    const el = document.elementFromPoint(
      Math.floor(window.innerWidth / 2),
      Math.floor(window.innerHeight / 2),
    );
    return !!el?.closest('[data-testid="lightbox-scrim"]');
  });
  expect(overlayOnTop).toBe(true);

  await win2.keyboard.press('Escape');
  await expect(win2.getByRole('dialog')).toHaveCount(0);

  await second.close();
});
