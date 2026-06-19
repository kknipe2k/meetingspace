// @vitest-environment jsdom
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { LlmApi, LlmStreamCallbacks } from '@shared/api';
import type { LlmChatRequest, LlmDone, LlmErrorPayload } from '@shared/types';

import { ChatPanel } from '../../src/components/ChatPanel';

/*
 * The chat panel (M03.C): a streamed conversation grounded in the current session.
 * Driven here with a fake LlmApi that captures the stream callbacks, so the test
 * can deterministically feed chunk/done/error events and assert the rendered state.
 * No key and no SDK exist renderer-side — the panel only talks to the typed llm API.
 */
const SEND = { name: 'Send message' } as const;
const INPUT = { name: 'Ask Claude about this session' } as const;

interface Harness {
  client: LlmApi;
  emitChunk(delta: string): void;
  emitDone(done?: Partial<LlmDone>): void;
  emitError(error?: Partial<LlmErrorPayload>): void;
  lastRequest(): LlmChatRequest | null;
  cancelled(): boolean;
  calls(): number;
}

function harness(): Harness {
  let callbacks: LlmStreamCallbacks | null = null;
  let request: LlmChatRequest | null = null;
  let cancelled = false;
  let calls = 0;
  const client: LlmApi = {
    chat(req, cbs) {
      request = req;
      callbacks = cbs;
      cancelled = false;
      calls += 1;
      return () => {
        cancelled = true;
      };
    },
    // M06.D: history hydration — empty thread for these stream-behavior tests.
    history: async () => [],
  };
  return {
    client,
    emitChunk: (delta) => act(() => callbacks?.onChunk(delta)),
    emitDone: (done) =>
      act(() =>
        callbacks?.onDone({
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
          ...done,
        }),
      ),
    emitError: (error) =>
      act(() =>
        callbacks?.onError({
          code: 'AUTH',
          message: 'Authentication failed — check your Anthropic API key in Settings.',
          ...error,
        }),
      ),
    lastRequest: () => request,
    cancelled: () => cancelled,
    calls: () => calls,
  };
}

// A fake note client capturing the save-to-notes call (M03.D); never the real IPC.
function noteHarness() {
  const addWithContent = vi.fn(async (sessionId: string, content: string) => ({
    id: 'n1',
    sessionId,
    content,
    createdAt: 1,
    updatedAt: 1,
  }));
  return { client: { addWithContent }, addWithContent };
}

async function ask(question: string): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByRole('textbox', INPUT), question);
  await user.click(screen.getByRole('button', SEND));
}

describe('ChatPanel', () => {
  it('disables send until a non-blank question is typed', async () => {
    render(<ChatPanel sessionId="s1" client={harness().client} />);

    expect(screen.getByRole('button', SEND)).toBeDisabled();

    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', INPUT), '   ');
    expect(screen.getByRole('button', SEND)).toBeDisabled();

    await user.type(screen.getByRole('textbox', INPUT), 'real question');
    expect(screen.getByRole('button', SEND)).toBeEnabled();
  });

  it('sends {sessionId, question} and streams chunks into one assistant message', async () => {
    const h = harness();
    render(<ChatPanel sessionId="s1" client={h.client} />);

    await ask('What did we decide?');

    expect(screen.getByText('What did we decide?')).toBeInTheDocument();
    expect(h.lastRequest()).toMatchObject({ sessionId: 's1', question: 'What did we decide?' });

    // Streaming: send is locked while a stream is in flight.
    expect(screen.getByRole('button', SEND)).toBeDisabled();

    h.emitChunk('We ship ');
    h.emitChunk('on Friday.');

    // Two deltas accumulate into a single assistant bubble.
    expect(screen.getByText('We ship on Friday.')).toBeInTheDocument();

    h.emitDone();

    // Done re-opens the composer for the next turn.
    expect(screen.getByRole('textbox', INPUT)).toBeEnabled();
  });

  it('scrolls the just-asked question to the top on send (post-IRL #2)', async () => {
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    const h = harness();
    render(<ChatPanel sessionId="s1" client={h.client} />);

    await ask('What did we decide?');

    // The send parks the new user message at the top of the view (mutation: drop the on-send
    // effect → no block:'start' call → this fails). The sticky no-yank / follow-when-near-bottom
    // behavior is geometry-dependent and is validated in the Playwright-on-Electron e2e, NOT here
    // (jsdom can't lay out / scroll).
    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'start' }));
    scrollIntoView.mockRestore();
  });

  it('follows the streaming reply to the bottom while at/near the bottom (F8)', async () => {
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    const h = harness();
    render(<ChatPanel sessionId="s1" client={h.client} />);

    await ask('What did we decide?');
    scrollIntoView.mockClear(); // drop the on-send block:'start' call
    h.emitChunk('We ship on Friday.');

    // jsdom reports zero geometry → near-bottom → the reply follows to the end. (The not-near-bottom
    // case is geometry-dependent → e2e.)
    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'end' }));
    scrollIntoView.mockRestore();
  });

  it('sends on Enter and ignores Enter while the draft is blank', async () => {
    const h = harness();
    render(<ChatPanel sessionId="s1" client={h.client} />);
    const user = userEvent.setup();
    const input = screen.getByRole('textbox', INPUT);

    // Enter on a blank draft is a no-op (no request started).
    input.focus();
    await user.keyboard('{Enter}');
    expect(h.lastRequest()).toBeNull();

    // Enter on a real question sends it (Shift+Enter would insert a newline instead).
    await user.type(input, 'ship date?');
    await user.keyboard('{Enter}');
    expect(h.lastRequest()).toMatchObject({ sessionId: 's1', question: 'ship date?' });
  });

  it('renders a non-crashing error state when the stream errors', async () => {
    const h = harness();
    render(<ChatPanel sessionId="s1" client={h.client} />);

    await ask('hi');
    h.emitError({
      code: 'OFFLINE',
      message: 'Could not reach the Anthropic API — check your network connection.',
    });

    expect(screen.getByRole('alert')).toHaveTextContent(/could not reach the anthropic api/i);
    // Recoverable: the composer is usable again (not stuck mid-stream).
    expect(screen.getByRole('textbox', INPUT)).toBeEnabled();
  });

  it('cancels the in-flight stream on unmount (teardown of renderer listeners)', async () => {
    const h = harness();
    const { unmount } = render(<ChatPanel sessionId="s1" client={h.client} />);

    await ask('still thinking?');
    expect(h.cancelled()).toBe(false);

    unmount();
    expect(h.cancelled()).toBe(true);
  });

  it('offers Open Settings on an AUTH error and fires onOpenSettings', async () => {
    const h = harness();
    const onOpenSettings = vi.fn();
    render(<ChatPanel sessionId="s1" client={h.client} onOpenSettings={onOpenSettings} />);

    await ask('hi');
    h.emitError({
      code: 'AUTH',
      message: 'Authentication failed — check your Anthropic API key in Settings.',
    });

    await userEvent.setup().click(screen.getByRole('button', { name: /open settings/i }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('offers Retry on a RATE_LIMIT error and re-sends the same question', async () => {
    const h = harness();
    render(<ChatPanel sessionId="s1" client={h.client} />);

    await ask('ship date?');
    expect(h.calls()).toBe(1);
    h.emitError({
      code: 'RATE_LIMIT',
      message: 'Rate limited by the Anthropic API — please retry shortly.',
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('button', { name: /retry/i }));

    // A fresh stream started for the same question; the error banner cleared.
    expect(h.calls()).toBe(2);
    expect(h.lastRequest()).toMatchObject({ sessionId: 's1', question: 'ship date?' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', SEND)).toBeDisabled();
  });

  it('shows which model answered on a finalized reply', async () => {
    const h = harness();
    render(<ChatPanel sessionId="s1" client={h.client} noteClient={noteHarness().client} />);

    await ask('What did we decide?');
    h.emitChunk('We ship Friday.');
    h.emitDone({ model: 'claude-sonnet-4-6' });

    // The responding model (from the API response) is shown on the reply itself —
    // scoped to the conversation log so it can't match the model-picker option.
    const log = screen.getByRole('log', { name: /conversation/i });
    expect(within(log).getByText(/sonnet/i)).toBeInTheDocument();
  });

  it('saves a finalized reply as a Q+A note (with the model) and refreshes the canvas', async () => {
    const h = harness();
    const notes = noteHarness();
    const onNotesChanged = vi.fn();
    render(
      <ChatPanel
        sessionId="s1"
        client={h.client}
        noteClient={notes.client}
        onNotesChanged={onNotesChanged}
      />,
    );

    await ask('What did we decide?');
    h.emitChunk('We ship ');
    h.emitChunk('on Friday.');
    h.emitDone({ model: 'claude-haiku-4-5' });

    await userEvent.setup().click(screen.getByRole('button', { name: /save to notes/i }));

    expect(notes.addWithContent).toHaveBeenCalledTimes(1);
    const [sessionId, content] = notes.addWithContent.mock.calls[0] ?? [];
    expect(sessionId).toBe('s1');
    // The saved note carries the whole exchange — question, answer, AND the model.
    expect(content).toContain('What did we decide?');
    expect(content).toContain('We ship on Friday.');
    expect(content).toContain('Haiku');

    // The canvas is told to refresh so the saved note appears without a session switch.
    expect(onNotesChanged).toHaveBeenCalledTimes(1);

    // The control reflects the saved state (no duplicate save).
    expect(await screen.findByRole('button', { name: /saved/i })).toBeInTheDocument();
  });

  it('does not offer Save to notes while a reply is still streaming', async () => {
    const h = harness();
    render(<ChatPanel sessionId="s1" client={h.client} noteClient={noteHarness().client} />);

    await ask('What did we decide?');
    h.emitChunk('Thinking…');
    // Still in flight — no save affordance yet.
    expect(screen.queryByRole('button', { name: /save to notes/i })).not.toBeInTheDocument();
  });
});
