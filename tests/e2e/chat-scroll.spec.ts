import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

const MAIN_ENTRY = resolve(__dirname, '../../out/main/main.js');

/*
 * M06.D post-IRL #2 regression: a sent chat message was not visible until the reply returned —
 * the new question stayed below the fold of a scrolled conversation. jsdom can't lay out or
 * scroll, so this is validated in real Electron: with a conversation tall enough to overflow,
 * sending a message must bring that message into view immediately (it scrolls to the top of the
 * conversation), not leave it below the fold. Runs on the mocked SDK seam (no live key/network).
 */
test.describe('chat scroll on send (post-IRL #2)', () => {
  let app: ElectronApplication;
  let window: Page;
  let userDataDir: string;
  const consoleErrors: string[] = [];

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'meetingspace-chatscroll-'));
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
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  async function ask(text: string): Promise<void> {
    const composer = window.getByRole('textbox', { name: 'Ask Claude about this session' });
    await composer.fill(text);
    await window.getByRole('button', { name: 'Send message' }).click();
    // The composer disables while streaming; wait for it to re-enable (reply settled) before next.
    await expect(composer).toBeEnabled({ timeout: 10_000 });
  }

  test('a sent message is brought into view on send (not left below the fold)', async () => {
    await window.getByRole('button', { name: 'New session' }).click();
    await expect(window.getByRole('heading', { name: 'Untitled session' })).toBeVisible();

    await window.getByRole('button', { name: 'Add note or transcript', exact: true }).click();
    await window
      .getByRole('textbox', { name: 'Note 1', exact: true })
      .fill('We decided to ship MeetingSpace v1 on Friday. Owner: Kurt.');
    await window.waitForTimeout(900); // debounced autosave

    // Build a conversation tall enough to overflow the messages container.
    for (let i = 0; i < 7; i += 1) {
      await ask(`Priming question number ${i} about the decision and owner and timeline.`);
    }

    const log = window.getByRole('log', { name: 'Conversation' });
    const overflows = await log.evaluate((el) => el.scrollHeight > el.clientHeight + 40);
    expect(overflows).toBe(true); // the test is only meaningful when the log scrolls

    // Send the distinctive final question.
    const MARKER = 'FINAL QUESTION MARKER seventeen';
    await window.getByRole('textbox', { name: 'Ask Claude about this session' }).fill(MARKER);
    await window.getByRole('button', { name: 'Send message' }).click();

    // It must become visible on send — the regression left it below the fold (off-screen) until
    // the reply returned. (With a short reply the view follows to the bottom; a long reply would
    // park at the question — that branch needs a long reply the mocked client doesn't produce, so
    // it's IRL-verified. Here we pin the reported bug: the sent message is brought into view.)
    const sent = window.locator('.chat-message-user', { hasText: MARKER });
    await expect(sent).toBeInViewport({ timeout: 5_000 });

    // And streaming auto-follow actually scrolled (the self-defeating live read froze scrollTop near
    // the top — pin that the view is now near the bottom of the conversation).
    const followedToBottom = await log.evaluate(
      (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 80,
    );
    expect(followedToBottom).toBe(true);

    expect(consoleErrors).toEqual([]);
  });
});
