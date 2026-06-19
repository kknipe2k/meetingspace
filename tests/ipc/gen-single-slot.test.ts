import { describe, expect, it, vi } from 'vitest';

import { createInFlightRegistry } from '../../electron/gen/in-flight-registry';
import { GEN_CHANNELS } from '../../electron/ipc/channels';
import { registerGenHandlers, type GenIpcService } from '../../electron/ipc/gen-handlers';
import { LlmServiceError } from '../../electron/llm/errors';
import type { GenDone } from '@shared/types';

/*
 * M07.C (product-owner scope amendment) — ONLY ONE ARTIFACT BUILD AT A TIME, app-wide,
 * no queueing. Enforced MAIN-SIDE (a renderer-only check races): the InFlightRegistry
 * is the authority. A Generate invoke while ANY gen run is live resolves with a TYPED
 * busy result carrying the live run's GenStatus — never a silent no-op. (A typed
 * RESOLVE, not a rejection: Electron serializes invoke rejections down to the message
 * string, which would drop the GenStatus — logged advisory deviation.)
 *
 * The slot covers EVERY streaming gen invoke (the renderer-invocable focus leg too —
 * otherwise two builds could overlap through it), while advertisement (gen:status /
 * run-started) stays user-facing-only. A chunked run is ONE requestId at this layer,
 * so it holds the slot across all its section calls; the existing settle path releases
 * it on done / error / cancel — including cancel-between-sections.
 *
 * MUTATION CHECK (run at verify_gates): remove the main-side guard → the
 * second-start-rejected tests below fail.
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

const ok = (kind: GenDone['kind']): Promise<GenDone> =>
  Promise.resolve({ stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 }, kind });

function baseService(overrides: Partial<GenIpcService> = {}): GenIpcService {
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
    getTemplate: () => null,
    deleteTemplate: () => undefined,
    getArtifacts: () => [],
    getLatestArtifacts: () => [],
    ...overrides,
  };
}

const WP_A = { requestId: 'run-a', sessionId: 's1', model: 'claude-opus-4-8' };
const MIN_B = { requestId: 'run-b', sessionId: 's2', model: 'claude-opus-4-8' };

describe('InFlightRegistry — the single-slot authority', () => {
  it('anyLive() reports a live run app-wide (not session-scoped)', () => {
    const reg = createInFlightRegistry(() => 7000);
    expect(reg.anyLive()).toBeNull();

    reg.start({ requestId: 'r1', sessionId: 's1', kind: 'whitepaper' });
    expect(reg.anyLive()).toMatchObject({ requestId: 'r1', sessionId: 's1', kind: 'whitepaper' });

    reg.finish('r1');
    expect(reg.anyLive()).toBeNull();
  });

  it('a non-user-facing (focus) run occupies the slot but is NOT advertised per-session', () => {
    const reg = createInFlightRegistry(() => 1);
    reg.start({ requestId: 'f1', sessionId: 's1', kind: 'focus', userFacing: false });

    // Advertisement (the reattach/status surface) stays user-facing-only…
    expect(reg.forSession('s1')).toBeNull();
    // …but the slot is held: a focus leg is still token spend in flight.
    expect(reg.anyLive()).toMatchObject({ requestId: 'f1', kind: 'focus' });

    reg.finish('f1');
    expect(reg.anyLive()).toBeNull();
  });
});

describe('gen IPC — second start while a run is live is REJECTED with the live GenStatus', () => {
  it('resolves {started:false, reason:"busy", live} and never calls the service (mutation: guard removed → fails)', async () => {
    const registrar = fakeRegistrar();
    const d = deferred<GenDone>();
    const generateMinutes = vi.fn(() => ok('minutes'));
    const inFlight = createInFlightRegistry(() => 9000);
    registerGenHandlers(
      registrar,
      baseService({ generateWhitepaper: () => d.promise, generateMinutes }),
      undefined,
      { inFlight },
    );
    const { event } = fakeEvent();

    const first = registrar.handlers.get(GEN_CHANNELS.generateWhitepaper)?.(event, WP_A);

    // A second build — different session, different kind — must be refused, typed,
    // carrying the LIVE run's status so the renderer can explain what is running.
    const busy = await registrar.handlers.get(GEN_CHANNELS.generateMinutes)?.(event, MIN_B);
    expect(busy).toEqual({
      started: false,
      reason: 'busy',
      live: {
        requestId: 'run-a',
        sessionId: 's1',
        kind: 'whitepaper',
        progress: null,
        startedAt: 9000,
      },
    });
    expect(generateMinutes).not.toHaveBeenCalled();

    d.resolve({
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
      kind: 'whitepaper',
    });
    expect(await first).toEqual({ started: true });
  });

  it('the renderer-invocable focus leg also occupies the slot (no overlap through start-over)', async () => {
    const registrar = fakeRegistrar();
    const d = deferred<GenDone>();
    const generateWhitepaper = vi.fn(() => ok('whitepaper'));
    registerGenHandlers(
      registrar,
      baseService({ generateFocus: () => d.promise, generateWhitepaper }),
      undefined,
      { inFlight: createInFlightRegistry(() => 1) },
    );
    const { event } = fakeEvent();

    const running = registrar.handlers.get(GEN_CHANNELS.generateFocus)?.(event, {
      requestId: 'f1',
      sessionId: 's1',
    });

    const busy = (await registrar.handlers.get(GEN_CHANNELS.generateWhitepaper)?.(event, WP_A)) as {
      started: boolean;
    };
    expect(busy.started).toBe(false);
    expect(generateWhitepaper).not.toHaveBeenCalled();

    d.resolve({
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
      kind: 'focus',
    });
    await running;
  });
});

describe('gen IPC — the slot releases on EVERY settle path', () => {
  it('after a normal done, the next start succeeds', async () => {
    const registrar = fakeRegistrar();
    registerGenHandlers(registrar, baseService(), undefined, {
      inFlight: createInFlightRegistry(() => 1),
    });
    const { event } = fakeEvent();

    expect(await registrar.handlers.get(GEN_CHANNELS.generateWhitepaper)?.(event, WP_A)).toEqual({
      started: true,
    });
    expect(await registrar.handlers.get(GEN_CHANNELS.generateMinutes)?.(event, MIN_B)).toEqual({
      started: true,
    });
  });

  it('after an error settle, the next start succeeds', async () => {
    const registrar = fakeRegistrar();
    registerGenHandlers(
      registrar,
      baseService({
        generateWhitepaper: () => Promise.reject(new LlmServiceError('TIMEOUT_CEILING')),
      }),
      undefined,
      { inFlight: createInFlightRegistry(() => 1) },
    );
    const { event } = fakeEvent();

    await registrar.handlers.get(GEN_CHANNELS.generateWhitepaper)?.(event, WP_A);
    expect(await registrar.handlers.get(GEN_CHANNELS.generateMinutes)?.(event, MIN_B)).toEqual({
      started: true,
    });
  });

  it('after a CANCEL settle (incl. cancel-between-sections), the next start succeeds', async () => {
    const registrar = fakeRegistrar();
    // Mirrors the real service: the run rejects CANCELLED when its signal aborts —
    // for a chunked run that is the same path whether the abort lands mid-call or
    // between sections (one requestId holds the slot across the whole loop).
    registerGenHandlers(
      registrar,
      baseService({
        generateWhitepaper: (_req, handlers) =>
          new Promise((_resolve, reject) => {
            handlers.signal?.addEventListener('abort', () =>
              reject(new LlmServiceError('CANCELLED')),
            );
          }),
      }),
      undefined,
      { inFlight: createInFlightRegistry(() => 1) },
    );
    const { event } = fakeEvent();

    const running = registrar.handlers.get(GEN_CHANNELS.generateWhitepaper)?.(event, WP_A);
    await registrar.handlers.get(GEN_CHANNELS.cancel)?.(event, { requestId: 'run-a' });
    await running;

    expect(await registrar.handlers.get(GEN_CHANNELS.generateMinutes)?.(event, MIN_B)).toEqual({
      started: true,
    });
  });
});
