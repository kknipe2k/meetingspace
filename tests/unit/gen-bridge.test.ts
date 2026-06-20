import { describe, expect, it } from 'vitest';

import { GEN_CHANNELS } from '../../electron/ipc/channels';
import { createGenApi } from '../../electron/ipc/gen-bridge';
import type { IpcStreamTransport } from '../../electron/ipc/llm-bridge';
import type { GenDone } from '@shared/types';

/*
 * The renderer-facing generation bridge (M04.A). `generateFocus` is event-driven
 * (mirrors the chat bridge): it invokes gen:generateFocus with the request plus a
 * generated requestId and subscribes to chunk/done/error FILTERED by requestId.
 * listTemplates / saveTemplate / getArtifacts are plain invokes. No key crosses.
 */
function fakeTransport(invokeResult: unknown = undefined): {
  transport: IpcStreamTransport;
  invokes: Array<{ channel: string; args: unknown[] }>;
  emit: (channel: string, payload: unknown) => void;
  listenerCount: (channel: string) => number;
} {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const invokes: Array<{ channel: string; args: unknown[] }> = [];
  return {
    invokes,
    emit: (channel, payload) => listeners.get(channel)?.forEach((l) => l(payload)),
    listenerCount: (channel) => listeners.get(channel)?.size ?? 0,
    transport: {
      invoke: (channel, ...args) => {
        invokes.push({ channel, args });
        return Promise.resolve(invokeResult);
      },
      on: (channel, listener) => {
        let set = listeners.get(channel);
        if (!set) {
          set = new Set();
          listeners.set(channel, set);
        }
        set.add(listener);
        return () => set?.delete(listener);
      },
    },
  };
}

const ids = (): (() => string) => {
  let n = 0;
  return () => `req-${(n += 1)}`;
};

const FOCUS = { sessionId: 's1', templateId: 'default', model: 'claude-opus-4-8' };
const DONE: GenDone = {
  stopReason: 'end_turn',
  usage: { inputTokens: 1, outputTokens: 2 },
  kind: 'focus',
};

describe('createGenApi', () => {
  it('exposes the generation surface', () => {
    const { transport } = fakeTransport();
    expect(new Set(Object.keys(createGenApi(transport, ids())))).toEqual(
      new Set([
        'generateFocus',
        'generateWhitepaper',
        'generateMinutes',
        // M07.B (F12): reattach to a live run, query in-flight state, persist broadcast.
        'attach',
        'status',
        'onArtifactSaved',
        'getLatestArtifacts',
        // M07.B (IRL reversal): cancel-by-id + the app-level run-lifecycle subscriptions.
        'cancel',
        'onRunStarted',
        'onRunEnded',
        // M07.C: the unkeyed progress feed for the app-level run toast.
        'onProgress',
        'buildRawDoc',
        'exportImages',
        'exportHtml',
        'exportMarkdown',
        'exportPdf',
        'listTemplates',
        'saveTemplate',
        'updateTemplate',
        'getTemplate',
        'deleteTemplate',
        'getArtifacts',
      ]),
    );
  });

  it('routes requestId-keyed progress events to onProgress (M07.C open shape)', () => {
    const f = fakeTransport();
    const labels: string[] = [];
    createGenApi(f.transport, ids()).generateWhitepaper(FOCUS, {
      onChunk: () => undefined,
      onProgress: (p) => labels.push(p.label),
      onDone: () => undefined,
      onError: () => undefined,
    });

    const step = (label: string) => ({ step: 'section', index: 3, total: 6, label });
    f.emit(GEN_CHANNELS.progress, { requestId: 'other', progress: step('not mine') });
    f.emit(GEN_CHANNELS.progress, { requestId: 'req-1', progress: step('Section 1 of 3 — A') });
    f.emit(GEN_CHANNELS.progress, { requestId: 'req-1', progress: step('Section 2 of 3 — B') });

    expect(labels).toEqual(['Section 1 of 3 — A', 'Section 2 of 3 — B']);
  });

  it('resolves a BUSY start into onBusy with the live GenStatus, detaching the dead listeners (M07.C)', async () => {
    const live = {
      requestId: 'live-9',
      sessionId: 's2',
      kind: 'whitepaper',
      progress: null,
      startedAt: 5,
    };
    const f = fakeTransport({ started: false, reason: 'busy', live });
    let busy: unknown = null;
    createGenApi(f.transport, ids()).generateWhitepaper(FOCUS, {
      onChunk: () => undefined,
      onDone: () => undefined,
      onError: () => undefined,
      onBusy: (l) => (busy = l),
    });
    // Let the invoke resolution land.
    await Promise.resolve();
    await Promise.resolve();

    expect(busy).toEqual(live);
    // No stream is coming for a refused start — the keyed listeners are torn down.
    expect(f.listenerCount(GEN_CHANNELS.chunk)).toBe(0);
  });

  it('invokes gen:generateMinutes and gen:buildRawDoc on their channels', async () => {
    const f = fakeTransport('<html>raw</html>');
    const api = createGenApi(f.transport, ids());

    api.generateMinutes(
      { sessionId: 's1', model: 'claude-opus-4-8' },
      {
        onChunk: () => undefined,
        onDone: () => undefined,
        onError: () => undefined,
      },
    );
    await api.buildRawDoc('s1');

    expect(f.invokes).toEqual([
      {
        channel: GEN_CHANNELS.generateMinutes,
        args: [{ sessionId: 's1', model: 'claude-opus-4-8', requestId: 'req-1' }],
      },
      { channel: GEN_CHANNELS.buildRawDoc, args: [{ sessionId: 's1' }] },
    ]);
  });

  it('invokes the export channels: exportImages (raw), exportHtml, exportMarkdown', async () => {
    const f = fakeTransport({ saved: true, path: '/tmp/out' });
    const api = createGenApi(f.transport, ids());

    await api.exportImages('s1');
    await api.exportHtml({ content: '<html>doc</html>', defaultName: 'Paper' });
    await api.exportMarkdown({ content: '# Paper', defaultName: 'Paper' });

    expect(f.invokes).toEqual([
      { channel: GEN_CHANNELS.exportImages, args: [{ sessionId: 's1' }] },
      {
        channel: GEN_CHANNELS.exportHtml,
        args: [{ content: '<html>doc</html>', defaultName: 'Paper' }],
      },
      {
        channel: GEN_CHANNELS.exportMarkdown,
        args: [{ content: '# Paper', defaultName: 'Paper' }],
      },
    ]);
  });

  it('invokes gen:generateWhitepaper with the request plus a generated requestId (no key)', () => {
    const f = fakeTransport();
    const chunks: string[] = [];
    let result: GenDone | undefined;
    createGenApi(f.transport, ids()).generateWhitepaper(FOCUS, {
      onChunk: (d) => chunks.push(d),
      onDone: (r) => (result = r),
      onError: () => undefined,
    });

    expect(f.invokes).toEqual([
      { channel: GEN_CHANNELS.generateWhitepaper, args: [{ ...FOCUS, requestId: 'req-1' }] },
    ]);
    expect(JSON.stringify(f.invokes)).not.toContain('apiKey');

    // Same requestId-keyed routing + teardown as generateFocus.
    f.emit(GEN_CHANNELS.chunk, { requestId: 'req-1', delta: '<h1>' });
    f.emit(GEN_CHANNELS.done, { requestId: 'req-1', result: { ...DONE, kind: 'whitepaper' } });
    expect(chunks).toEqual(['<h1>']);
    expect(result?.kind).toBe('whitepaper');
    expect(f.listenerCount(GEN_CHANNELS.chunk)).toBe(0);
  });

  it('invokes gen:generateFocus with the request plus a generated requestId (no key)', () => {
    const f = fakeTransport();
    createGenApi(f.transport, ids()).generateFocus(FOCUS, {
      onChunk: () => undefined,
      onDone: () => undefined,
      onError: () => undefined,
    });

    expect(f.invokes).toEqual([
      { channel: GEN_CHANNELS.generateFocus, args: [{ ...FOCUS, requestId: 'req-1' }] },
    ]);
    expect(JSON.stringify(f.invokes)).not.toContain('apiKey');
  });

  it('routes only matching-requestId stream events and tears down on done', () => {
    const f = fakeTransport();
    const chunks: string[] = [];
    let result: GenDone | undefined;
    createGenApi(f.transport, ids()).generateFocus(FOCUS, {
      onChunk: (d) => chunks.push(d),
      onDone: (r) => (result = r),
      onError: () => undefined,
    });

    f.emit(GEN_CHANNELS.chunk, { requestId: 'other', delta: 'X' });
    f.emit(GEN_CHANNELS.chunk, { requestId: 'req-1', delta: 'a' });
    f.emit(GEN_CHANNELS.done, { requestId: 'req-1', result: DONE });
    f.emit(GEN_CHANNELS.chunk, { requestId: 'req-1', delta: 'late' });

    expect(chunks).toEqual(['a']);
    expect(result).toEqual(DONE);
    expect(f.listenerCount(GEN_CHANNELS.chunk)).toBe(0);
  });

  it('plain request/response: listTemplates / saveTemplate / getArtifacts invoke their channels', async () => {
    const f = fakeTransport(['ok']);
    const api = createGenApi(f.transport, ids());

    await api.listTemplates();
    await api.saveTemplate({ name: 'Mine', focusPrompt: 'f', whitepaperPrompt: 'w' });
    await api.getArtifacts('s1');

    expect(f.invokes).toEqual([
      { channel: GEN_CHANNELS.listTemplates, args: [] },
      {
        channel: GEN_CHANNELS.saveTemplate,
        args: [{ name: 'Mine', focusPrompt: 'f', whitepaperPrompt: 'w' }],
      },
      { channel: GEN_CHANNELS.getArtifacts, args: [{ sessionId: 's1' }] },
    ]);
  });
});
