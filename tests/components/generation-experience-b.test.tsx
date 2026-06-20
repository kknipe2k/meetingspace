// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { GenApi, GenStreamCallbacks } from '@shared/api';
import type { GenArtifactSaved, GenDocument, GenStatus } from '@shared/types';

import { GeneratedDocView } from '../../src/components/GeneratedDocView';

/*
 * M07.B (product-owner reversal at IRL) — the truthful modal under the NEW contract.
 * Auto-start is rescinded: opening the modal NEVER invokes generation (the inverted,
 * mutation-proved invariant). Generate per mode is the only trigger; a persisted doc
 * shows on open; an in-flight run reattaches on reopen; an artifact persisted while open
 * refreshes the slot live (scoped by sessionId); the .catch-less fetch surfaces an error.
 * The live-run + Cancel surface is the app-level GenerationStatusToast (separate spec).
 */
const GENERATE = { name: /generate white paper/i } as const;

interface HarnessOpts {
  latest?: GenDocument[];
  status?: GenStatus | null;
  latestRejects?: boolean;
}

interface Harness {
  client: GenApi;
  emitChunk(delta: string): void;
  emitDone(kind?: GenDocument['kind']): void;
  emitArtifactSaved(e: GenArtifactSaved): void;
  setLatest(arts: GenDocument[]): void;
  wpCalls(): number;
  minutesCalls(): number;
  focusCalls(): number;
  attachCalls(): number;
  lastAttachId(): string | null;
}

function harness(opts: HarnessOpts = {}): Harness {
  let latest = opts.latest ?? [];
  const status = opts.status ?? null;
  let current: GenStreamCallbacks | null = null;
  let savedListener: ((e: GenArtifactSaved) => void) | null = null;
  let wpCalls = 0;
  let minutesCalls = 0;
  let focusCalls = 0;
  let attachCalls = 0;
  let lastAttachId: string | null = null;

  const handle = () => ({ detach: () => undefined, cancel: () => undefined });

  const client: GenApi = {
    generateFocus(_req, cbs) {
      current = cbs;
      focusCalls += 1;
      return handle();
    },
    generateWhitepaper(_req, cbs) {
      current = cbs;
      wpCalls += 1;
      return handle();
    },
    generateMinutes(_req, cbs) {
      current = cbs;
      minutesCalls += 1;
      return handle();
    },
    attach(requestId, cbs) {
      current = cbs;
      attachCalls += 1;
      lastAttachId = requestId;
      return handle();
    },
    status: () => Promise.resolve(status),
    onArtifactSaved(listener) {
      savedListener = listener;
      return () => {
        savedListener = null;
      };
    },
    getLatestArtifacts: () =>
      opts.latestRejects ? Promise.reject(new Error('fetch failed')) : Promise.resolve(latest),
    getArtifacts: () => Promise.resolve(latest),
    cancel: () => Promise.resolve(),
    onRunStarted: () => () => undefined,
    onRunEnded: () => () => undefined,
    onProgress: () => () => undefined,
    buildRawDoc: () => Promise.resolve('<html><body><h1>Raw notes</h1></body></html>'),
    exportImages: () => Promise.resolve({ images: [], omittedCount: 0 }),
    exportHtml: () => Promise.resolve({ saved: true, path: '/o.html' }),
    exportMarkdown: () => Promise.resolve({ saved: true, path: '/o.md' }),
    exportPdf: () => Promise.resolve({ saved: true, path: '/o.pdf' }),
    listTemplates: () => Promise.resolve([]),
    saveTemplate: () =>
      Promise.resolve({
        id: 't',
        name: 'n',
        focusPrompt: '',
        whitepaperPrompt: '',
        isDefault: false,
      }),
    updateTemplate: () =>
      Promise.resolve({
        id: 't',
        name: 'n',
        focusPrompt: '',
        whitepaperPrompt: '',
        isDefault: false,
      }),
    getTemplate: () => Promise.resolve(null),
    deleteTemplate: () => Promise.resolve(),
  };

  return {
    client,
    emitChunk: (delta) => act(() => current?.onChunk(delta)),
    emitDone: (kind = 'whitepaper') =>
      act(() =>
        current?.onDone({
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
          kind,
        }),
      ),
    emitArtifactSaved: (e) => act(() => savedListener?.(e)),
    setLatest: (arts) => {
      latest = arts;
    },
    wpCalls: () => wpCalls,
    minutesCalls: () => minutesCalls,
    focusCalls: () => focusCalls,
    attachCalls: () => attachCalls,
    lastAttachId: () => lastAttachId,
  };
}

function view(h: Harness) {
  return render(<GeneratedDocView sessionId="s1" client={h.client} />);
}

function docFrame(): HTMLIFrameElement | null {
  return document.querySelector('iframe[data-testid="generated-doc-frame"]');
}

async function flushInline(): Promise<void> {
  await act(async () => {});
}

const WP_DOC = (body: string): GenDocument => ({
  id: `w-${body}`,
  sessionId: 's1',
  kind: 'whitepaper',
  content: `<html><body><h1>${body}</h1></body></html>`,
  templateId: 'default',
  createdAt: 10,
});

describe('generation experience B — opening the modal never invokes generation (inverted invariant)', () => {
  it('NEVER invokes generation on open when nothing is persisted and nothing is in flight', async () => {
    const h = harness({ latest: [], status: null });
    view(h);

    // Flush the mount reconciliation (getLatestArtifacts + status) so any auto-invoke would
    // have fired — then assert NONE did. The empty state + manual Generate gate are shown.
    await flushInline();
    expect(await screen.findByText(/no document yet/i)).toBeInTheDocument();
    expect(h.wpCalls()).toBe(0);
    expect(h.minutesCalls()).toBe(0);
    expect(h.focusCalls()).toBe(0);
    expect(screen.getByRole('button', GENERATE)).toBeInTheDocument();
  });

  it('only an explicit Generate click starts a run', async () => {
    const h = harness({ latest: [], status: null });
    view(h);
    await screen.findByText(/no document yet/i);
    expect(h.wpCalls()).toBe(0);

    await userEvent.click(screen.getByRole('button', GENERATE));
    expect(h.wpCalls()).toBe(1);
  });

  it('shows a persisted doc on open without invoking generation', async () => {
    const h = harness({ latest: [WP_DOC('Persisted')], status: null });
    view(h);

    await screen.findByRole('button', { name: /regenerate/i });
    expect(h.wpCalls()).toBe(0);
    expect(docFrame()?.getAttribute('srcdoc') ?? '').toContain('Persisted');
  });
});

describe('generation experience B — truthful modal (F12)', () => {
  it('reattaches to a main-side in-flight run on reopen instead of starting a new one', async () => {
    const h = harness({
      latest: [],
      status: {
        requestId: 'live-9',
        sessionId: 's1',
        kind: 'whitepaper',
        progress: { step: 'section', index: 3, total: 5, label: 'Section 1 of 2 — Core' },
        startedAt: 1,
      },
    });
    view(h);

    await waitFor(() => expect(h.attachCalls()).toBe(1));
    expect(h.lastAttachId()).toBe('live-9');
    expect(h.wpCalls()).toBe(0);
    // The streaming UI shows the in-modal Cancel control.
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeInTheDocument();

    // On done the full doc is reloaded from storage (we joined mid-stream).
    h.setLatest([WP_DOC('Reattached doc')]);
    h.emitDone('whitepaper');
    await flushInline();
    await waitFor(() =>
      expect(docFrame()?.getAttribute('srcdoc') ?? '').toContain('Reattached doc'),
    );
  });

  it('refreshes the open modal slot on a gen:artifact-saved push for THIS session', async () => {
    const h = harness({ latest: [WP_DOC('Old')], status: null });
    view(h);
    await screen.findByRole('button', { name: /regenerate/i });
    expect(docFrame()?.getAttribute('srcdoc') ?? '').toContain('Old');

    h.setLatest([WP_DOC('Newer')]);
    h.emitArtifactSaved({ sessionId: 's1', kind: 'whitepaper', id: 'w-Newer' });

    await waitFor(() => expect(docFrame()?.getAttribute('srcdoc') ?? '').toContain('Newer'));
  });

  it('IGNORES a gen:artifact-saved push for a DIFFERENT session (scoped by sessionId)', async () => {
    const h = harness({ latest: [WP_DOC('Mine')], status: null });
    view(h);
    await screen.findByRole('button', { name: /regenerate/i });

    h.setLatest([WP_DOC('Should not appear')]);
    h.emitArtifactSaved({ sessionId: 'other-session', kind: 'whitepaper', id: 'x' });
    await flushInline();

    expect(docFrame()?.getAttribute('srcdoc') ?? '').toContain('Mine');
    expect(docFrame()?.getAttribute('srcdoc') ?? '').not.toContain('Should not appear');
  });

  it('surfaces an error state when the artifact fetch rejects (the .catch-less gap — B.3 #4)', async () => {
    const h = harness({ latestRejects: true, status: null });
    view(h);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});
