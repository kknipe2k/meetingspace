import type { GenKind, GenProgress, GenStatus } from '@shared/types';

/*
 * The in-flight generation registry (M07.B; REVIEW-V11 F12 — M07.C extends). Generation
 * DECOUPLES from the modal: closing the modal detaches the renderer, but the main-side
 * stream keeps running. So main tracks which run is live; the renderer queries
 * `gen:status(sessionId)` on (re)open and reattaches to it.
 *
 * M07.C (product-owner scope amendment): this registry is ALSO the authority for the
 * single build slot — only one artifact build may run at a time, app-wide. EVERY
 * streaming gen run registers (the renderer-invocable focus leg too, or two builds
 * could overlap through start-over), but only user-facing runs (whitepaper | minutes)
 * are ADVERTISED via forSession / the run-started broadcast — the focus leg holds the
 * slot without ever appearing as an in-flight document. `anyLive()` answers the slot
 * check across all of them.
 *
 * Keyed by requestId internally (settle is by requestId), looked up by session. The
 * clock is injected for deterministic `startedAt`. Pure in-memory map, no key, no SDK.
 */
type Clock = () => number;

interface RegisteredRun {
  readonly status: GenStatus;
  readonly userFacing: boolean;
}

export interface InFlightRegistry {
  /** Record a run (called when a streaming gen run starts); returns the created status
   *  so the handler can broadcast user-facing runs as `gen:run-started`. `userFacing`
   *  defaults true; the internal focus leg passes false (slot held, never advertised). */
  start(entry: {
    requestId: string;
    sessionId: string;
    kind: GenKind;
    userFacing?: boolean;
  }): GenStatus;
  /** Record the latest step for a run (so a reattaching renderer shows "Section 3 of 7"). */
  setProgress(requestId: string, progress: GenProgress): void;
  /** Drop the run on settle (done / error / cancel). Unknown id is a safe no-op. */
  finish(requestId: string): void;
  /** The USER-FACING in-flight run for a session, or null. Scoped — a run for another
   *  session (and the internal focus leg) is invisible here. */
  forSession(sessionId: string): GenStatus | null;
  /** ANY live run, app-wide — the single-build-slot check (M07.C amendment). */
  anyLive(): GenStatus | null;
}

export function createInFlightRegistry(now: Clock = Date.now): InFlightRegistry {
  const runs = new Map<string, RegisteredRun>();
  return {
    start({ requestId, sessionId, kind, userFacing = true }) {
      const status: GenStatus = { requestId, sessionId, kind, progress: null, startedAt: now() };
      runs.set(requestId, { status, userFacing });
      return status;
    },
    setProgress(requestId, progress) {
      const run = runs.get(requestId);
      if (run !== undefined) {
        runs.set(requestId, { ...run, status: { ...run.status, progress } });
      }
    },
    finish(requestId) {
      runs.delete(requestId);
    },
    forSession(sessionId) {
      for (const run of runs.values()) {
        if (run.userFacing && run.status.sessionId === sessionId) {
          return run.status;
        }
      }
      return null;
    },
    anyLive() {
      for (const run of runs.values()) {
        return run.status;
      }
      return null;
    },
  };
}
