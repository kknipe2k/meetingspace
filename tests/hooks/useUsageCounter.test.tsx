// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { GenRunEnded, UsageSummary, UsageTotals } from '@shared/types';

import type { UsageClient } from '../../src/ipc/client';
import { useUsageCounter } from '../../src/hooks/useUsageCounter';

/*
 * M08.C — the passive usage counter is owned HERE, so generation spend must reach it without the
 * document modal. Two contract changes:
 *   (1) the hook subscribes to the app-wide `gen:run-ended` event and refreshes on each settle
 *       (success / error / cancel), modal open or closed — the SOLE generation-refresh trigger;
 *   (2) summary requests are MONOTONICALLY ordered — only the latest-issued response may set state,
 *       a prior session's late response is ignored, and a read failure never leaks an unhandled
 *       rejection. Driven through fakes — no key, no SDK, no IPC round-trip.
 */
function totals(input: number): UsageTotals {
  return {
    inputTokens: input,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    unpricedCalls: 0,
  };
}
function summaryWith(input: number): UsageSummary {
  return { sessionToday: totals(input), allToday: totals(input) };
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
    emit: (e: GenRunEnded = { requestId: 'r' }): void => act(() => listener?.(e)),
    subscribed: (): boolean => listener !== null,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = (): Promise<void> =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

// Indexed access under noUncheckedIndexedAccess — assert the in-flight read exists.
function take<T>(arr: T[], i: number): T {
  const value = arr[i];
  if (value === undefined) {
    throw new Error(`no pending read at index ${i}`);
  }
  return value;
}

describe('useUsageCounter — event-driven refresh + monotonic ordering (M08.C)', () => {
  it('subscribes to gen:run-ended and refreshes the summary when a run settles', async () => {
    const summary = vi.fn(async () => summaryWith(5));
    const usage: UsageClient = {
      summary,
      pricing: vi.fn(async () => ({ priced: [], unpriced: [] })),
    };
    const gen = fakeGenEvents();

    const { result } = renderHook(() => useUsageCounter('s1', usage, gen.client));
    await waitFor(() => expect(result.current.summary.sessionToday.inputTokens).toBe(5));
    expect(gen.subscribed()).toBe(true);
    const afterMount = summary.mock.calls.length;

    // A background run finished (modal open or closed) — the counter re-queries app-wide.
    gen.emit({ requestId: 'wp-1' });
    await waitFor(() => expect(summary.mock.calls.length).toBe(afterMount + 1));
  });

  it('refreshes exactly once per run-ended event (no duplicate)', async () => {
    const summary = vi.fn(async () => summaryWith(5));
    const usage: UsageClient = {
      summary,
      pricing: vi.fn(async () => ({ priced: [], unpriced: [] })),
    };
    const gen = fakeGenEvents();

    renderHook(() => useUsageCounter('s1', usage, gen.client));
    await waitFor(() => expect(summary.mock.calls.length).toBe(1));

    gen.emit({ requestId: 'wp-1' });
    await waitFor(() => expect(summary.mock.calls.length).toBe(2));
    await flush();
    expect(summary.mock.calls.length).toBe(2);
  });

  it('does not let a stale, out-of-order summary response regress the totals', async () => {
    const pending: Array<ReturnType<typeof deferred<UsageSummary>>> = [];
    const summary = vi.fn(() => {
      const d = deferred<UsageSummary>();
      pending.push(d);
      return d.promise;
    });
    const usage: UsageClient = {
      summary,
      pricing: vi.fn(async () => ({ priced: [], unpriced: [] })),
    };
    const gen = fakeGenEvents();

    const { result } = renderHook(() => useUsageCounter('s1', usage, gen.client));
    // Mount fetch (#0) resolves first.
    await act(async () => {
      take(pending, 0).resolve(summaryWith(1));
    });
    expect(result.current.summary.sessionToday.inputTokens).toBe(1);

    // Two refreshes go in flight: #1 then #2.
    gen.emit({ requestId: 'a' });
    gen.emit({ requestId: 'b' });
    await waitFor(() => expect(pending.length).toBe(3));

    // The NEWER request (#2) resolves first → applied.
    await act(async () => {
      take(pending, 2).resolve(summaryWith(20));
    });
    expect(result.current.summary.sessionToday.inputTokens).toBe(20);

    // The OLDER request (#1) resolves late → must be IGNORED (no regression).
    await act(async () => {
      take(pending, 1).resolve(summaryWith(9));
    });
    expect(result.current.summary.sessionToday.inputTokens).toBe(20);
  });

  it('ignores a prior-session summary that resolves after the session changes', async () => {
    const pending: Array<ReturnType<typeof deferred<UsageSummary>>> = [];
    const summary = vi.fn(() => {
      const d = deferred<UsageSummary>();
      pending.push(d);
      return d.promise;
    });
    const usage: UsageClient = {
      summary,
      pricing: vi.fn(async () => ({ priced: [], unpriced: [] })),
    };
    const gen = fakeGenEvents();

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useUsageCounter(id, usage, gen.client),
      { initialProps: { id: 's1' } },
    );
    // s1 mount fetch (#0).
    await act(async () => {
      take(pending, 0).resolve(summaryWith(1));
    });
    expect(result.current.summary.sessionToday.inputTokens).toBe(1);

    // A refresh for s1 (#1) goes in flight, THEN the open session changes to s2 (#2).
    gen.emit({ requestId: 's1-run' });
    await waitFor(() => expect(pending.length).toBe(2));
    rerender({ id: 's2' });
    await waitFor(() => expect(pending.length).toBe(3));

    // s2's fetch resolves → applied.
    await act(async () => {
      take(pending, 2).resolve(summaryWith(50));
    });
    expect(result.current.summary.sessionToday.inputTokens).toBe(50);

    // The late s1 refresh resolves → must NOT apply a prior session's result.
    await act(async () => {
      take(pending, 1).resolve(summaryWith(7));
    });
    expect(result.current.summary.sessionToday.inputTokens).toBe(50);
  });

  it('tolerates a summary read failure without an unhandled rejection (totals retained)', async () => {
    // vitest surfaces unhandled rejections via node's `process` (not jsdom's window) — capture there,
    // muting the runner's own handler for the window of this test so OUR assertion is the judge.
    const captured: unknown[] = [];
    const prior = process.listeners('unhandledRejection');
    prior.forEach((l) => process.off('unhandledRejection', l));
    const onRejection = (reason: unknown): void => {
      captured.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const summary = vi
        .fn<UsageClient['summary']>()
        .mockResolvedValueOnce(summaryWith(3))
        .mockRejectedValueOnce(new Error('read failed'));
      const usage: UsageClient = {
        summary,
        pricing: vi.fn(async () => ({ priced: [], unpriced: [] })),
      };
      const gen = fakeGenEvents();

      const { result } = renderHook(() => useUsageCounter('s1', usage, gen.client));
      await waitFor(() => expect(result.current.summary.sessionToday.inputTokens).toBe(3));

      // The chat-turn refresh path: the next read REJECTS — the hook must catch it.
      await act(async () => {
        result.current.refresh();
      });
      await flush();
      await flush();

      expect(captured).toHaveLength(0);
      // The last good totals are retained — a failed read never blanks the counter.
      expect(result.current.summary.sessionToday.inputTokens).toBe(3);
    } finally {
      process.off('unhandledRejection', onRejection);
      prior.forEach((l) => process.on('unhandledRejection', l as (reason: unknown) => void));
    }
  });
});
