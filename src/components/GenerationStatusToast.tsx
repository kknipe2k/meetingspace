import { useEffect, useRef, useState, type ReactElement } from 'react';

import type { GenProgress, GenStatus } from '@shared/types';

import { genKindLabel } from '../gen/progress';
import { formatElapsed } from '../hooks/useElapsed';
import { useToasts } from '../hooks/useToasts';
import { genClient, type GenClient } from '../ipc/client';

/*
 * The app-level run-status controller (M07.B; product-owner reversal at IRL). The rejected
 * first build owned the run/cancel toast INSIDE the modal, so it died with the modal's
 * mount/unmount (and StrictMode's double-mount) — it blinked and vanished. The fix: an
 * always-mounted controller (rendered in App, INSIDE the ToastProvider) driven purely by
 * main-side run lifecycle.
 *
 * `gen:run-started` (a GenStatus) adds a run; `gen:run-ended` removes it (and, on a tier
 * failure, lands an explanatory error toast so the user learns WHY a run stopped even with
 * the modal closed — the elapsed m:ss alone never says a 20-minute ceiling exists). While a
 * run is live it shows ONE persistent toast — `{session} · {kind} — {m:ss}` + Cancel — that
 * is independent of any modal, so it is visible inside and outside and survives a modal
 * close. Renderer-only consumption of the typed gen surface — no key, no SDK.
 */
// The controller needs only the run-lifecycle + progress slice of the gen client.
export type GenStatusClient = Pick<
  GenClient,
  'onRunStarted' | 'onRunEnded' | 'onProgress' | 'cancel'
>;

export interface GenerationStatusToastProps {
  /** Injectable for tests; defaults to the real gen IPC client. */
  client?: GenStatusClient;
  /** Resolves a run's session id to its display name (App passes the live session list). */
  sessionName?(sessionId: string): string | undefined;
}

export function GenerationStatusToast({
  client = genClient,
  sessionName,
}: GenerationStatusToastProps): ReactElement | null {
  const { show, dismiss } = useToasts();
  const [runs, setRuns] = useState<readonly GenStatus[]>([]);
  // The latest step per live run (M07.C chunked progress — "Section 3 of 7"), fed by
  // the unkeyed gen:progress subscription so the toast line names the current step.
  const [steps, setSteps] = useState<Readonly<Record<string, GenProgress>>>({});
  // Bumped once a second while any run is live so each toast's m:ss re-renders.
  const [tick, setTick] = useState(0);
  const sessionNameRef = useRef(sessionName);
  sessionNameRef.current = sessionName;

  // Subscribe to the main-side run lifecycle. Independent of any modal — this controller is
  // always mounted, so it never misses a run-started/ended.
  useEffect(() => {
    const offStarted = client.onRunStarted((run) => {
      setRuns((prev) => (prev.some((r) => r.requestId === run.requestId) ? prev : [...prev, run]));
    });
    const offProgress = client.onProgress(({ requestId, progress }) => {
      setSteps((prev) => ({ ...prev, [requestId]: progress }));
    });
    const offEnded = client.onRunEnded(({ requestId, error }) => {
      setRuns((prev) => prev.filter((r) => r.requestId !== requestId));
      setSteps((prev) => {
        const { [requestId]: _settled, ...rest } = prev;
        return rest;
      });
      dismiss(`gen-run-${requestId}`);
      // Surface the reason a run stopped — the live counter never conveys it, and the
      // modal may be closed. M07.C fix #4 widened this from the TIMEOUT_ tiers to
      // EVERY failure (the step-tagged messages are static and key-free): a run must
      // never die blind. CANCELLED stays silent — a cancel is the user's own act.
      if (error && error.code !== 'CANCELLED') {
        show({
          key: `gen-end-${requestId}`,
          variant: 'error',
          message: error.message,
          durationMs: 12_000,
        });
      }
    });
    return () => {
      offStarted();
      offProgress();
      offEnded();
    };
  }, [client, show, dismiss]);

  // Tick while any run is live so the elapsed counter advances.
  useEffect(() => {
    if (runs.length === 0) {
      return undefined;
    }
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [runs.length]);

  // Render one persistent toast per live run, refreshed each tick with the current elapsed.
  useEffect(() => {
    for (const run of runs) {
      if (run.kind !== 'whitepaper' && run.kind !== 'minutes') {
        continue;
      }
      const name = sessionNameRef.current?.(run.sessionId);
      const elapsed = formatElapsed(Math.max(0, Date.now() - run.startedAt));
      // Replace-by-key: the run's ONE toast updates in place — the chunked steps
      // ("Section 3 of 7 — Architecture") never stack a second notification.
      const step = steps[run.requestId];
      show({
        key: `gen-run-${run.requestId}`,
        variant: 'progress',
        message: `${name ? `${name} · ` : ''}${genKindLabel(run.kind)} — ${elapsed}${step ? ` · ${step.label}` : ''}`,
        action: { label: 'Cancel', onClick: () => void client.cancel(run.requestId) },
        durationMs: null,
      });
    }
    // Re-runs when a run is added/removed (`runs`), a step lands (`steps`), or the second
    // ticks (`tick`); `show` is a stable provider callback, so this never loops.
  }, [runs, steps, tick, show, client]);

  return null;
}
