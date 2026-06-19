import { describe, expect, it } from 'vitest';

import { createInFlightRegistry } from '../../electron/gen/in-flight-registry';
import { GEN_CHANNELS } from '../../electron/ipc/channels';
import { registerGenHandlers, type GenIpcService } from '../../electron/ipc/gen-handlers';
import type { GenDone, GenProgress } from '@shared/types';

/*
 * M07.C (REVIEW-V11 F20) — the closed GenPhase union opens into the progress shape
 * {step, index, total, label} so chunked steps ("Section 3 of 7 — Architecture") flow
 * to B's replace-by-key run toast and to the reattach path: the registry records the
 * latest progress on the run's GenStatus, so a reopened modal shows the current step
 * for free (B decision #2). The wire event moves from gen:phase to gen:progress —
 * same requestId keying, richer payload.
 */
type Handler = (event: unknown, ...args: unknown[]) => unknown;

function fakeRegistrar(): {
  handle: (c: string, h: Handler) => void;
  handlers: Map<string, Handler>;
} {
  const handlers = new Map<string, Handler>();
  return { handle: (channel, handler) => handlers.set(channel, handler), handlers };
}

function fakeEvent(): { event: unknown; sent: Array<{ channel: string; payload: unknown }> } {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  return {
    sent,
    event: {
      sender: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) },
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

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
    getTemplate: () => null,
    deleteTemplate: () => undefined,
    getArtifacts: () => [],
    getLatestArtifacts: () => [],
    ...overrides,
  };
}

const SECTION_3_OF_7: GenProgress = {
  step: 'section',
  index: 5,
  total: 10,
  label: 'Section 3 of 7 — Architecture',
};

const WP_INVOKE = { requestId: 'live-1', sessionId: 's1', model: 'claude-opus-4-8' };

describe('InFlightRegistry — open progress shape', () => {
  it('records the latest GenProgress on the run status (the reattach source)', () => {
    const reg = createInFlightRegistry(() => 5000);
    reg.start({ requestId: 'r1', sessionId: 's1', kind: 'whitepaper' });
    expect(reg.forSession('s1')?.progress).toBeNull();

    reg.setProgress('r1', SECTION_3_OF_7);
    expect(reg.forSession('s1')?.progress).toEqual(SECTION_3_OF_7);

    reg.setProgress('r1', { step: 'css', index: 10, total: 10, label: 'Styling document…' });
    expect(reg.forSession('s1')?.progress?.step).toBe('css');
  });
});

describe('gen IPC — gen:progress events carry the open shape, keyed by requestId', () => {
  it('forwards GenProgress objects on the progress channel', async () => {
    const registrar = fakeRegistrar();
    registerGenHandlers(
      registrar,
      baseService({
        generateWhitepaper: (_req, handlers) => {
          handlers.onProgress?.({
            step: 'outline',
            index: 2,
            total: 4,
            label: 'Planning sections…',
          });
          handlers.onProgress?.(SECTION_3_OF_7);
          return Promise.resolve({
            stopReason: 'end_turn',
            usage: { inputTokens: 0, outputTokens: 0 },
            kind: 'whitepaper' as const,
          });
        },
      }),
    );
    const { event, sent } = fakeEvent();

    await registrar.handlers.get(GEN_CHANNELS.generateWhitepaper)?.(event, WP_INVOKE);

    expect(sent.slice(0, 2)).toEqual([
      {
        channel: GEN_CHANNELS.progress,
        payload: {
          requestId: 'live-1',
          progress: { step: 'outline', index: 2, total: 4, label: 'Planning sections…' },
        },
      },
      {
        channel: GEN_CHANNELS.progress,
        payload: { requestId: 'live-1', progress: SECTION_3_OF_7 },
      },
    ]);
  });

  it('a reattaching renderer sees the current step on gen:status (Section 3 of 7 — for free)', async () => {
    const registrar = fakeRegistrar();
    const d = deferred<GenDone>();
    const inFlight = createInFlightRegistry(() => 9000);
    registerGenHandlers(
      registrar,
      baseService({
        generateWhitepaper: (_req, handlers) => {
          handlers.onProgress?.(SECTION_3_OF_7);
          return d.promise;
        },
      }),
      undefined,
      { inFlight },
    );
    const { event } = fakeEvent();

    const running = registrar.handlers.get(GEN_CHANNELS.generateWhitepaper)?.(event, WP_INVOKE);

    expect(await registrar.handlers.get(GEN_CHANNELS.status)?.(event, { sessionId: 's1' })).toEqual(
      {
        requestId: 'live-1',
        sessionId: 's1',
        kind: 'whitepaper',
        progress: SECTION_3_OF_7,
        startedAt: 9000,
      },
    );

    d.resolve({
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
      kind: 'whitepaper',
    });
    await running;
  });
});
