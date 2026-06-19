import type { GenApi, GenStreamCallbacks, GenStreamHandle } from '@shared/api';
import type {
  ExportImagesResult,
  ExportRequest,
  ExportResult,
  GenArtifactSaved,
  GenDocument,
  GenDone,
  GenFocusRequest,
  GenMinutesRequest,
  GenProgress,
  GenRunEnded,
  GenStartResult,
  GenStatus,
  GenTemplate,
  GenTemplateParts,
  GenWhitepaperRequest,
  LlmErrorPayload,
} from '@shared/types';

import { GEN_CHANNELS } from './channels';
import type { IpcStreamTransport, RequestIdFactory } from './llm-bridge';

/*
 * The renderer-facing generation bridge (M04.A; M07.A wires real cancel; M07.B decouples
 * the run from the modal). `generateFocus`/`Whitepaper`/`Minutes` are event-driven: they
 * invoke their channel with the request plus a generated requestId, then subscribe to
 * chunk/phase/heartbeat/done/error events FILTERED by that requestId.
 *
 * They return a {detach, cancel} handle (M07.B; F12/F14): `detach` removes the renderer's
 * own listeners but leaves the main-side run ALIVE (closing the modal must not kill a long
 * generation), while `cancel` detaches AND invokes gen:cancel (the explicit-stop spend
 * guard). `attach` re-subscribes to an already-running stream by requestId WITHOUT a fresh
 * invoke (reattach on modal reopen, after gen:status). No key and no SDK ever cross here.
 * The transport + requestId factory are injected so the mapping is Node-unit-testable.
 */
interface KeyedPayload {
  readonly requestId?: string;
}

export function createGenApi(
  transport: IpcStreamTransport,
  newRequestId: RequestIdFactory,
): GenApi {
  // Subscribe a set of callbacks to one requestId's keyed events and return the two-intent
  // handle. Shared by fresh streams (which also invoke) and `attach` (which does not).
  const subscribe = (requestId: string, callbacks: GenStreamCallbacks): GenStreamHandle => {
    const offs: Array<() => void> = [];
    let active = true;
    // Detach the renderer's own listeners — used on a normal done/error settle AND on a
    // modal close that keeps the run alive (the decouple). NEVER fires cancel.
    const detach = (): void => {
      if (!active) {
        return;
      }
      active = false;
      for (const off of offs) {
        off();
      }
    };

    const onKeyed = (ch: string, handle: (payload: KeyedPayload) => void): void => {
      offs.push(
        transport.on(ch, (payload) => {
          const keyed = payload as KeyedPayload;
          if (keyed?.requestId === requestId) {
            handle(keyed);
          }
        }),
      );
    };

    onKeyed(GEN_CHANNELS.chunk, (payload) =>
      callbacks.onChunk((payload as { delta: string }).delta),
    );
    onKeyed(GEN_CHANNELS.progress, (payload) =>
      callbacks.onProgress?.((payload as { progress: GenProgress }).progress),
    );
    onKeyed(GEN_CHANNELS.heartbeat, (payload) =>
      callbacks.onHeartbeat?.(payload as { elapsedMs: number; bytes: number }),
    );
    onKeyed(GEN_CHANNELS.done, (payload) => {
      const result = (payload as { result: GenDone }).result;
      detach();
      callbacks.onDone(result);
    });
    onKeyed(GEN_CHANNELS.error, (payload) => {
      const error = (payload as { error: LlmErrorPayload }).error;
      detach();
      callbacks.onError(error);
    });

    return {
      detach,
      // Explicit stop: detach AND tell main to abort the run (F11) so it stops spend and
      // persists nothing. Guarded by `active`, so a cancel after settle is a no-op.
      cancel: (): void => {
        if (!active) {
          return;
        }
        detach();
        void transport.invoke(GEN_CHANNELS.cancel, { requestId });
      },
    };
  };

  // A fresh stream: generate a requestId, subscribe, then fire the invoke. The invoke
  // resolves the typed GenStartResult (M07.C single build slot): on a busy refusal no
  // stream is coming — detach the listeners and surface the LIVE run via onBusy so the
  // refusal is never silent (the modal raises the labeled cancel-&-start toast).
  const stream = (
    channel: string,
    request: GenFocusRequest | GenWhitepaperRequest | GenMinutesRequest,
    callbacks: GenStreamCallbacks,
  ): GenStreamHandle => {
    const requestId = newRequestId();
    const handle = subscribe(requestId, callbacks);
    void transport.invoke(channel, { ...request, requestId }).then((resolution) => {
      const result = resolution as GenStartResult | undefined;
      if (result && result.started === false) {
        handle.detach();
        callbacks.onBusy?.(result.live);
      }
    });
    return handle;
  };

  return {
    generateFocus: (request: GenFocusRequest, callbacks: GenStreamCallbacks): GenStreamHandle =>
      stream(GEN_CHANNELS.generateFocus, request, callbacks),

    generateWhitepaper: (
      request: GenWhitepaperRequest,
      callbacks: GenStreamCallbacks,
    ): GenStreamHandle => stream(GEN_CHANNELS.generateWhitepaper, request, callbacks),

    generateMinutes: (request: GenMinutesRequest, callbacks: GenStreamCallbacks): GenStreamHandle =>
      stream(GEN_CHANNELS.generateMinutes, request, callbacks),

    // Reattach to an existing run — subscribe only, no invoke (F12 reopen-during-run).
    attach: (requestId: string, callbacks: GenStreamCallbacks): GenStreamHandle =>
      subscribe(requestId, callbacks),

    status: (sessionId: string) =>
      transport.invoke(GEN_CHANNELS.status, { sessionId }) as Promise<GenStatus | null>,

    cancel: (requestId: string) =>
      transport.invoke(GEN_CHANNELS.cancel, { requestId }) as Promise<void>,

    onArtifactSaved: (listener: (event: GenArtifactSaved) => void): (() => void) =>
      transport.on(GEN_CHANNELS.artifactSaved, (payload) => listener(payload as GenArtifactSaved)),

    onRunStarted: (listener: (run: GenStatus) => void): (() => void) =>
      transport.on(GEN_CHANNELS.runStarted, (payload) => listener(payload as GenStatus)),

    onRunEnded: (listener: (event: GenRunEnded) => void): (() => void) =>
      transport.on(GEN_CHANNELS.runEnded, (payload) => listener(payload as GenRunEnded)),

    // M07.C: UNKEYED progress feed for the app-level run toast ("Section 3 of 7") —
    // single-window, so the invoking webContents' events ARE this window's events.
    onProgress: (
      listener: (event: { requestId: string; progress: GenProgress }) => void,
    ): (() => void) =>
      transport.on(GEN_CHANNELS.progress, (payload) =>
        listener(payload as { requestId: string; progress: GenProgress }),
      ),

    getLatestArtifacts: (sessionId: string) =>
      transport.invoke(GEN_CHANNELS.getLatestArtifacts, { sessionId }) as Promise<GenDocument[]>,

    buildRawDoc: (sessionId: string) =>
      transport.invoke(GEN_CHANNELS.buildRawDoc, { sessionId }) as Promise<string>,
    exportImages: (sessionId: string) =>
      transport.invoke(GEN_CHANNELS.exportImages, { sessionId }) as Promise<ExportImagesResult>,
    exportHtml: (request: ExportRequest) =>
      transport.invoke(GEN_CHANNELS.exportHtml, request) as Promise<ExportResult>,
    exportMarkdown: (request: ExportRequest) =>
      transport.invoke(GEN_CHANNELS.exportMarkdown, request) as Promise<ExportResult>,
    exportPdf: (request: ExportRequest) =>
      transport.invoke(GEN_CHANNELS.exportPdf, request) as Promise<ExportResult>,

    listTemplates: () => transport.invoke(GEN_CHANNELS.listTemplates) as Promise<GenTemplate[]>,
    saveTemplate: (parts: GenTemplateParts) =>
      transport.invoke(GEN_CHANNELS.saveTemplate, parts) as Promise<GenTemplate>,
    getTemplate: (id: string) =>
      transport.invoke(GEN_CHANNELS.getTemplate, { id }) as Promise<GenTemplate | null>,
    deleteTemplate: (id: string) =>
      transport.invoke(GEN_CHANNELS.deleteTemplate, { id }) as Promise<void>,
    getArtifacts: (sessionId: string) =>
      transport.invoke(GEN_CHANNELS.getArtifacts, { sessionId }) as Promise<GenDocument[]>,
  };
}
