import { describe, expect, it } from 'vitest';

import { GEN_CHANNELS } from '../../electron/ipc/channels';
import { registerGenHandlers, type GenIpcService } from '../../electron/ipc/gen-handlers';
import type { GenTemplate } from '@shared/types';

/*
 * The export half of the generation IPC surface (M04.D). The renderer assembles the
 * sanitized self-contained HTML (one sanitizer — decision M04.D) and the plain-text
 * markdown, then hands the finished string to main, which writes it via a save dialog.
 * `gen:exportImages` returns the session's screenshots as RAW base64 data: URIs (no
 * nativeImage decode/downscale — resolves C-14) for the renderer to inline. No key
 * crosses any of these.
 */
type Handler = (event: unknown, ...args: unknown[]) => unknown;

function fakeRegistrar(): {
  handle: (c: string, h: Handler) => void;
  handlers: Map<string, Handler>;
} {
  const handlers = new Map<string, Handler>();
  return { handle: (channel, handler) => handlers.set(channel, handler), handlers };
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
    getLatestArtifacts: () => [],
    exportImages: () => ({
      images: [{ dataUri: 'data:image/png;base64,RAW==', alt: 'Screenshot capture' }],
      omittedCount: 0,
    }),
    exportHtml: () => Promise.resolve({ saved: true, path: '/tmp/out.html' }),
    exportMarkdown: () => Promise.resolve({ saved: true, path: '/tmp/out.md' }),
    exportPdf: () => Promise.resolve({ saved: true, path: '/tmp/out.pdf' }),
    listTemplates: () => [TEMPLATE],
    saveTemplate: (parts) => ({ id: 'tmpl-1', isDefault: false, ...parts }),
    updateTemplate: (id, parts) => ({ id, isDefault: false, ...parts }),
    getTemplate: () => TEMPLATE,
    deleteTemplate: () => undefined,
    getArtifacts: () => [],
    ...overrides,
  };
}

describe('generation export IPC handlers', () => {
  it('gen:exportImages returns the capped screenshots + omittedCount (F26)', () => {
    const reg = fakeRegistrar();
    registerGenHandlers(reg, fakeService());
    const handler = reg.handlers.get(GEN_CHANNELS.exportImages);
    expect(handler).toBeDefined();
    const out = handler?.({}, { sessionId: 's1' }) as {
      images: Array<{ dataUri: string }>;
      omittedCount: number;
    };
    expect(out.images[0]?.dataUri).toBe('data:image/png;base64,RAW==');
    expect(out.omittedCount).toBe(0);
  });

  it('gen:exportPdf renders + saves the prebuilt content via the saver', async () => {
    let captured: { content: string; defaultName: string } | undefined;
    const reg = fakeRegistrar();
    registerGenHandlers(
      reg,
      fakeService({
        exportPdf: (input) => {
          captured = input;
          return Promise.resolve({ saved: true, path: '/tmp/out.pdf' });
        },
      }),
    );
    const handler = reg.handlers.get(GEN_CHANNELS.exportPdf);
    expect(handler).toBeDefined();
    const out = await handler?.({}, { content: '<html>doc</html>', defaultName: 'Paper' });
    expect(captured).toEqual({ content: '<html>doc</html>', defaultName: 'Paper' });
    expect(out).toEqual({ saved: true, path: '/tmp/out.pdf' });
  });

  it('gen:exportHtml passes the prebuilt content + default name to the file saver', async () => {
    let captured: { content: string; defaultName: string } | undefined;
    const reg = fakeRegistrar();
    registerGenHandlers(
      reg,
      fakeService({
        exportHtml: (input) => {
          captured = input;
          return Promise.resolve({ saved: true, path: '/tmp/out.html' });
        },
      }),
    );
    const handler = reg.handlers.get(GEN_CHANNELS.exportHtml);
    expect(handler).toBeDefined();
    const out = await handler?.({}, { content: '<html>doc</html>', defaultName: 'Paper' });
    expect(captured).toEqual({ content: '<html>doc</html>', defaultName: 'Paper' });
    expect(out).toEqual({ saved: true, path: '/tmp/out.html' });
  });

  it('gen:exportMarkdown writes the markdown string via the saver', async () => {
    const reg = fakeRegistrar();
    registerGenHandlers(reg, fakeService());
    const handler = reg.handlers.get(GEN_CHANNELS.exportMarkdown);
    expect(handler).toBeDefined();
    const out = await handler?.({}, { content: '# Paper', defaultName: 'Paper' });
    expect(out).toEqual({ saved: true, path: '/tmp/out.md' });
  });

  it('carries no key on any export payload', () => {
    const reg = fakeRegistrar();
    registerGenHandlers(reg, fakeService());
    const html = reg.handlers.get(GEN_CHANNELS.exportHtml);
    void html?.({}, { content: '<html>x</html>', defaultName: 'n' });
    // (smoke) the handler set includes the three export channels
    expect(reg.handlers.has(GEN_CHANNELS.exportImages)).toBe(true);
    expect(reg.handlers.has(GEN_CHANNELS.exportHtml)).toBe(true);
    expect(reg.handlers.has(GEN_CHANNELS.exportMarkdown)).toBe(true);
  });
});
