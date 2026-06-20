import type {
  ExportImagesResult,
  ExportRequest,
  ExportResult,
  GenDocument,
  GenDone,
  GenFocusRequest,
  GenKind,
  GenMinutesRequest,
  GenProgress,
  GenStartResult,
  GenTemplate,
  GenTemplateParts,
  GenWhitepaperRequest,
} from '@shared/types';

import { createInFlightRegistry, type InFlightRegistry } from '../gen/in-flight-registry';
import { createCancelRegistry, type CancelRegistry } from '../llm/cancel-registry';
import { LlmServiceError } from '../llm/errors';

import { GEN_CHANNELS } from './channels';
import type { IpcHandleRegistrar } from './note-handlers';

/*
 * The generation IPC surface (M04.A), mirroring the M03 chat handlers.
 * `gen:generateFocus` is the streaming invoke trigger; the main process streams
 * the FOCUS doc back as requestId-keyed events on the caller's own webContents
 * (chunk → done, or a single key-free error). `listTemplates`/`saveTemplate`/
 * `getArtifacts` are plain request/response. The trust boundary is here (spec §5):
 * every field is validated main-side, and no payload ever carries the key — the
 * decrypted key lives only inside the generation service.
 */
interface WebContentsLike {
  send(channel: string, payload: unknown): void;
  isDestroyed?(): boolean;
}

function safeSend(sender: WebContentsLike, channel: string, payload: unknown): void {
  if (sender.isDestroyed?.()) {
    return;
  }
  sender.send(channel, payload);
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`gen ipc: ${field} must be a string`);
  }
  return value;
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError(`gen ipc: ${field} must be a boolean`);
  }
  return value;
}

function asObject(raw: unknown, label: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TypeError(`gen ipc: ${label} must be an object`);
  }
  return raw as Record<string, unknown>;
}

// Carries GenWhitepaperRequest's superset (incl. the optional `reanalyze`) so the one
// parser serves focus/whitepaper/minutes; focus + minutes simply ignore `reanalyze`.
interface FocusInvocation extends GenWhitepaperRequest {
  readonly requestId: string;
}

function parseFocusInvocation(raw: unknown): FocusInvocation {
  const record = asObject(raw, 'request');
  return {
    requestId: asString(record.requestId, 'requestId'),
    sessionId: asString(record.sessionId, 'sessionId'),
    ...(record.templateId !== undefined
      ? { templateId: asString(record.templateId, 'templateId') }
      : {}),
    ...(record.model !== undefined ? { model: asString(record.model, 'model') } : {}),
    ...(record.reanalyze !== undefined
      ? { reanalyze: asBoolean(record.reanalyze, 'reanalyze') }
      : {}),
  };
}

function parseTemplateParts(raw: unknown): GenTemplateParts {
  const record = asObject(raw, 'template');
  return {
    name: asString(record.name, 'name'),
    focusPrompt: asString(record.focusPrompt, 'focusPrompt'),
    whitepaperPrompt: asString(record.whitepaperPrompt, 'whitepaperPrompt'),
  };
}

// The export request is the renderer-assembled document string plus a suggested
// filename; the content is validated as a string but never inspected (it is opaque
// bytes written to the user-chosen path).
function parseExportRequest(raw: unknown): ExportRequest {
  const record = asObject(raw, 'request');
  return {
    content: asString(record.content, 'content'),
    defaultName: asString(record.defaultName, 'defaultName'),
  };
}

// The handler-side streaming surface: chunk deltas plus the per-step progress marker
// (M07.C open shape — was the closed two-phase phase). onProgress is optional so
// non-progress callers stay valid. M07.A adds the optional cancel signal + heartbeat
// sink threaded down to the client.
interface GenStreamServiceHandlers {
  onChunk: (delta: string) => void;
  onProgress?: (progress: GenProgress) => void;
  signal?: AbortSignal;
  onHeartbeat?: (heartbeat: { elapsedMs: number; bytes: number }) => void;
}

// The main-side generation facade the handlers drive — composed in main.ts from
// the generation service + template store + artifact store.
export interface GenIpcService {
  generateFocus(request: GenFocusRequest, handlers: GenStreamServiceHandlers): Promise<GenDone>;
  generateWhitepaper(
    request: GenWhitepaperRequest,
    handlers: GenStreamServiceHandlers,
  ): Promise<GenDone>;
  generateMinutes(request: GenMinutesRequest, handlers: GenStreamServiceHandlers): Promise<GenDone>;
  buildRawDoc(sessionId: string): string;
  exportImages(sessionId: string): ExportImagesResult;
  exportHtml(request: ExportRequest): Promise<ExportResult>;
  exportMarkdown(request: ExportRequest): Promise<ExportResult>;
  exportPdf(request: ExportRequest): Promise<ExportResult>;
  listTemplates(): GenTemplate[];
  saveTemplate(parts: GenTemplateParts): GenTemplate;
  getTemplate(id: string): GenTemplate | null;
  deleteTemplate(id: string): void;
  getArtifacts(sessionId: string): GenDocument[];
  // M07.B (F16): latest-per-kind for the modal's mount fetch (whitepaper + minutes only).
  getLatestArtifacts(sessionId: string): GenDocument[];
}

// M07.B (F12): the truthful-modal main side, injected so it is Node-unit-testable. The
// in-flight registry answers gen:status (reattach source); `broadcast` fans gen:artifact-
// saved to every window so an open modal refreshes its slot live. Defaulted (fresh
// registry + no-op broadcast) for callers/tests that don't wire them.
export interface GenHandlerDeps {
  inFlight?: InFlightRegistry;
  broadcast?: (channel: string, payload: unknown) => void;
}

// All streaming generators share the same wire shape: validate the invocation,
// forward requestId-keyed progress + chunk events, terminate with done or a single
// key-free error. The only difference is which service method runs (the run adapts
// the parsed {sessionId, templateId?, model?} to its own request shape).
//
// M07.B: a USER-FACING `kind` (whitepaper | minutes) opts the run into advertisement
// (gen:status reattach, run-started/ended broadcasts, artifact-saved). The internal
// `focus` leg passes `undefined` — never advertised or broadcast.
//
// M07.C (product-owner scope amendment): ONLY ONE ARTIFACT BUILD AT A TIME, app-wide.
// The InFlightRegistry is the authority and EVERY streaming invoke checks + occupies
// it (the focus leg too — two builds must not overlap through start-over). A refused
// start resolves the TYPED { started:false, reason:'busy', live } carrying the live
// run's GenStatus — never a silent no-op. (Typed RESOLVE, not rejection: Electron
// serializes invoke rejections to the message string, dropping the GenStatus.) A
// chunked run is ONE requestId here, so it holds the slot across all its section
// calls; the `finally` releases it on every settle path — done, error, and cancel
// (mid-call OR between sections).
function streamGen(
  registrar: IpcHandleRegistrar,
  channel: string,
  cancels: CancelRegistry,
  inFlight: InFlightRegistry,
  broadcast: (channel: string, payload: unknown) => void,
  userKind: GenKind | undefined,
  run: (request: GenWhitepaperRequest, handlers: GenStreamServiceHandlers) => Promise<GenDone>,
): void {
  registrar.handle(channel, async (event, raw): Promise<GenStartResult> => {
    const { requestId, sessionId, templateId, model, reanalyze } = parseFocusInvocation(raw);
    const sender = (event as { sender: WebContentsLike }).sender;
    // Typed as the whitepaper request (the superset) so `reanalyze` rides through to
    // service.generateWhitepaper; focus/minutes ignore it.
    const request: GenWhitepaperRequest = {
      sessionId,
      ...(templateId !== undefined ? { templateId } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(reanalyze !== undefined ? { reanalyze } : {}),
    };

    // The single-slot guard — BEFORE any registration or side effect.
    const live = inFlight.anyLive();
    if (live !== null) {
      return { started: false, reason: 'busy', live };
    }

    // Per-invocation cancel (F11): register the run's abort under its requestId; gen:cancel
    // fires it main-side, and a cancelled run also persists no artifact (service guard).
    const controller = new AbortController();
    cancels.register(requestId, () => controller.abort());
    // EVERY run occupies the slot; only user-facing runs are advertised (the reattach
    // surface + the app-level persistent run toast via `gen:run-started`).
    const status = inFlight.start({
      requestId,
      sessionId,
      kind: userKind ?? 'focus',
      userFacing: userKind !== undefined,
    });
    if (userKind !== undefined) {
      broadcast(GEN_CHANNELS.runStarted, status);
    }

    // Captured so the `finally` can carry a failure reason on `gen:run-ended` (lets the app-
    // level controller explain a ceiling stop even with the modal closed).
    let endError: ReturnType<LlmServiceError['toPayload']> | undefined;
    try {
      const result = await run(request, {
        onChunk: (delta) => safeSend(sender, GEN_CHANNELS.chunk, { requestId, delta }),
        onProgress: (progress) => {
          inFlight.setProgress(requestId, progress);
          safeSend(sender, GEN_CHANNELS.progress, { requestId, progress });
        },
        signal: controller.signal,
        onHeartbeat: ({ elapsedMs, bytes }) =>
          safeSend(sender, GEN_CHANNELS.heartbeat, { requestId, elapsedMs, bytes }),
      });
      safeSend(sender, GEN_CHANNELS.done, { requestId, result });
      // A user-facing artifact persisted → tell every window so an open modal refreshes
      // that slot live (scoped by sessionId in the renderer subscription).
      if (userKind !== undefined && result.artifactId !== undefined) {
        broadcast(GEN_CHANNELS.artifactSaved, {
          sessionId,
          kind: result.kind,
          id: result.artifactId,
        });
      }
    } catch (error) {
      const payload = (
        error instanceof LlmServiceError ? error : new LlmServiceError('UNKNOWN')
      ).toPayload();
      endError = payload;
      safeSend(sender, GEN_CHANNELS.error, { requestId, error: payload });
    } finally {
      cancels.unregister(requestId);
      // Slot release — every settle path runs through here.
      inFlight.finish(requestId);
      if (userKind !== undefined) {
        broadcast(GEN_CHANNELS.runEnded, {
          requestId,
          ...(endError ? { error: endError } : {}),
        });
      }
    }
    return { started: true };
  });
}

export function registerGenHandlers(
  registrar: IpcHandleRegistrar,
  service: GenIpcService,
  // Each registration owns one registry (the streaming + cancel handlers share it); main.ts
  // passes a dedicated instance per domain. Defaulted for callers that don't wire cancel
  // explicitly — a fresh per-call instance is equivalent.
  cancels: CancelRegistry = createCancelRegistry(),
  deps: GenHandlerDeps = {},
): void {
  const inFlight = deps.inFlight ?? createInFlightRegistry();
  const broadcast = deps.broadcast ?? ((): void => undefined);

  // The internal focus leg (startOver's first step) is NOT a user-facing run — no in-flight
  // advertisement, no artifact-saved broadcast.
  streamGen(
    registrar,
    GEN_CHANNELS.generateFocus,
    cancels,
    inFlight,
    broadcast,
    undefined,
    (request, handlers) => service.generateFocus(request, handlers),
  );
  streamGen(
    registrar,
    GEN_CHANNELS.generateWhitepaper,
    cancels,
    inFlight,
    broadcast,
    'whitepaper',
    (request, handlers) => service.generateWhitepaper(request, handlers),
  );
  // Minutes carries no templateId (it uses the fixed MINUTES_PROMPT) — drop it.
  streamGen(
    registrar,
    GEN_CHANNELS.generateMinutes,
    cancels,
    inFlight,
    broadcast,
    'minutes',
    (request, handlers) =>
      service.generateMinutes(
        {
          sessionId: request.sessionId,
          ...(request.model !== undefined ? { model: request.model } : {}),
        },
        handlers,
      ),
  );

  // gen:cancel — abort the in-flight generation for { requestId } (idempotent; unknown → false).
  // async so a boundary-validation throw surfaces as a rejected invoke (matching ipcMain.handle).
  registrar.handle(GEN_CHANNELS.cancel, async (_event, raw) => {
    const requestId = asString((raw as { requestId?: unknown })?.requestId, 'requestId');
    return cancels.cancel(requestId);
  });

  // gen:status — the in-flight run for a session (reattach source on modal reopen), or null.
  registrar.handle(GEN_CHANNELS.status, (_event, raw) =>
    inFlight.forSession(asString(asObject(raw, 'request').sessionId, 'sessionId')),
  );

  // gen:getLatestArtifacts (F16) — latest-per-kind for the modal's mount fetch.
  registrar.handle(GEN_CHANNELS.getLatestArtifacts, (_event, raw) =>
    service.getLatestArtifacts(asString(asObject(raw, 'request').sessionId, 'sessionId')),
  );

  registrar.handle(GEN_CHANNELS.buildRawDoc, (_event, raw) =>
    service.buildRawDoc(asString(asObject(raw, 'request').sessionId, 'sessionId')),
  );

  registrar.handle(GEN_CHANNELS.exportImages, (_event, raw) =>
    service.exportImages(asString(asObject(raw, 'request').sessionId, 'sessionId')),
  );

  registrar.handle(GEN_CHANNELS.exportHtml, (_event, raw) =>
    service.exportHtml(parseExportRequest(raw)),
  );

  registrar.handle(GEN_CHANNELS.exportMarkdown, (_event, raw) =>
    service.exportMarkdown(parseExportRequest(raw)),
  );

  registrar.handle(GEN_CHANNELS.exportPdf, (_event, raw) =>
    service.exportPdf(parseExportRequest(raw)),
  );

  registrar.handle(GEN_CHANNELS.listTemplates, () => service.listTemplates());

  registrar.handle(GEN_CHANNELS.saveTemplate, (_event, raw) =>
    service.saveTemplate(parseTemplateParts(raw)),
  );

  registrar.handle(GEN_CHANNELS.getTemplate, (_event, raw) =>
    service.getTemplate(asString(asObject(raw, 'request').id, 'id')),
  );

  registrar.handle(GEN_CHANNELS.deleteTemplate, (_event, raw) =>
    service.deleteTemplate(asString(asObject(raw, 'request').id, 'id')),
  );

  registrar.handle(GEN_CHANNELS.getArtifacts, (_event, raw) =>
    service.getArtifacts(asString(asObject(raw, 'request').sessionId, 'sessionId')),
  );
}
