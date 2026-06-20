import { describe, expect, it, vi } from 'vitest';

import { createInFlightRegistry } from '../../electron/gen/in-flight-registry';
import { GEN_CHANNELS } from '../../electron/ipc/channels';
import { registerGenHandlers, type GenIpcService } from '../../electron/ipc/gen-handlers';
import { LlmServiceError } from '../../electron/llm/errors';
import type { GenDocument, GenDone } from '@shared/types';

/*
 * M07.B (REVIEW-V11 F12) — the truthful-modal main side. Generation now DECOUPLES from
 * the modal: closing the modal detaches the renderer but the main-side run keeps
 * streaming. So main must answer two new questions the renderer asks on reopen:
 *   - gen:status(sessionId) -> the in-flight run for that session (reattach source), or null;
 *   - gen:artifact-saved {sessionId, kind, id} -> a BROADCAST when a user-facing artifact
 *     persists, so an open modal refreshes that slot live (scoped by sessionId).
 * The internal `focus` leg is NEVER advertised as in-flight or broadcast (it is an
 * intermediate, not a user-facing document).
 */
type Handler = (event: unknown, ...args: unknown[]) => unknown;

function fakeRegistrar(): {
  handle: (c: string, h: Handler) => void;
  handlers: Map<string, Handler>;
} {
  const handlers = new Map<string, Handler>();
  return { handle: (channel, handler) => handlers.set(channel, handler), handlers };
}

function fakeEvent(): { event: unknown } {
  return { event: { sender: { send: () => undefined } } };
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

const WP_DONE: GenDone = {
  stopReason: 'end_turn',
  usage: { inputTokens: 1, outputTokens: 2 },
  kind: 'whitepaper',
  artifactId: 'doc-77',
};

function baseService(overrides: Partial<GenIpcService> = {}): GenIpcService {
  const ok = (kind: GenDone['kind']): Promise<GenDone> =>
    Promise.resolve({ stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 }, kind });
  return {
    generateFocus: () => ok('focus'),
    generateWhitepaper: () => ok('whitepaper'),
    generateMinutes: () => ok('minutes'),
    buildRawDoc: () => '<html></html>',
    exportImages: () => ({ images: [], omittedCount: 0 }),
    exportHtml: () => Promise.resolve({ saved: true, path: '/x.html' }),
    exportMarkdown: () => Promise.resolve({ saved: true, path: '/x.md' }),
    exportPdf: () => Promise.resolve({ saved: true, path: '/x.pdf' }),
    listTemplates: () => [],
    saveTemplate: (parts) => ({ id: 't', isDefault: false, ...parts }),
    updateTemplate: (id, parts) => ({ id, isDefault: false, ...parts }),
    getTemplate: () => null,
    deleteTemplate: () => undefined,
    getArtifacts: () => [],
    getLatestArtifacts: () => [],
    ...overrides,
  };
}

const WP_INVOKE = { requestId: 'live-1', sessionId: 's1', model: 'claude-opus-4-8' };

describe('createInFlightRegistry', () => {
  it('tracks a run by session, reports its progress, and clears it on finish', () => {
    const reg = createInFlightRegistry(() => 5000);
    expect(reg.forSession('s1')).toBeNull();

    reg.start({ requestId: 'r1', sessionId: 's1', kind: 'whitepaper' });
    expect(reg.forSession('s1')).toEqual({
      requestId: 'r1',
      sessionId: 's1',
      kind: 'whitepaper',
      progress: null,
      startedAt: 5000,
    });

    const step = { step: 'section', index: 3, total: 6, label: 'Section 1 of 3 — Intro' };
    reg.setProgress('r1', step);
    expect(reg.forSession('s1')?.progress).toEqual(step);

    reg.finish('r1');
    expect(reg.forSession('s1')).toBeNull();
  });

  it('scopes status by session — a run for s2 is invisible to s1', () => {
    const reg = createInFlightRegistry(() => 1);
    reg.start({ requestId: 'r2', sessionId: 's2', kind: 'minutes' });
    expect(reg.forSession('s1')).toBeNull();
    expect(reg.forSession('s2')?.kind).toBe('minutes');
  });
});

describe('gen IPC — status + artifact-saved broadcast', () => {
  it('reports a whitepaper run as in-flight for its session while it streams, then clears it', async () => {
    const registrar = fakeRegistrar();
    const d = deferred<GenDone>();
    const inFlight = createInFlightRegistry(() => 9000);
    const writingStep = { step: 'section', index: 3, total: 5, label: 'Section 1 of 2 — Core' };
    registerGenHandlers(
      registrar,
      baseService({
        generateWhitepaper: (_req, handlers) => {
          handlers.onProgress?.(writingStep);
          return d.promise;
        },
      }),
      undefined,
      { inFlight },
    );

    const statusHandler = registrar.handlers.get(GEN_CHANNELS.status);
    const { event } = fakeEvent();

    // Kick the (pending) run off; do not await yet.
    const running = registrar.handlers.get(GEN_CHANNELS.generateWhitepaper)?.(event, WP_INVOKE);

    // Mid-flight: the session reports an in-flight whitepaper run at the current step.
    expect(await statusHandler?.(event, { sessionId: 's1' })).toEqual({
      requestId: 'live-1',
      sessionId: 's1',
      kind: 'whitepaper',
      progress: writingStep,
      startedAt: 9000,
    });

    d.resolve(WP_DONE);
    await running;

    // Settled: no longer in flight.
    expect(await statusHandler?.(event, { sessionId: 's1' })).toBeNull();
  });

  it('does NOT advertise the internal focus leg as an in-flight run', async () => {
    const registrar = fakeRegistrar();
    const d = deferred<GenDone>();
    const inFlight = createInFlightRegistry(() => 1);
    registerGenHandlers(registrar, baseService({ generateFocus: () => d.promise }), undefined, {
      inFlight,
    });
    const { event } = fakeEvent();
    const running = registrar.handlers.get(GEN_CHANNELS.generateFocus)?.(event, {
      requestId: 'f1',
      sessionId: 's1',
    });

    expect(
      await registrar.handlers.get(GEN_CHANNELS.status)?.(event, { sessionId: 's1' }),
    ).toBeNull();
    d.resolve({
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
      kind: 'focus',
    });
    await running;
  });

  it('broadcasts gen:artifact-saved {sessionId, kind, id} when a whitepaper persists', async () => {
    const registrar = fakeRegistrar();
    const broadcast = vi.fn();
    registerGenHandlers(
      registrar,
      baseService({ generateWhitepaper: () => Promise.resolve(WP_DONE) }),
      undefined,
      { inFlight: createInFlightRegistry(() => 1), broadcast },
    );
    const { event } = fakeEvent();

    await registrar.handlers.get(GEN_CHANNELS.generateWhitepaper)?.(event, WP_INVOKE);

    expect(broadcast).toHaveBeenCalledWith(GEN_CHANNELS.artifactSaved, {
      sessionId: 's1',
      kind: 'whitepaper',
      id: 'doc-77',
    });
  });

  it('never broadcasts artifact-saved on the focus leg or on an error (a failed run persists nothing)', async () => {
    const registrar = fakeRegistrar();
    const broadcast = vi.fn();
    registerGenHandlers(
      registrar,
      baseService({
        generateFocus: () =>
          Promise.resolve({
            stopReason: 'end_turn',
            usage: { inputTokens: 0, outputTokens: 0 },
            kind: 'focus',
            artifactId: 'focus-1',
          }),
        generateMinutes: () => Promise.reject(new LlmServiceError('OFFLINE')),
      }),
      undefined,
      { inFlight: createInFlightRegistry(() => 1), broadcast },
    );
    const { event } = fakeEvent();

    await registrar.handlers.get(GEN_CHANNELS.generateFocus)?.(event, {
      requestId: 'f1',
      sessionId: 's1',
    });
    await registrar.handlers.get(GEN_CHANNELS.generateMinutes)?.(event, {
      requestId: 'm1',
      sessionId: 's1',
    });

    // The focus leg advertises nothing; the failed minutes run DOES end (run-ended fires)
    // but persists no artifact — so artifact-saved must never fire, and focus is never a run.
    expect(broadcast).not.toHaveBeenCalledWith(GEN_CHANNELS.artifactSaved, expect.anything());
    expect(broadcast).not.toHaveBeenCalledWith(
      GEN_CHANNELS.runStarted,
      expect.objectContaining({ kind: 'focus' }),
    );
  });

  it('broadcasts gen:run-started on invoke and gen:run-ended on settle (feeds the app-level toast)', async () => {
    const registrar = fakeRegistrar();
    const broadcast = vi.fn();
    const d = deferred<GenDone>();
    registerGenHandlers(
      registrar,
      baseService({ generateWhitepaper: () => d.promise }),
      undefined,
      { inFlight: createInFlightRegistry(() => 9000), broadcast },
    );
    const { event } = fakeEvent();

    const running = registrar.handlers.get(GEN_CHANNELS.generateWhitepaper)?.(event, WP_INVOKE);

    // run-started fires as the run begins — kind + startedAt for the persistent toast.
    expect(broadcast).toHaveBeenCalledWith(GEN_CHANNELS.runStarted, {
      requestId: 'live-1',
      sessionId: 's1',
      kind: 'whitepaper',
      progress: null,
      startedAt: 9000,
    });
    expect(broadcast).not.toHaveBeenCalledWith(GEN_CHANNELS.runEnded, expect.anything());

    d.resolve(WP_DONE);
    await running;

    // run-ended fires on settle so the toast clears.
    expect(broadcast).toHaveBeenCalledWith(GEN_CHANNELS.runEnded, { requestId: 'live-1' });
  });

  it('carries the tier error on gen:run-ended when a run fails (feeds the app-level ceiling toast)', async () => {
    const registrar = fakeRegistrar();
    const broadcast = vi.fn();
    registerGenHandlers(
      registrar,
      baseService({
        generateWhitepaper: () => Promise.reject(new LlmServiceError('TIMEOUT_CEILING')),
      }),
      undefined,
      { inFlight: createInFlightRegistry(() => 1), broadcast },
    );
    const { event } = fakeEvent();

    await registrar.handlers.get(GEN_CHANNELS.generateWhitepaper)?.(event, WP_INVOKE);

    expect(broadcast).toHaveBeenCalledWith(GEN_CHANNELS.runEnded, {
      requestId: 'live-1',
      error: expect.objectContaining({ code: 'TIMEOUT_CEILING' }),
    });
  });

  it('does NOT broadcast run-started/run-ended for the internal focus leg', async () => {
    const registrar = fakeRegistrar();
    const broadcast = vi.fn();
    registerGenHandlers(
      registrar,
      baseService({
        generateFocus: () =>
          Promise.resolve({
            stopReason: 'end_turn',
            usage: { inputTokens: 0, outputTokens: 0 },
            kind: 'focus',
          }),
      }),
      undefined,
      { inFlight: createInFlightRegistry(() => 1), broadcast },
    );
    const { event } = fakeEvent();
    await registrar.handlers.get(GEN_CHANNELS.generateFocus)?.(event, {
      requestId: 'f1',
      sessionId: 's1',
    });

    expect(broadcast).not.toHaveBeenCalledWith(GEN_CHANNELS.runStarted, expect.anything());
    expect(broadcast).not.toHaveBeenCalledWith(GEN_CHANNELS.runEnded, expect.anything());
  });

  it('routes gen:getLatestArtifacts to the service (F16 — latest-per-kind payload)', async () => {
    const registrar = fakeRegistrar();
    const latest: GenDocument[] = [
      {
        id: 'w1',
        sessionId: 's1',
        kind: 'whitepaper',
        content: 'w',
        templateId: 'default',
        createdAt: 9,
      },
      { id: 'm1', sessionId: 's1', kind: 'minutes', content: 'm', templateId: null, createdAt: 8 },
    ];
    const getLatestArtifacts = vi.fn(() => latest);
    registerGenHandlers(registrar, baseService({ getLatestArtifacts }));
    const { event } = fakeEvent();

    expect(
      await registrar.handlers.get(GEN_CHANNELS.getLatestArtifacts)?.(event, { sessionId: 's1' }),
    ).toEqual(latest);
    expect(getLatestArtifacts).toHaveBeenCalledWith('s1');
  });
});
