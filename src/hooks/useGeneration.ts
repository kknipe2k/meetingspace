import { useCallback, useEffect, useRef, useState } from 'react';

import type { GenStreamHandle } from '@shared/api';
import type { GenKind, GenProgress, GenStatus, LlmErrorPayload } from '@shared/types';

import { genClient, type GenClient } from '../ipc/client';

/*
 * Drives document generation (M04.B; M04.C experience; M07.B decouple + truthful modal;
 * M07.C chunked progress + single build slot). The renderer holds NO key and NO SDK —
 * it calls the typed `gen` IPC, which streams HTML back as requestId-keyed
 * progress/chunk/done/error events.
 *
 * PER-MODE committed docs (M04.C): each mode (whitepaper / minutes / raw) keeps its OWN
 * committed document + the model that produced it, so switching modes never blanks another
 * mode's result. Streamed HTML accumulates in a ref and is NEVER rendered. M07.C: when a
 * run persists an artifact (chunked runs assemble main-side, so the streamed deltas are
 * NOT the final doc), the slot reloads from STORAGE on done — the persisted artifact is
 * authoritative; the local buffer commits only for buffer-only results (no artifactId).
 *
 * M07.B — generation DECOUPLES from the modal (REVIEW-V11 F12). Generation is MANUAL:
 * opening the modal NEVER starts a run. On unmount we DETACH (the main-side run keeps
 * streaming), not cancel; only an explicit Cancel stops spend. On mount we (a) load the
 * latest persisted doc PER KIND (F16), and (b) reattach to an in-flight run if one exists.
 *
 * M07.C — the single build slot (product-owner amendment): main refuses a Generate while
 * ANY build is live; the bridge surfaces the typed refusal via onBusy with the live run's
 * GenStatus. `busy` exposes it (the view raises the explanatory toast) and
 * `cancelCurrentAndStart` is the ONLY auto-start path: cancel the live run, wait for ITS
 * gen:run-ended, then re-fire the refused params. A cancel from anywhere else NEVER
 * chains into a new build (the pinned invariant).
 */
export type GenMode = 'whitepaper' | 'minutes' | 'raw';

export interface ModeDoc {
  /** The committed document HTML for this mode (untrusted — sanitize before rendering). */
  readonly html: string;
  /** The model the API answered with for this mode's doc (for the badge), or null. */
  readonly model: string | null;
  /** The id of the template that produced this doc (for the template chip), or null
   *  (raw / no-content / pre-template docs). */
  readonly templateId: string | null;
}

export interface UseGenerationOptions {
  client?: GenClient;
  /** Called when a generation RUN completes (a real SDK run — whitepaper/minutes/reattach), so the
   *  app-wide usage counter can refresh to include the generation spend (ADR-0022). */
  onComplete?(): void;
}

export interface GenerateParams {
  mode: GenMode;
  model?: string;
  templateId?: string;
  /** Whitepaper only: recompute the FOCUS analysis before writing (Start over) instead
   *  of reusing the saved one (Regenerate / first Generate). */
  reanalyze?: boolean;
}

export interface UseGeneration {
  /** The committed doc + model for a given mode (empty until that mode runs/reloads). */
  docFor(mode: GenMode): ModeDoc;
  isStreaming: boolean;
  /** Which mode is currently generating (null when idle). */
  streamingMode: GenMode | null;
  error: LlmErrorPayload | null;
  /** The current step's progress (open shape — "Section 3 of 7"), or null when idle. */
  progress: GenProgress | null;
  /** The LIVE run main refused this start for (single build slot), or null. */
  busy: GenStatus | null;
  /** The mode to show on open — the most-recently generated persisted artifact, or null. */
  initialMode: GenMode | null;
  generate(params: GenerateParams): void;
  /** Whitepaper re-analyze: re-run Part 1 (FOCUS) then the write step. */
  startOver(params: GenerateParams): void;
  /** Re-run the last generate/startOver after a transient error (TIMEOUT etc.). */
  retry(): void;
  /** Explicit stop — aborts the main-side stream (no further spend, no persist). */
  cancel(): void;
  /** The ONE auto-start path (explicitly-labeled in the UI): cancel the live run that
   *  refused this start, wait for ITS run-ended, then re-fire the refused params. */
  cancelCurrentAndStart(): void;
  /** Re-run the mount query (latest-per-kind + in-flight status) — the manual refresh. */
  refresh(): void;
}

const EMPTY_DOC: ModeDoc = { html: '', model: null, templateId: null };
const EMPTY_DOCS: Record<GenMode, ModeDoc> = {
  whitepaper: EMPTY_DOC,
  minutes: EMPTY_DOC,
  raw: EMPTY_DOC,
};

export function useGeneration(
  sessionId: string,
  options: UseGenerationOptions = {},
): UseGeneration {
  const { client = genClient } = options;

  // Latest onComplete on a ref so it never churns the stream-callback identity (the graduated
  // context-value dep-loop gotcha). Fired when a real run settles successfully (below).
  const onCompleteRef = useRef(options.onComplete);
  onCompleteRef.current = options.onComplete;

  const [docs, setDocs] = useState<Record<GenMode, ModeDoc>>(EMPTY_DOCS);
  // Latest docs on a ref so cancel can restore the pre-run slot without a reactive dep.
  const docsRef = useRef<Record<GenMode, ModeDoc>>(EMPTY_DOCS);
  docsRef.current = docs;
  const [initialMode, setInitialMode] = useState<GenMode | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingMode, setStreamingMode] = useState<GenMode | null>(null);
  const [error, setError] = useState<LlmErrorPayload | null>(null);
  const [progress, setProgress] = useState<GenProgress | null>(null);
  const [busy, setBusy] = useState<GenStatus | null>(null);
  // Bumped by refresh() to re-run the mount reconciliation effect.
  const [reloadToken, setReloadToken] = useState(0);

  // Streaming HTML + the answering model accumulate HERE, off-screen, until committed.
  const accRef = useRef('');
  const modelRef = useRef<string | null>(null);
  const cancelRef = useRef<GenStreamHandle | null>(null);
  // The last run's params (the reanalyze flag rides along) so a transient error can be
  // retried AND so the busy handoff can re-fire the refused start.
  const lastRunRef = useRef<{ params: GenerateParams } | null>(null);
  // The pending busy handoff's run-ended unsubscribe — torn down on unmount so a
  // handoff can never auto-start into a dead (closed) modal.
  const handoffUnsubRef = useRef<(() => void) | null>(null);
  // The committed slot snapshot taken when a run STARTS, so an explicit Cancel reverts the
  // shown doc (+ its template chip) to exactly the last committed state — never the
  // abandoned run's template. Cleared/reset on each new run.
  const runSnapshotRef = useRef<{ mode: GenMode; doc: ModeDoc } | null>(null);
  // True once the user cancels and until the next run/refresh — makes a late
  // gen:artifact-saved for the abandoned run a no-op (the broadcast carries no requestId,
  // so this is how the renderer declines to adopt a run it abandoned).
  const cancelledRef = useRef(false);

  const fail = useCallback((payload: LlmErrorPayload): void => {
    cancelRef.current = null;
    setIsStreaming(false);
    setStreamingMode(null);
    setProgress(null);
    setError(payload);
  }, []);

  const commit = useCallback((kind: GenMode): void => {
    cancelRef.current = null;
    // Buffer-only commits are the no-content marker / raw doc — no template.
    const committed: ModeDoc = { html: accRef.current, model: modelRef.current, templateId: null };
    setDocs((prev) => ({ ...prev, [kind]: committed }));
    setIsStreaming(false);
    setStreamingMode(null);
    setProgress(null);
  }, []);

  // Clear the streaming UI WITHOUT committing the local buffer — used when a run's
  // authoritative doc is the PERSISTED artifact (chunked assembly / reattach), which
  // is reloaded from storage instead of the partial local buffer.
  const finishStreaming = useCallback((): void => {
    cancelRef.current = null;
    setIsStreaming(false);
    setStreamingMode(null);
    setProgress(null);
  }, []);

  // Reload one kind's slot from the latest persisted artifact (F16). Used by the
  // gen:artifact-saved push, a reattached run's done, and any persisting done (M07.C —
  // the assembled doc, not the streamed deltas, is the document). A failure is benign.
  const reloadSlot = useCallback(
    async (kind: GenKind): Promise<void> => {
      if (kind !== 'whitepaper' && kind !== 'minutes') {
        return;
      }
      // The user abandoned the in-flight run — don't adopt its (possibly just-saved) doc.
      if (cancelledRef.current) {
        return;
      }
      try {
        const arts = await client.getLatestArtifacts(sessionId);
        const doc = arts.find((d) => d.kind === kind);
        if (doc) {
          setDocs((prev) => ({
            ...prev,
            [kind]: { html: doc.content, model: doc.model ?? null, templateId: doc.templateId },
          }));
        }
      } catch {
        // Non-fatal: a failed live refresh leaves the prior slot intact.
      }
    },
    [client, sessionId],
  );

  // The single-slot refusal (M07.C): main never started a run — clear the optimistic
  // streaming state and surface the LIVE run so the view raises the busy toast.
  const refused = useCallback((live: GenStatus): void => {
    cancelRef.current = null;
    setIsStreaming(false);
    setStreamingMode(null);
    setProgress(null);
    setBusy(live);
  }, []);

  const streamCallbacks = useCallback(
    (kind: GenMode, reattach = false) => ({
      onChunk: (delta: string) => {
        accRef.current += delta;
      },
      onProgress: (next: GenProgress) => setProgress(next),
      onDone: (result: { model?: string; artifactId?: string }) => {
        modelRef.current = result.model ?? null;
        if (reattach || result.artifactId !== undefined) {
          // The persisted artifact is authoritative (assembled main-side / joined
          // mid-stream) — reload it rather than committing the local buffer.
          void reloadSlot(kind as GenKind);
          finishStreaming();
        } else {
          // Buffer-only result (e.g. the no-content marker) — commit what streamed.
          commit(kind);
        }
        // A run settled — let the owner refresh the app-wide usage counter (ADR-0022).
        onCompleteRef.current?.();
      },
      onError: fail,
      onBusy: refused,
    }),
    [commit, fail, finishStreaming, reloadSlot, refused],
  );

  // Mount reconciliation (F12/F16): load latest-per-kind + ask main for an in-flight run.
  // Reattach to a live run if one exists; otherwise just surface the persisted docs (NO
  // auto-start — generation is manual). Subscribe to the persist broadcast (scoped to this
  // session). On unmount: DETACH (keep the run alive), never cancel.
  useEffect(() => {
    let active = true;
    // A (re)mount or manual refresh re-enables artifact adoption (clears a prior cancel).
    cancelledRef.current = false;

    Promise.all([client.getLatestArtifacts(sessionId), client.status(sessionId)])
      .then(([arts, status]) => {
        if (!active) {
          return;
        }
        const whitepaper = arts.find((d) => d.kind === 'whitepaper');
        const minutes = arts.find((d) => d.kind === 'minutes');
        setDocs((prev) => ({
          ...prev,
          ...(whitepaper
            ? {
                whitepaper: {
                  html: whitepaper.content,
                  model: whitepaper.model ?? null,
                  templateId: whitepaper.templateId,
                },
              }
            : {}),
          ...(minutes
            ? {
                minutes: {
                  html: minutes.content,
                  model: minutes.model ?? null,
                  templateId: minutes.templateId,
                },
              }
            : {}),
        }));
        const newest = arts.find((d) => d.kind === 'whitepaper' || d.kind === 'minutes');
        if (newest) {
          setInitialMode(newest.kind as GenMode);
        }

        if (status && cancelRef.current === null) {
          // Reattach to the live main-side run — no fresh generate.
          accRef.current = '';
          modelRef.current = null;
          setError(null);
          setIsStreaming(true);
          setStreamingMode(status.kind as GenMode);
          setProgress(status.progress);
          cancelRef.current = client.attach(
            status.requestId,
            streamCallbacks(status.kind as GenMode, true),
          );
        }
      })
      .catch(() => {
        if (active) {
          fail({ code: 'UNKNOWN', message: 'Could not load this session’s documents.' });
        }
      });

    const unsubscribeSaved = client.onArtifactSaved((event) => {
      // Scoped by sessionId — a background session's save never touches this modal.
      if (event.sessionId === sessionId) {
        void reloadSlot(event.kind);
      }
    });

    return () => {
      active = false;
      // The decouple: closing the modal keeps the run alive (reattach on reopen).
      cancelRef.current?.detach();
      cancelRef.current = null;
      unsubscribeSaved();
      // A pending busy handoff dies with the modal — never auto-start into a dead hook.
      handoffUnsubRef.current?.();
      handoffUnsubRef.current = null;
    };
  }, [client, sessionId, streamCallbacks, reloadSlot, fail, reloadToken]);

  // Clear the busy state when the run it points at ends by ANY path — chiefly when the
  // user cancels the live run from the app-level run toast rather than via
  // cancelCurrentAndStart. Without this the "Cancel current & start this one" toast
  // orphans onto a dead run (visible, inert, only dismissable by the ✕). The handoff
  // path clears busy itself; this covers plain-cancel and natural completion too.
  useEffect(() => {
    if (busy === null) {
      return undefined;
    }
    return client.onRunEnded((event) => {
      if (event.requestId === busy.requestId) {
        setBusy(null);
      }
    });
  }, [busy, client]);

  // Setters/refs are stable, so these helpers carry no reactive deps.
  const startRun = useCallback((mode: GenMode): void => {
    // Snapshot the committed slot so a later Cancel reverts to it; re-enable adoption.
    runSnapshotRef.current = { mode, doc: docsRef.current[mode] };
    cancelledRef.current = false;
    // Starting a NEW run replaces any in-flight one — cancel it (stop its spend).
    cancelRef.current?.cancel();
    cancelRef.current = null;
    accRef.current = '';
    modelRef.current = null;
    setError(null);
    setProgress(null);
    setBusy(null);
    setIsStreaming(true);
    setStreamingMode(mode);
  }, []);

  const generate = useCallback(
    (params: GenerateParams): void => {
      lastRunRef.current = { params };
      startRun(params.mode);

      if (params.mode === 'raw') {
        // Raw mode: a main-side assembly of the saved notes — NO SDK call, no badge.
        void client
          .buildRawDoc(sessionId)
          .then((raw) => {
            accRef.current = raw;
            commit('raw');
          })
          .catch(() => fail({ code: 'UNKNOWN', message: 'Could not build the raw document.' }));
        return;
      }

      const request = { sessionId, ...(params.model ? { model: params.model } : {}) };
      cancelRef.current =
        params.mode === 'minutes'
          ? client.generateMinutes(
              { ...request, ...(params.templateId ? { templateId: params.templateId } : {}) },
              streamCallbacks('minutes'),
            )
          : client.generateWhitepaper(
              {
                ...request,
                ...(params.templateId ? { templateId: params.templateId } : {}),
                // Start over = reanalyze; Regenerate/first Generate reuse the saved FOCUS.
                ...(params.reanalyze ? { reanalyze: true } : {}),
              },
              streamCallbacks('whitepaper'),
            );
    },
    [client, sessionId, startRun, streamCallbacks, commit, fail],
  );

  // Start over = the SAME whitepaper run as Generate, with reanalyze:true so main
  // recomputes the FOCUS analysis before writing. No renderer-orchestrated focus leg —
  // it's one main-side run, so the run toast / reattach / single-slot all just work.
  const startOver = useCallback(
    (params: GenerateParams): void => {
      generate({ ...params, reanalyze: true });
    },
    [generate],
  );

  // Latest-render ref so the busy handoff (an event-driven callback) re-fires the
  // refused start without a stale closure. `reanalyze` rides inside the stored params.
  const generateRef = useRef(generate);
  generateRef.current = generate;

  // Re-run the last run (same params, incl. reanalyze) after a transient error. No-op if
  // nothing has run yet or a stream is already in flight.
  const retry = useCallback((): void => {
    const last = lastRunRef.current;
    if (last === null || isStreaming) {
      return;
    }
    generate(last.params);
  }, [isStreaming, generate]);

  const cancel = useCallback((): void => {
    cancelRef.current?.cancel();
    cancelRef.current = null;
    // Decline any late save for this abandoned run, and revert the shown doc (+ chip) to
    // the slot as it was before the run started (last committed, or empty ⇒ no chip).
    cancelledRef.current = true;
    const snapshot = runSnapshotRef.current;
    if (snapshot) {
      setDocs((prev) => ({ ...prev, [snapshot.mode]: snapshot.doc }));
    }
    setIsStreaming(false);
    setStreamingMode(null);
    setProgress(null);
  }, []);

  // The busy handoff — the ONLY path that starts a build off a cancel, and only via
  // the explicitly-labeled UI action. Cancel the LIVE run, then wait for ITS run-ended
  // (an unrelated run settling is not the signal) before re-firing the refused params.
  const cancelCurrentAndStart = useCallback((): void => {
    const live = busy;
    const last = lastRunRef.current;
    if (live === null || last === null || handoffUnsubRef.current !== null) {
      return;
    }
    const unsubscribe = client.onRunEnded((event) => {
      if (event.requestId !== live.requestId) {
        return;
      }
      unsubscribe();
      handoffUnsubRef.current = null;
      setBusy(null);
      generateRef.current(last.params);
    });
    handoffUnsubRef.current = unsubscribe;
    void client.cancel(live.requestId);
  }, [busy, client]);

  // The manual refresh affordance — re-run the mount reconciliation (latest + status).
  const refresh = useCallback((): void => setReloadToken((t) => t + 1), []);

  const docFor = useCallback((mode: GenMode): ModeDoc => docs[mode], [docs]);

  return {
    docFor,
    isStreaming,
    streamingMode,
    error,
    progress,
    busy,
    initialMode,
    generate,
    startOver,
    retry,
    cancel,
    cancelCurrentAndStart,
    refresh,
  };
}
