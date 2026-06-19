import { useCallback, useEffect, useState } from 'react';

import type { UsageSummary } from '@shared/types';

import { usageClient, type UsageClient } from '../ipc/client';

/*
 * The passive usage-counter hook (M06.D, ADR-0021/0022/0024). Fetches the two TODAY-windowed
 * rollups (this session today + all sessions today; REAL usage across all kinds: chat + generation;
 * cost computed main-side from the pricing config) on mount, when the open session changes, and on
 * demand. `refresh` is called after a chat turn AND after a generation run completes so the counter
 * reflects the latest spend. Read-only — no cap, no alert; holds no key.
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
): UseUsageCounter {
  const [summary, setSummary] = useState<UsageSummary>(EMPTY);

  const refresh = useCallback(() => {
    void client.summary(sessionId).then(setSummary);
  }, [client, sessionId]);

  useEffect(() => {
    let active = true;
    void client.summary(sessionId).then((next) => {
      if (active) {
        setSummary(next);
      }
    });
    return () => {
      active = false;
    };
  }, [client, sessionId]);

  return { summary, refresh };
}
