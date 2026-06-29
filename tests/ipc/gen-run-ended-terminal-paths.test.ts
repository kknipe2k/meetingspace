import { describe, expect, it, vi } from 'vitest';

import { createInFlightRegistry } from '../../electron/gen/in-flight-registry';
import { GEN_CHANNELS } from '../../electron/ipc/channels';
import { registerGenHandlers, type GenIpcService } from '../../electron/ipc/gen-handlers';
import { LlmServiceError } from '../../electron/llm/errors';
import type { GenDone } from '@shared/types';

/*
 * M08.C — the usage counter's SOLE generation-refresh trigger is the app-wide `gen:run-ended`
 * broadcast, so EVERY user-facing terminal path must emit it. WP success + WP failure are already
 * pinned in gen-status-broadcast.test.ts; this locks the four that were not:
 *   - minutes SUCCESS,
 *   - minutes REJECT (M08.B truncation- AND normalize-reject both surface as an LlmServiceError),
 *   - whitepaper CANCEL.
 * The emit is centralised in streamGen's `finally` (gated only on a user-facing kind), so these
 * pass as-is — they are MUTATION-VERIFIED: gate the broadcast on success only (drop the
 * failure/cancel emit) and the reject + cancel cases below fail. The internal focus leg is never a
 * run and must stay silent.
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

function harness(overrides: Partial<GenIpcService>) {
  const registrar = fakeRegistrar();
  const broadcast = vi.fn();
  registerGenHandlers(registrar, baseService(overrides), undefined, {
    inFlight: createInFlightRegistry(() => 1),
    broadcast,
  });
  return { registrar, broadcast, event: fakeEvent().event };
}

describe('gen:run-ended fires on every user-facing terminal path (M08.C)', () => {
  it('minutes SUCCESS → run-ended (so the counter refreshes a completed minutes run)', async () => {
    const { registrar, broadcast, event } = harness({
      generateMinutes: () =>
        Promise.resolve({
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 2 },
          kind: 'minutes',
          artifactId: 'm-1',
        }),
    });

    await registrar.handlers.get(GEN_CHANNELS.generateMinutes)?.(event, {
      requestId: 'm-run',
      sessionId: 's1',
    });

    expect(broadcast).toHaveBeenCalledWith(GEN_CHANNELS.runEnded, { requestId: 'm-run' });
  });

  it('minutes REJECT → run-ended with the typed error (B truncation/normalize reject)', async () => {
    const { registrar, broadcast, event } = harness({
      // M08.B: a truncation- OR normalize-reject throws minutesFailure(...) === LlmServiceError('UNKNOWN').
      generateMinutes: () => Promise.reject(new LlmServiceError('UNKNOWN')),
    });

    await registrar.handlers.get(GEN_CHANNELS.generateMinutes)?.(event, {
      requestId: 'm-bad',
      sessionId: 's1',
    });

    expect(broadcast).toHaveBeenCalledWith(GEN_CHANNELS.runEnded, {
      requestId: 'm-bad',
      error: expect.objectContaining({ code: 'UNKNOWN' }),
    });
  });

  it('whitepaper CANCEL → run-ended with the cancelled error (a cancel still refreshes)', async () => {
    const { registrar, broadcast, event } = harness({
      generateWhitepaper: () => Promise.reject(new LlmServiceError('CANCELLED')),
    });

    await registrar.handlers.get(GEN_CHANNELS.generateWhitepaper)?.(event, {
      requestId: 'wp-cancel',
      sessionId: 's1',
    });

    expect(broadcast).toHaveBeenCalledWith(GEN_CHANNELS.runEnded, {
      requestId: 'wp-cancel',
      error: expect.objectContaining({ code: 'CANCELLED' }),
    });
  });

  it('the internal focus leg NEVER emits run-ended (not a user-facing run)', async () => {
    const { registrar, broadcast, event } = harness({});

    await registrar.handlers.get(GEN_CHANNELS.generateFocus)?.(event, {
      requestId: 'f-1',
      sessionId: 's1',
    });

    expect(broadcast).not.toHaveBeenCalledWith(GEN_CHANNELS.runEnded, expect.anything());
  });
});
