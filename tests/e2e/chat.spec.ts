import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { cleanupUserData } from './helpers/cleanup';

const MAIN_ENTRY = resolve(__dirname, '../../out/main/main.js');

/*
 * M03.C acceptance: the LLM panel is a real chat, grounded main-side in the current
 * session's notes, streaming the answer back. This e2e runs against a MOCKED SDK seam
 * (MEETINGSPACE_FAKE_LLM=1 — main.ts swaps in a canned-stream client and a fake key
 * reader) so there is NO live key and NO network in CI. It still drives the REAL
 * grounding + IPC path end to end, and re-checks the renderer stays sandboxed
 * (window.api.llm present, no Node require).
 *
 * The fake client streams this exact text (electron/llm/fake-streaming-client.ts).
 */
const FAKE_ANSWER = 'Based on your notes, here is what I found.';

let app: ElectronApplication;
let window: Page;
let userDataDir: string;
const consoleErrors: string[] = [];

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'meetingspace-chat-'));
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
  cleanupUserData(userDataDir);
});

test('chat streams a grounded answer into the panel (mocked SDK, no live network)', async () => {
  // A session with at least one content-bearing note, so grounding is non-empty.
  await window.getByRole('button', { name: 'New session' }).click();
  await expect(window.getByRole('heading', { name: 'Untitled session' })).toBeVisible();

  // Exact names: 'Add note or transcript' also matches the file input's aria-label,
  // and a regex 'Note 1' could match sibling controls (gotcha §7).
  await window.getByRole('button', { name: 'Add note or transcript', exact: true }).click();
  const noteField = window.getByRole('textbox', { name: 'Note 1', exact: true });
  await noteField.fill('We decided to ship MeetingSpace v1 on Friday. Owner: Kurt.');
  // Let the debounced autosave (500ms) persist the note before we ask.
  await window.waitForTimeout(900);

  // Ask a question; the answer streams into an assistant bubble.
  const composer = window.getByRole('textbox', { name: 'Ask Claude about this session' });
  await composer.fill('What did we decide?');
  await window.getByRole('button', { name: 'Send message' }).click();

  await expect(window.getByText('What did we decide?')).toBeVisible();
  await expect(window.getByText(FAKE_ANSWER)).toBeVisible();

  // M03.D: the reply shows which model answered (scoped to the conversation log so it
  // doesn't match the model-picker option of the same name). The fake client echoes
  // the selected model — default Haiku 4.5.
  const conversation = window.getByRole('log', { name: 'Conversation' });
  await expect(conversation.getByText('Claude Haiku 4.5')).toBeVisible();

  // M03.D: save the reply as a note — it appears in the canvas immediately (no
  // session switch), carrying the whole Q+A exchange and the responding model.
  await window.getByRole('button', { name: 'Save to notes' }).click();
  await expect(window.getByRole('button', { name: 'Saved ✓' })).toBeVisible();
  await expect(window.getByRole('textbox', { name: 'Note 2', exact: true })).toHaveValue(
    /\*\*Q:\*\* What did we decide\?[\s\S]*Based on your notes[\s\S]*Answered by Claude Haiku 4\.5/,
  );

  expect(consoleErrors).toEqual([]);
});

test('renderer stays sandboxed during chat: llm bridge exposed, no Node require', async () => {
  const exposure = await window.evaluate(() => {
    const surface = window as unknown as { api?: { llm?: unknown }; require?: unknown };
    return {
      hasLlm: typeof surface.api?.llm !== 'undefined',
      hasRequire: typeof surface.require !== 'undefined',
    };
  });

  expect(exposure.hasLlm).toBe(true);
  expect(exposure.hasRequire).toBe(false);
});
