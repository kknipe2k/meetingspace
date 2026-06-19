import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

const MAIN_ENTRY = resolve(__dirname, '../../out/main/main.js');

/*
 * M04.B acceptance: Part 2 expands the FOCUS artifact into a self-contained HTML
 * white paper, which the app renders through a SANDBOXED iframe after sanitization.
 * Runs against the MOCKED SDK seam (MEETINGSPACE_FAKE_LLM=1 — a canned generation
 * client + a fake key reader), so there is NO live key and NO network.
 *
 * Two proofs of the two-layer security control:
 *  1. Integrated — a <script> planted in a note flows through generation into the
 *     HTML; it is sanitized out and never executes (the full pipeline is safe).
 *  2. Sandbox behavioral proof — a test-only probe renders RAW, UNSANITIZED
 *     script-bearing HTML through the SAME iframe primitive; the sandbox alone
 *     blocks execution. Wiring mutation-2 (drop the sandbox / add allow-scripts)
 *     makes that script execute and fails this test — so the sandbox is proven
 *     load-bearing on its own, not merely configured.
 *
 * Execution is detected via window.parent.postMessage: a blocked script can't fire
 * it; an executed one can (postMessage crosses the opaque sandbox origin). The
 * collector is installed via addInitScript + reload so it predates any iframe.
 */
const COLLECTOR = (): void => {
  (window as unknown as { __xssMessages: string[] }).__xssMessages = [];
  window.addEventListener('message', (event: MessageEvent) => {
    if (typeof event.data === 'string') {
      (window as unknown as { __xssMessages: string[] }).__xssMessages.push(event.data);
    }
  });
};

async function xssMessages(window: Page): Promise<string[]> {
  return window.evaluate(
    () => (window as unknown as { __xssMessages?: string[] }).__xssMessages ?? [],
  );
}

test.describe('white paper generation — integrated pipeline', () => {
  let app: ElectronApplication;
  let window: Page;
  let userDataDir: string;
  const consoleErrors: string[] = [];

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'meetingspace-wp-'));
    app = await electron.launch({
      args: [MAIN_ENTRY],
      env: { ...process.env, MEETINGSPACE_USER_DATA: userDataDir, MEETINGSPACE_FAKE_LLM: '1' },
    });
    window = await app.firstWindow();
    window.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    window.on('pageerror', (e) => consoleErrors.push(e.message));
    await window.addInitScript(COLLECTOR);
    await window.reload();
    await window.waitForLoadState('domcontentloaded');
  });

  test.afterAll(async () => {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  test('a planted <script> is sanitized out and never executes; renders sandboxed', async () => {
    await window.getByRole('button', { name: 'New session' }).click();
    await expect(window.getByRole('heading', { name: 'Untitled session' })).toBeVisible();

    await window.getByRole('button', { name: 'Add note or transcript', exact: true }).click();
    const noteField = window.getByRole('textbox', { name: 'Note 1', exact: true });
    await noteField.fill(
      'Decision: ship v1 Friday. <script>window.parent.postMessage("NOTE_XSS","*")</script>',
    );
    await window.waitForTimeout(900); // let the 500ms debounced autosave persist

    // Open the white-paper surface, then trigger generation inside it.
    await window.getByRole('button', { name: 'White paper' }).click();
    await window.getByRole('dialog', { name: 'White paper' }).waitFor();
    await window.getByRole('button', { name: 'Generate white paper' }).click();

    const frame = window.locator('iframe[data-testid="generated-doc-frame"]');
    await expect(frame).toBeVisible();
    // M07.C: the chunked pipeline assembles the doc main-side (outline → sections →
    // css → code-owned shell); wait for the fake's section fragment to land in srcdoc.
    await expect
      .poll(async () => (await frame.getAttribute('srcdoc')) ?? '', { timeout: 10_000 })
      .toContain('Chunked Section');

    const srcdoc = (await frame.getAttribute('srcdoc')) ?? '';
    expect(srcdoc).not.toMatch(/<script/i); // injected + model-emitted scripts stripped
    expect(srcdoc).not.toContain('NOTE_XSS');
    expect(srcdoc).not.toContain('onerror');

    // M07.C IRL fix — the theme MUST be EFFECTIVE, not merely present (B's occlusion
    // lesson: DOM/string presence ≠ user-visible). The fake's css part is deliberately
    // FENCED (the real-run model behavior that shipped an unstyled doc): the pipeline
    // must unwrap it, and the rendered frame must COMPUTE the themed rule — including
    // the var(--accent) resolution that died when the fence ate the :root block.
    expect(srcdoc).not.toContain('```');
    const callout = frame.contentFrame().locator('.callout').first();
    await expect(callout).toBeVisible();
    const computed = await callout.evaluate((el) => {
      const style = getComputedStyle(el);
      return { borderLeftWidth: style.borderLeftWidth, borderLeftColor: style.borderLeftColor };
    });
    expect(computed.borderLeftWidth).toBe('4px');
    expect(computed.borderLeftColor).toBe('rgb(94, 106, 210)'); // var(--accent) = #5e6ad2 resolved

    // The iframe's sandbox grants no scripting.
    const sandbox = await frame.getAttribute('sandbox');
    expect(sandbox).not.toMatch(/allow-scripts/);

    await window.waitForTimeout(300);
    expect(await xssMessages(window)).not.toContain('NOTE_XSS');
    expect(await xssMessages(window)).not.toContain('GEN_XSS');
    expect(consoleErrors).toEqual([]);
  });

  test('renderer stays sandboxed: gen bridge exposed, no Node require', async () => {
    const exposure = await window.evaluate(() => {
      const surface = window as unknown as { api?: { gen?: unknown }; require?: unknown };
      return {
        hasGen: typeof surface.api?.gen !== 'undefined',
        hasRequire: typeof surface.require !== 'undefined',
      };
    });
    expect(exposure.hasGen).toBe(true);
    expect(exposure.hasRequire).toBe(false);
  });
});

test.describe('sandbox behavioral proof — raw unsanitized HTML', () => {
  let app: ElectronApplication;
  let window: Page;
  let userDataDir: string;

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'meetingspace-probe-'));
    app = await electron.launch({
      args: [MAIN_ENTRY],
      env: {
        ...process.env,
        MEETINGSPACE_USER_DATA: userDataDir,
        MEETINGSPACE_FAKE_LLM: '1',
        MEETINGSPACE_SANDBOX_PROBE: '1',
      },
    });
    window = await app.firstWindow();
    await window.addInitScript(COLLECTOR);
    await window.reload();
    await window.waitForLoadState('domcontentloaded');
  });

  test.afterAll(async () => {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  test('a script in RAW HTML rendered through the sandboxed frame does not execute', async () => {
    // The probe renders raw, UNSANITIZED malicious HTML (a <script> and an
    // onerror handler, both attempting window.parent.postMessage) through the same
    // SandboxedHtmlFrame the white paper uses — proving the sandbox blocks scripts
    // even with the sanitizer entirely out of the picture.
    const probe = window.locator('iframe[data-testid="sandbox-probe-frame"]');
    await expect(probe).toBeVisible();

    // BEHAVIORAL proof (not a config assertion — that lives in the unit test): give
    // any script in the raw fixture ample time to run and postMessage had the
    // sandbox failed to block it. The sandbox holds → no message arrives. Adding
    // allow-scripts to SandboxedHtmlFrame makes the script execute → the message
    // arrives → this assertion fails (mutation-2, behaviorally).
    await window.waitForTimeout(800);
    expect(await xssMessages(window)).not.toContain('SANDBOX_XSS_EXECUTED');
  });
});
