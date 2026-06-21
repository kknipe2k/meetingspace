// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { LlmApi, UsageApi } from '@shared/api';
import type { ChatMessage, UsageSummary } from '@shared/types';

import { ChatPanel } from '../../src/components/ChatPanel';

/*
 * M06.D (ADR-0020 + ADR-0021; counter rescoped by ADR-0024): ChatPanel hydrates the persisted
 * thread on open (the conversation survives reload) and shows the passive usage counter as two
 * TODAY-windowed rows — this session today + all sessions today, queried with the open sessionId.
 * Driven with fakes — no key, no SDK.
 */
const THREAD: ChatMessage[] = [
  {
    id: 'c1',
    sessionId: 's1',
    role: 'user',
    content: 'When did we ship?',
    model: null,
    createdAt: 1,
  },
  {
    id: 'c2',
    sessionId: 's1',
    role: 'assistant',
    content: 'We shipped Friday.',
    model: 'claude-haiku-4-5',
    createdAt: 2,
  },
];

function llmClient(thread: ChatMessage[]): LlmApi {
  return {
    chat: () => () => undefined,
    history: vi.fn(async () => thread),
  };
}

const SUMMARY: UsageSummary = {
  sessionToday: {
    inputTokens: 1200,
    outputTokens: 340,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0.0123,
    unpricedCalls: 0,
  },
  allToday: {
    inputTokens: 5600,
    outputTokens: 900,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0.05,
    unpricedCalls: 0,
  },
};

function usageClient(summary: UsageSummary): UsageApi {
  return {
    summary: vi.fn(async () => summary),
    pricing: vi.fn(async () => []),
  };
}

describe('ChatPanel — persisted history + usage counter', () => {
  it('hydrates the persisted thread on mount', async () => {
    render(
      <ChatPanel sessionId="s1" client={llmClient(THREAD)} usageClient={usageClient(SUMMARY)} />,
    );

    expect(await screen.findByText('When did we ship?')).toBeInTheDocument();
    expect(screen.getByText('We shipped Friday.')).toBeInTheDocument();
  });

  it('renders the two today-windowed rows: This session · today and All sessions · today', async () => {
    render(<ChatPanel sessionId="s1" client={llmClient([])} usageClient={usageClient(SUMMARY)} />);

    const sessionRow = await screen.findByTestId('chat-usage-session-today');
    const allRow = screen.getByTestId('chat-usage-all-today');
    // The ADR-0024 relabel: per-session today + all-sessions today (no all-time total row).
    expect(sessionRow).toHaveTextContent('This session · today');
    expect(allRow).toHaveTextContent('All sessions · today');
    // Tokens abbreviated with a k/M suffix (1–3 sig figs): 1200 → 1.2k, 340 → 340, 5600 → 5.6k.
    expect(sessionRow).toHaveTextContent('1.2k in · 340 out');
    expect(allRow).toHaveTextContent('5.6k in');
    // Cost as a dollar amount.
    expect(sessionRow).toHaveTextContent(/\$0\.01/);
    // The dropped all-time "Total" row is gone.
    expect(screen.queryByTestId('chat-usage-total')).toBeNull();
  });

  it('abbreviates large counts with k/M and shows "cost unknown" when every call is unpriced', async () => {
    const summary: UsageSummary = {
      sessionToday: {
        inputTokens: 1_234_567, // → 1.2M
        outputTokens: 12_300, // → 12.3k
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0, // every contributing call unpriced…
        unpricedCalls: 2, // …so cost is unknown, not $0.00
      },
      allToday: {
        inputTokens: 999, // < 1000 → shown as-is
        outputTokens: 1_000, // → 1k (trailing .0 stripped)
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.04,
        unpricedCalls: 1, // mixed → "$0.04 +1 unpriced"
      },
    };
    render(<ChatPanel sessionId="s1" client={llmClient([])} usageClient={usageClient(summary)} />);

    const sessionRow = await screen.findByTestId('chat-usage-session-today');
    const allRow = screen.getByTestId('chat-usage-all-today');
    expect(sessionRow).toHaveTextContent('1.2M in · 12.3k out · cost unknown');
    expect(allRow).toHaveTextContent('999 in · 1k out · $0.04 +1 unpriced');
  });

  it('queries the counter with the OPEN sessionId (ADR-0024 — session-aware again)', async () => {
    const usage = usageClient(SUMMARY);
    render(<ChatPanel sessionId="s1" client={llmClient([])} usageClient={usage} />);
    await waitFor(() => expect(usage.summary).toHaveBeenCalled());
    expect(usage.summary).toHaveBeenCalledWith('s1');
  });

  it('refreshes the counter when a generation run completes (usageRefreshKey bump)', async () => {
    const usage = usageClient(SUMMARY);
    const { rerender } = render(
      <ChatPanel sessionId="s1" client={llmClient([])} usageClient={usage} usageRefreshKey={0} />,
    );
    await waitFor(() => expect(usage.summary).toHaveBeenCalled());
    const callsAfterMount = (usage.summary as ReturnType<typeof vi.fn>).mock.calls.length;

    // LLMPanel bumps the key when a generation run completes → the counter re-queries app-wide.
    rerender(
      <ChatPanel sessionId="s1" client={llmClient([])} usageClient={usage} usageRefreshKey={1} />,
    );
    await waitFor(() =>
      expect((usage.summary as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
        callsAfterMount,
      ),
    );
  });
});
