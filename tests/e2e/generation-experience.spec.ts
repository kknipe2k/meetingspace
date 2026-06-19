import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { cleanupUserData } from './helpers/cleanup';

const MAIN_ENTRY = resolve(__dirname, '../../out/main/main.js');

/*
 * M04.C acceptance (generation experience): a generation model picker (default
 * Sonnet 4.6), a "which model ran" badge, and the white-paper / minutes / raw mode
 * switch. Runs against the MOCKED SDK seam (MEETINGSPACE_FAKE_LLM=1) — no live key,
 * no network. The fake generation client echoes the requested model, so the badge
 * proves the picked model actually flowed through. Raw mode is asserted to render
 * the saved notes WITHOUT any model output (it makes no SDK call), and the B
 * security control is re-confirmed unchanged (no <script> survives, sandbox intact).
 *
 * One self-contained flow (the modes live in the same open modal): pick a model ->
 * generate -> badge, then switch to Raw -> render. Two-phase progress and prompt
 * forking are pinned in the component/unit tests (GeneratedDocView / progress /
 * PromptTemplateEditor) — transient/heavy to assert in a single live window.
 */
test.describe('generation experience — model picker + badge + modes', () => {
  let app: ElectronApplication;
  let window: Page;
  let userDataDir: string;
  const consoleErrors: string[] = [];

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'meetingspace-genx-'));
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

  test('pick a model -> badge shows it; raw mode renders; B security path unchanged', async () => {
    await window.getByRole('button', { name: 'New session' }).click();
    await expect(window.getByRole('heading', { name: 'Untitled session' })).toBeVisible();

    await window.getByRole('button', { name: 'Add note or transcript', exact: true }).click();
    await window
      .getByRole('textbox', { name: 'Note 1', exact: true })
      .fill('Decision: ship v1 Friday. <script>window.parent.postMessage("NOTE_XSS","*")</script>');
    await window.waitForTimeout(900); // debounced autosave

    await window.getByRole('button', { name: 'White paper' }).click();
    await window.getByRole('dialog', { name: 'White paper' }).waitFor();

    // M07.B (IRL reversal): opening the modal NEVER starts a run — the empty state shows and
    // generation is MANUAL. Pick a non-default model, then click Generate; the fake echoes
    // the model so the badge proves the picked model flowed through.
    await expect(window.getByText(/no document yet/i)).toBeVisible();
    await window
      .getByRole('combobox', { name: /generation model/i })
      .selectOption('claude-opus-4-8');
    await window.getByRole('button', { name: 'Generate white paper' }).click();

    const frame = window.locator('iframe[data-testid="generated-doc-frame"]');
    await expect(frame).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(async () => (await frame.getAttribute('srcdoc')) ?? '', { timeout: 10_000 })
      .toContain('Chunked Section'); // M07.C: the assembled chunked doc
    await expect(window.getByTestId('model-badge')).toHaveText('Claude Opus 4.8');

    // Self-hosted fonts are injected as base64 @font-face (ADR-0013) — no network,
    // works inside the opaque-origin sandbox; no external font origin is referenced.
    const fontDoc = (await frame.getAttribute('srcdoc')) ?? '';
    expect(fontDoc).toContain('@font-face');
    expect(fontDoc).toContain('Merriweather');
    expect(fontDoc).toMatch(/data:font\/woff2;base64,/);
    expect(fontDoc).not.toContain('googleapis');

    // B's two-layer control is unchanged: no script survives, sandbox grants no scripting.
    const srcdoc = (await frame.getAttribute('srcdoc')) ?? '';
    expect(srcdoc).not.toMatch(/<script/i);
    expect(srcdoc).not.toContain('NOTE_XSS');
    expect(await frame.getAttribute('sandbox')).not.toMatch(/allow-scripts/);

    // Minutes mode: re-prove the security teeth-check on the OTHER LLM path — the
    // planted <script> from the note must stay inert here too (B's sanitize+sandbox
    // is reused unchanged across modes).
    await window.getByRole('button', { name: 'Minutes', exact: true }).click();
    await window.getByRole('button', { name: 'Generate minutes', exact: true }).click();
    await expect
      .poll(async () => (await frame.getAttribute('srcdoc')) ?? '', { timeout: 10_000 })
      .toContain('Meeting Minutes');
    const minutesDoc = (await frame.getAttribute('srcdoc')) ?? '';
    expect(minutesDoc).not.toMatch(/<script/i);
    expect(minutesDoc).not.toContain('NOTE_XSS');
    expect(await frame.getAttribute('sandbox')).not.toMatch(/allow-scripts/);

    // Raw mode: build from the saved notes (no SDK call) — the note text renders, escaped.
    await window.getByRole('button', { name: 'Raw notes', exact: true }).click();
    await window.getByRole('button', { name: 'Show raw notes', exact: true }).click();
    await expect
      .poll(async () => (await frame.getAttribute('srcdoc')) ?? '', { timeout: 5_000 })
      .toContain('ship v1 Friday');
    expect((await frame.getAttribute('srcdoc')) ?? '').not.toMatch(/<script/i);

    expect(consoleErrors).toEqual([]);
  });
});

/*
 * M07.B (product-owner reversal at IRL) — the NEW contract, end to end on the mocked SDK
 * seam with a deliberate generation delay (MEETINGSPACE_FAKE_GEN_DELAY_MS) so the live
 * window is observable: generation is MANUAL (click Generate), a live run shows ONE
 * persistent app-level toast (kind + elapsed + Cancel) that SURVIVES closing the modal,
 * and once it persists, reopening shows the doc without an app restart (F12).
 */
test.describe('generation experience — manual generate + run toast survives close (F12)', () => {
  let app: ElectronApplication;
  let window: Page;
  let userDataDir: string;
  const consoleErrors: string[] = [];

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'meetingspace-genb-'));
    app = await electron.launch({
      args: [MAIN_ENTRY],
      env: {
        ...process.env,
        MEETINGSPACE_USER_DATA: userDataDir,
        MEETINGSPACE_FAKE_LLM: '1',
        // Hold each fake SDK stream open ~1.2s so the live-run toast is observable across a
        // modal close (the synchronous fake would otherwise settle before we could look).
        // M07.C round 4: the whitepaper run is FOUR calls (focus/plan/css/html), so the
        // per-call delay multiplies — 1.2s × 4 ≈ 4.8s total stays inside the 10s
        // toast-cleared timeout below while keeping a comfortable live window.
        MEETINGSPACE_FAKE_GEN_DELAY_MS: '1200',
      },
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

  test('manual generate; the run toast survives modal close; reopen shows the doc', async () => {
    await window.getByRole('button', { name: 'New session' }).click();
    await expect(window.getByRole('heading', { name: 'Untitled session' })).toBeVisible();

    await window.getByRole('button', { name: 'Add note or transcript', exact: true }).click();
    await window
      .getByRole('textbox', { name: 'Note 1', exact: true })
      .fill('Decision: ship v1 Friday.');
    await window.waitForTimeout(900); // debounced autosave

    // Open the modal — NO run starts (empty state). Generate is manual.
    await window.getByRole('button', { name: 'White paper' }).click();
    await window.getByRole('dialog', { name: 'White paper' }).waitFor();
    await expect(window.getByText(/no document yet/i)).toBeVisible();
    await window.getByRole('button', { name: 'Generate white paper' }).click();

    // The app-level run toast appears (kind + Cancel) while the run is live.
    const runToast = window.getByTestId('toast-host').getByText(/white paper/i);
    await expect(runToast).toBeVisible({ timeout: 5_000 });
    await expect(
      window.getByTestId('toast-host').getByRole('button', { name: /cancel/i }),
    ).toBeVisible();

    // IRL regression guard: toBeVisible only checks DOM presence, NOT visual occlusion. The
    // toast must FLOAT (fixed + top-most z-index) over the full-height app shell — without
    // that CSS the portal sat in body flow behind the shell, present in the DOM but invisible
    // to the user (the seam jsdom + a plain toBeVisible both missed). Assert it computes fixed.
    const toastStyle = await window.getByTestId('toast-host').evaluate((el) => {
      const s = getComputedStyle(el);
      return { position: s.position, zIndex: s.zIndex };
    });
    expect(toastStyle.position).toBe('fixed');
    expect(Number(toastStyle.zIndex)).toBeGreaterThan(10); // above the modal scrim

    // Close the modal while the run is still live — the toast must PERSIST outside the modal.
    await window.getByRole('button', { name: 'Close white paper' }).click();
    await expect(window.getByRole('dialog', { name: 'White paper' })).toBeHidden();
    await expect(window.getByTestId('toast-host').getByText(/white paper/i)).toBeVisible();

    // Let it finish, then reopen — the persisted doc surfaces with no app restart (F12).
    await expect(window.getByTestId('toast-host').getByText(/white paper/i)).toBeHidden({
      timeout: 10_000,
    });
    await window.getByRole('button', { name: 'White paper' }).click();
    await window.getByRole('dialog', { name: 'White paper' }).waitFor();
    const reopened = window.locator('iframe[data-testid="generated-doc-frame"]');
    await expect(reopened).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(async () => (await reopened.getAttribute('srcdoc')) ?? '', { timeout: 10_000 })
      .toContain('Chunked Section'); // M07.C: the assembled chunked doc

    expect(consoleErrors).toEqual([]);
  });
});
