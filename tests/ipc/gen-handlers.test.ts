import { describe, expect, it, vi } from 'vitest';

import { GEN_CHANNELS } from '../../electron/ipc/channels';
import { registerGenHandlers, type GenIpcService } from '../../electron/ipc/gen-handlers';
import { LlmServiceError } from '../../electron/llm/errors';
import type {
  GenDocument,
  GenFocusRequest,
  GenMinutesRequest,
  GenTemplate,
  GenTemplateParts,
} from '@shared/types';

/*
 * The generation IPC surface (M04.A; M04.C adds generateMinutes / buildRawDoc /
 * getTemplate / deleteTemplate and a requestId-keyed `phase` event on the streaming
 * generators). `gen:generate*` are streaming invoke triggers; main pushes
 * gen:phase/gen:chunk/gen:done/gen:error keyed by a renderer-generated requestId.
 * The trust boundary validates args main-side; the key never appears in any payload.
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

const TEMPLATE: GenTemplate = {
  id: 'default',
  name: 'Default',
  focusPrompt: 'f',
  whitepaperPrompt: 'w',
  isDefault: true,
};

function fakeService(overrides: Partial<GenIpcService> = {}): GenIpcService {
  return {
    generateFocus: () =>
      Promise.resolve({
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0 },
        kind: 'focus',
      }),
    generateWhitepaper: () =>
      Promise.resolve({
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0 },
        kind: 'whitepaper',
      }),
    generateMinutes: () =>
      Promise.resolve({
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0 },
        kind: 'minutes',
      }),
    buildRawDoc: () => '<html><body>raw</body></html>',
    exportImages: () => ({
      images: [{ dataUri: 'data:image/png;base64,RAW==', alt: 'Screenshot capture' }],
      omittedCount: 0,
    }),
    exportHtml: () => Promise.resolve({ saved: true, path: '/tmp/out.html' }),
    exportMarkdown: () => Promise.resolve({ saved: true, path: '/tmp/out.md' }),
    exportPdf: () => Promise.resolve({ saved: true, path: '/tmp/out.pdf' }),
    listTemplates: () => [TEMPLATE],
    saveTemplate: (parts: GenTemplateParts) => ({ id: 'tmpl-1', isDefault: false, ...parts }),
    updateTemplate: (id: string, parts: GenTemplateParts) => ({ id, isDefault: false, ...parts }),
    getTemplate: () => TEMPLATE,
    deleteTemplate: () => undefined,
    getArtifacts: () => [],
    getLatestArtifacts: () => [],
    ...overrides,
  };
}

const FOCUS = { requestId: 'r1', sessionId: 's1', templateId: 'default', model: 'claude-opus-4-8' };

describe('gen IPC handlers', () => {
  it('registers exactly the seventeen gen handler channels (M07.B status + getLatestArtifacts; M06.C exportPdf; updateTemplate)', () => {
    const registrar = fakeRegistrar();
    registerGenHandlers(registrar, fakeService());
    expect(new Set(registrar.handlers.keys())).toEqual(
      new Set([
        GEN_CHANNELS.generateFocus,
        GEN_CHANNELS.generateWhitepaper,
        GEN_CHANNELS.generateMinutes,
        GEN_CHANNELS.buildRawDoc,
        GEN_CHANNELS.exportImages,
        GEN_CHANNELS.exportHtml,
        GEN_CHANNELS.exportMarkdown,
        GEN_CHANNELS.exportPdf,
        GEN_CHANNELS.listTemplates,
        GEN_CHANNELS.saveTemplate,
        GEN_CHANNELS.updateTemplate,
        GEN_CHANNELS.getTemplate,
        GEN_CHANNELS.deleteTemplate,
        GEN_CHANNELS.getArtifacts,
        GEN_CHANNELS.cancel,
        // M07.B (F12/F16): the truthful-modal main side.
        GEN_CHANNELS.status,
        GEN_CHANNELS.getLatestArtifacts,
      ]),
    );
  });

  it('streams whitepaper chunk/done events keyed by requestId (no key on the wire)', async () => {
    const registrar = fakeRegistrar();
    const done = {
      stopReason: 'end_turn',
      usage: { inputTokens: 3, outputTokens: 4 },
      kind: 'whitepaper' as const,
      artifactId: 'doc-9',
    };
    let seen: GenFocusRequest | undefined;
    registerGenHandlers(
      registrar,
      fakeService({
        generateWhitepaper: (request, handlers) => {
          seen = request;
          handlers.onChunk('<h1>');
          handlers.onChunk('</h1>');
          return Promise.resolve(done);
        },
      }),
    );
    const { event, sent } = fakeEvent();

    await registrar.handlers.get(GEN_CHANNELS.generateWhitepaper)?.(event, FOCUS);

    expect(seen).toEqual({ sessionId: 's1', templateId: 'default', model: 'claude-opus-4-8' });
    expect(sent).toEqual([
      { channel: GEN_CHANNELS.chunk, payload: { requestId: 'r1', delta: '<h1>' } },
      { channel: GEN_CHANNELS.chunk, payload: { requestId: 'r1', delta: '</h1>' } },
      { channel: GEN_CHANNELS.done, payload: { requestId: 'r1', result: done } },
    ]);
    expect(JSON.stringify(sent)).not.toContain('apiKey');
  });

  it('forwards per-step progress on the progress channel, keyed by requestId (M07.C open shape)', async () => {
    const registrar = fakeRegistrar();
    const focusStep = { step: 'focus', index: 1, total: 4, label: 'Analyzing session…' };
    const outlineStep = { step: 'outline', index: 2, total: 4, label: 'Planning sections…' };
    registerGenHandlers(
      registrar,
      fakeService({
        generateWhitepaper: (_request, handlers) => {
          handlers.onProgress?.(focusStep);
          handlers.onProgress?.(outlineStep);
          handlers.onChunk('x');
          return Promise.resolve({
            stopReason: 'end_turn',
            usage: { inputTokens: 0, outputTokens: 0 },
            kind: 'whitepaper' as const,
          });
        },
      }),
    );
    const { event, sent } = fakeEvent();

    await registrar.handlers.get(GEN_CHANNELS.generateWhitepaper)?.(event, FOCUS);

    expect(sent.slice(0, 2)).toEqual([
      { channel: GEN_CHANNELS.progress, payload: { requestId: 'r1', progress: focusStep } },
      { channel: GEN_CHANNELS.progress, payload: { requestId: 'r1', progress: outlineStep } },
    ]);
  });

  it('routes generateMinutes with only { sessionId, model } (no templateId)', async () => {
    const registrar = fakeRegistrar();
    let seen: GenMinutesRequest | undefined;
    registerGenHandlers(
      registrar,
      fakeService({
        generateMinutes: (request, handlers) => {
          seen = request;
          handlers.onChunk('<h1>M</h1>');
          return Promise.resolve({
            stopReason: 'end_turn',
            usage: { inputTokens: 0, outputTokens: 0 },
            kind: 'minutes' as const,
          });
        },
      }),
    );
    const { event, sent } = fakeEvent();

    await registrar.handlers.get(GEN_CHANNELS.generateMinutes)?.(event, {
      requestId: 'r1',
      sessionId: 's1',
      model: 'claude-opus-4-8',
    });

    expect(seen).toEqual({ sessionId: 's1', model: 'claude-opus-4-8' });
    expect(sent).toContainEqual({
      channel: GEN_CHANNELS.done,
      payload: {
        requestId: 'r1',
        result: {
          stopReason: 'end_turn',
          usage: { inputTokens: 0, outputTokens: 0 },
          kind: 'minutes',
        },
      },
    });
  });

  it('emits a single key-free error event when whitepaper generation throws', async () => {
    const registrar = fakeRegistrar();
    registerGenHandlers(
      registrar,
      fakeService({ generateWhitepaper: () => Promise.reject(new LlmServiceError('OFFLINE')) }),
    );
    const { event, sent } = fakeEvent();

    await registrar.handlers.get(GEN_CHANNELS.generateWhitepaper)?.(event, FOCUS);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.channel).toBe(GEN_CHANNELS.error);
    expect(sent[0]?.payload).toMatchObject({ requestId: 'r1', error: { code: 'OFFLINE' } });
  });

  it('validates the generateFocus request shape at the boundary', async () => {
    const registrar = fakeRegistrar();
    registerGenHandlers(registrar, fakeService());
    const handler = registrar.handlers.get(GEN_CHANNELS.generateFocus);
    const { event } = fakeEvent();

    await expect(handler?.(event, 'nope')).rejects.toBeInstanceOf(TypeError);
    await expect(handler?.(event, { ...FOCUS, sessionId: 42 })).rejects.toBeInstanceOf(TypeError);
    await expect(handler?.(event, { ...FOCUS, requestId: undefined })).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it('routes the request/response channels to the service', async () => {
    const registrar = fakeRegistrar();
    const artifacts: GenDocument[] = [
      {
        id: 'd1',
        sessionId: 's1',
        kind: 'focus',
        content: 'c',
        templateId: 'default',
        createdAt: 1,
      },
    ];
    const deleteTemplate = vi.fn();
    registerGenHandlers(registrar, fakeService({ getArtifacts: () => artifacts, deleteTemplate }));
    const { event } = fakeEvent();

    expect(await registrar.handlers.get(GEN_CHANNELS.listTemplates)?.(event)).toEqual([TEMPLATE]);
    expect(
      await registrar.handlers.get(GEN_CHANNELS.saveTemplate)?.(event, {
        name: 'Mine',
        focusPrompt: 'f',
        whitepaperPrompt: 'w',
      }),
    ).toMatchObject({ id: 'tmpl-1', name: 'Mine', isDefault: false });
    expect(
      await registrar.handlers.get(GEN_CHANNELS.getTemplate)?.(event, { id: 'default' }),
    ).toEqual(TEMPLATE);
    expect(
      await registrar.handlers.get(GEN_CHANNELS.buildRawDoc)?.(event, { sessionId: 's1' }),
    ).toBe('<html><body>raw</body></html>');
    await registrar.handlers.get(GEN_CHANNELS.deleteTemplate)?.(event, { id: 'tmpl-1' });
    expect(deleteTemplate).toHaveBeenCalledWith('tmpl-1');
    expect(
      await registrar.handlers.get(GEN_CHANNELS.getArtifacts)?.(event, { sessionId: 's1' }),
    ).toEqual(artifacts);
  });

  it('preserves minutesPrompt through the save/update parse boundary (not just focus/whitepaper)', async () => {
    const registrar = fakeRegistrar();
    let savedParts: GenTemplateParts | undefined;
    let updatedParts: GenTemplateParts | undefined;
    registerGenHandlers(
      registrar,
      fakeService({
        saveTemplate: (parts) => {
          savedParts = parts;
          return { id: 'tmpl-1', isDefault: false, ...parts };
        },
        updateTemplate: (id, parts) => {
          updatedParts = parts;
          return { id, isDefault: false, ...parts };
        },
      }),
    );
    const { event } = fakeEvent();

    const payload = {
      name: 'Mine',
      focusPrompt: 'F',
      whitepaperPrompt: 'W',
      minutesPrompt: 'M-EDITED',
    };
    await registrar.handlers.get(GEN_CHANNELS.saveTemplate)?.(event, payload);
    await registrar.handlers.get(GEN_CHANNELS.updateTemplate)?.(event, {
      id: 'tmpl-1',
      parts: payload,
    });

    // The minutes prompt must survive the IPC parse — the bug was it being dropped.
    expect(savedParts).toMatchObject({
      focusPrompt: 'F',
      whitepaperPrompt: 'W',
      minutesPrompt: 'M-EDITED',
    });
    expect(updatedParts).toMatchObject({ minutesPrompt: 'M-EDITED' });
  });

  it('threads templateId to generateMinutes (so the selected template’s minutes prompt is used)', async () => {
    const registrar = fakeRegistrar();
    let seenMinutes: GenMinutesRequest | undefined;
    registerGenHandlers(
      registrar,
      fakeService({
        generateMinutes: (request) => {
          seenMinutes = request;
          return Promise.resolve({
            stopReason: 'end_turn',
            usage: { inputTokens: 0, outputTokens: 0 },
            kind: 'minutes',
          });
        },
      }),
    );
    const { event } = fakeEvent();

    await registrar.handlers.get(GEN_CHANNELS.generateMinutes)?.(event, {
      requestId: 'r1',
      sessionId: 's1',
      templateId: 'tmpl-9',
      model: 'claude-opus-4-8',
    });

    expect(seenMinutes).toMatchObject({ sessionId: 's1', templateId: 'tmpl-9' });
  });

  it('names the driving template in the run-started broadcast (resolveTemplateName)', async () => {
    const registrar = fakeRegistrar();
    const broadcasts: Array<{ channel: string; payload: unknown }> = [];
    registerGenHandlers(registrar, fakeService(), undefined, {
      broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
      resolveTemplateName: (id) => (id === 'tmpl-9' ? 'My template' : 'Default'),
    });
    const { event } = fakeEvent();

    await registrar.handlers.get(GEN_CHANNELS.generateWhitepaper)?.(event, {
      requestId: 'r1',
      sessionId: 's1',
      templateId: 'tmpl-9',
    });

    const started = broadcasts.find((b) => b.channel === GEN_CHANNELS.runStarted);
    expect(started?.payload).toMatchObject({ kind: 'whitepaper', templateName: 'My template' });
  });
});
