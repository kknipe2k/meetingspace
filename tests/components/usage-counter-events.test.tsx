// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { LlmApi, UsageApi } from '@shared/api';
import type { GenRunEnded, UsageSummary } from '@shared/types';

import { ChatPanel } from '../../src/components/ChatPanel';

/*
 * M08.C — the counter lives in ChatPanel (via useUsageCounter), independent of the document modal.
 * A generation that finishes after the modal closes (or with the modal never opened) emits the
 * app-wide `gen:run-ended`; the counter must refresh off THAT event — not the old modal-mounted
 * onGenerationComplete chain. There is NO GeneratedDocView in this tree, so a refresh here proves
 * the decoupling. Driven with fakes — no key, no SDK.
 */
function llmClient(): LlmApi {
  return { chat: () => () => undefined, history: vi.fn(async () => []) };
}

function summaryWith(sessionIn: number, allIn: number): UsageSummary {
  const totals = (input: number) => ({
    inputTokens: input,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    unpricedCalls: 0,
  });
  return { sessionToday: totals(sessionIn), allToday: totals(allIn) };
}

type RunEndedListener = (e: GenRunEnded) => void;
function fakeGenEvents() {
  let listener: RunEndedListener | null = null;
  return {
    client: {
      onRunEnded: (l: RunEndedListener): (() => void) => {
        listener = l;
        return () => {
          listener = null;
        };
      },
    },
    emit: (e: GenRunEnded = { requestId: 'wp-1' }): void => act(() => listener?.(e)),
  };
}

describe('ChatPanel — usage counter refreshes on gen:run-ended (M08.C, modal-independent)', () => {
  it('refreshes both today rows when a run-ended event arrives (no GeneratedDocView mounted)', async () => {
    // Mount shows the pre-run totals; the post-run read returns the higher (generation-inclusive) ones.
    const summary = vi
      .fn<UsageApi['summary']>()
      .mockResolvedValueOnce(summaryWith(1200, 5600))
      .mockResolvedValue(summaryWith(9000, 42000));
    const usage: UsageApi = { summary, pricing: vi.fn(async () => []) };
    const gen = fakeGenEvents();

    render(
      <ChatPanel
        sessionId="s1"
        client={llmClient()}
        usageClient={usage}
        genEventsClient={gen.client}
      />,
    );

    const sessionRow = await screen.findByTestId('chat-usage-session-today');
    await waitFor(() => expect(sessionRow).toHaveTextContent('1.2k in'));

    // A background generation settled — the app-wide event drives the refresh.
    gen.emit({ requestId: 'wp-1' });

    await waitFor(() => expect(sessionRow).toHaveTextContent('9k in'));
    expect(screen.getByTestId('chat-usage-all-today')).toHaveTextContent('42k in');
  });

  it('refreshes exactly once per run-ended event (no duplicate read)', async () => {
    const summary = vi.fn<UsageApi['summary']>(async () => summaryWith(10, 20));
    const usage: UsageApi = { summary, pricing: vi.fn(async () => []) };
    const gen = fakeGenEvents();

    render(
      <ChatPanel
        sessionId="s1"
        client={llmClient()}
        usageClient={usage}
        genEventsClient={gen.client}
      />,
    );
    await waitFor(() => expect(summary.mock.calls.length).toBe(1));

    gen.emit({ requestId: 'wp-1' });
    await waitFor(() => expect(summary.mock.calls.length).toBe(2));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(summary.mock.calls.length).toBe(2);
  });
});
