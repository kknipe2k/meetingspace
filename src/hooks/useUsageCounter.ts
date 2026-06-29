import { useCallback, useEffect, useRef, useState } from 'react';

import type { UsageSummary } from '@shared/types';

import {
  genEventsClient,
  usageClient,
  type GenEventsClient,
  type UsageClient,
} from '../ipc/client';

/*
 * The passive usage-counter hook (M06.D, ADR-0021/0022/0024; M08.C hardening). Fetches the two
 * TODAY-windowed rollups (this session today + all sessions today; REAL usage across all kinds:
 * chat + generation; cost computed main-side from the pricing config) on mount, when the open
 * session changes, on demand (after a chat turn), and — M08.C — on the app-wide `gen:run-ended`
 * event. That event is the SOLE generation-refresh trigger and is subscribed HERE, where the counter
 * is owned, so a generation that finishes (success / failure / cancellation) refreshes the totals
 * even when the document modal is closed. Read-only — no cap, no alert; holds no key.
 *
 * M08.C ordering guarantee: every summary read is tagged with a monotonic sequence and only the
 * latest-issued response may set state — so a slow earlier read can't clobber a newer one, and a
 * prior session's late response is ignored (the session-change effect issues a newer read, bumping
 * the sequence). A failed read is caught — a read error never leaks an unhandled rejection nor blanks
 * the last good totals.
 */
const EMPTY_TOTALS = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
  unpricedCalls: 0,
} as const;
const EMPTY: UsageSummary = { sessionToday: EMPTY_TOTALS, allToday: EMPTY_TOTALS };

export interface UseUsageCounter {
  summary: UsageSummary;
  refresh(): void;
}

export function useUsageCounter(
  sessionId: string,
  client: UsageClient = usageClient,
  genEvents: GenEventsClient = genEventsClient,
): UseUsageCounter {
  const [summary, setSummary] = useState<UsageSummary>(EMPTY);
  // The monotonic request sequence. Each read claims the next number; a response applies only when
  // it is still the latest issued — older / cross-session responses are dropped.
  const seqRef = useRef(0);

  const fetchSummary = useCallback((): void => {
    const seq = (seqRef.current += 1);
    client
      .summary(sessionId)
      .then((next) => {
        if (seq === seqRef.current) {
          setSummary(next);
        }
      })
      .catch(() => {
        // A failed read leaves the last good totals intact — never an unhandled rejection.
      });
  }, [client, sessionId]);

  // Mount + on a session change: fetch this session's rollup. fetchSummary bumps the sequence, so
  // any in-flight prior-session read is ignored when it resolves after the switch.
  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  // The app-wide gen:run-ended event — the SOLE generation-refresh trigger. Success / failure /
  // cancellation each fire it exactly once (gated main-side on a user-facing run), modal open or
  // closed, so each settle refreshes the counter exactly once.
  useEffect(() => genEvents.onRunEnded(() => fetchSummary()), [genEvents, fetchSummary]);

  return { summary, refresh: fetchSummary };
}
