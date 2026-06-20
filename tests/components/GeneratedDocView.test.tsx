// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { GenApi, GenStreamCallbacks } from '@shared/api';
import type {
  GenArtifactSaved,
  GenDocument,
  GenDone,
  GenFocusRequest,
  GenMinutesRequest,
  GenProgress,
  GenTemplate,
  GenWhitepaperRequest,
  LlmErrorPayload,
} from '@shared/types';

import { GeneratedDocView } from '../../src/components/GeneratedDocView';

/*
 * The generated-document surface (M04.B render; M04.C experience + fix batch). The
 * load-bearing M04.B control is REUSED UNCHANGED: the COMMITTED document is sanitized
 * (DOMPurify) and rendered inside SandboxedHtmlFrame. Fix-batch behaviors pinned here:
 *  - partial streamed HTML is NEVER rendered (the frame shows the committed doc only,
 *    revealed on done); progress surfaces as milestone toasts;
 *  - controls disable while streaming, with a clean Cancel;
 *  - minutes embed the screenshots INLINE (base64 data: <img>) — no adjacent gallery,
 *    no premature React lightbox;
 *  - whitepaper offers a write-only Regenerate + a re-analyze Start over once a doc
 *    exists; there are no Save/Export affordances (Stage D).
 */
const GENERATE = { name: /generate white paper/i } as const;

interface Harness {
  client: GenApi;
  emitChunk(delta: string): void;
  emitProgress(step: string): void;
  emitDone(done?: Partial<GenDone>): void;
  emitError(code?: LlmErrorPayload['code']): void;
  lastWpRequest(): GenWhitepaperRequest | null;
  lastMinutesRequest(): GenMinutesRequest | null;
  wpCalls(): number;
  minutesCalls(): number;
  rawCalls(): number;
  focusCalls(): number;
  cancels(): number;
  exportImagesCalls(): number;
  lastExportHtml(): { content: string; defaultName: string } | null;
  lastExportMarkdown(): { content: string; defaultName: string } | null;
  lastExportPdf(): { content: string; defaultName: string } | null;
  /** Swap what getLatestArtifacts returns (simulate a run persisting a new doc). */
  setArtifacts(next: GenDocument[]): void;
  /** Fire the session-scoped gen:artifact-saved broadcast (drives reloadSlot). */
  emitArtifactSaved(event: GenArtifactSaved): void;
}

function harness(
  opts: { artifacts?: GenDocument[]; omittedCount?: number; templates?: GenTemplate[] } = {},
): Harness {
  let artifacts = opts.artifacts ?? [];
  const omittedCount = opts.omittedCount ?? 0;
  const templates = opts.templates ?? [];
  let savedListener: ((event: GenArtifactSaved) => void) | null = null;
  let current: GenStreamCallbacks | null = null;
  let wpReq: GenWhitepaperRequest | null = null;
  let minutesReq: GenMinutesRequest | null = null;
  let wpCalls = 0;
  let minutesCalls = 0;
  let rawCalls = 0;
  let focusCalls = 0;
  let cancels = 0;
  let exportImagesCalls = 0;
  let lastExportHtml: { content: string; defaultName: string } | null = null;
  let lastExportMarkdown: { content: string; defaultName: string } | null = null;
  let lastExportPdf: { content: string; defaultName: string } | null = null;
  // M07.B: streaming methods return a {detach, cancel} handle (the decouple). cancel()
  // counts toward `cancels`; detach (modal-close) is a no-op here.
  const handle = () => ({
    detach: () => undefined,
    cancel: () => {
      cancels += 1;
    },
  });
  const client: GenApi = {
    generateFocus(_req: GenFocusRequest, cbs: GenStreamCallbacks) {
      current = cbs;
      focusCalls += 1;
      return handle();
    },
    generateWhitepaper(req, cbs) {
      wpReq = req;
      current = cbs;
      wpCalls += 1;
      return handle();
    },
    generateMinutes(req: GenMinutesRequest, cbs) {
      minutesReq = req;
      current = cbs;
      minutesCalls += 1;
      return handle();
    },
    // M07.B reattach/truthful-modal surface — these tests run the manual flow (autoStart
    // false, no in-flight run), so status is null and the broadcast is unused.
    attach(_requestId: string, cbs: GenStreamCallbacks) {
      current = cbs;
      return handle();
    },
    status: () => Promise.resolve(null),
    cancel: () => Promise.resolve(),
    onArtifactSaved: (listener) => {
      savedListener = listener;
      return () => {
        savedListener = null;
      };
    },
    onRunStarted: () => () => undefined,
    onRunEnded: () => () => undefined,
    onProgress: () => () => undefined,
    getLatestArtifacts: () => Promise.resolve(artifacts),
    buildRawDoc() {
      rawCalls += 1;
      return Promise.resolve('<html><body><h1>Raw notes</h1></body></html>');
    },
    exportImages() {
      exportImagesCalls += 1;
      return Promise.resolve({
        images: [{ dataUri: 'data:image/png;base64,RAW==', alt: 'Screenshot capture' }],
        omittedCount,
      });
    },
    exportHtml(req) {
      lastExportHtml = req;
      return Promise.resolve({ saved: true, path: '/tmp/out.html' });
    },
    exportMarkdown(req) {
      lastExportMarkdown = req;
      return Promise.resolve({ saved: true, path: '/tmp/out.md' });
    },
    exportPdf(req) {
      lastExportPdf = req;
      return Promise.resolve({ saved: true, path: '/tmp/out.pdf' });
    },
    listTemplates: () => Promise.resolve(templates),
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
    getArtifacts: () => Promise.resolve(artifacts),
  };
  return {
    client,
    emitChunk: (delta) => act(() => current?.onChunk(delta)),
    // M07.C open shape — the step name is enough for these tests' streaming checks.
    emitProgress: (step) =>
      act(() => {
        const progress: GenProgress = { step, index: 1, total: 4, label: `${step}…` };
        current?.onProgress?.(progress);
      }),
    emitDone: (done) =>
      act(() =>
        current?.onDone({
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
          kind: 'whitepaper',
          ...done,
        }),
      ),
    emitError: (code = 'RATE_LIMIT') =>
      act(() =>
        current?.onError({
          code,
          message: code === 'RATE_LIMIT' ? 'Rate limited.' : `Error: ${code}.`,
        }),
      ),
    lastWpRequest: () => wpReq,
    lastMinutesRequest: () => minutesReq,
    wpCalls: () => wpCalls,
    minutesCalls: () => minutesCalls,
    rawCalls: () => rawCalls,
    focusCalls: () => focusCalls,
    cancels: () => cancels,
    exportImagesCalls: () => exportImagesCalls,
    lastExportHtml: () => lastExportHtml,
    lastExportMarkdown: () => lastExportMarkdown,
    lastExportPdf: () => lastExportPdf,
    setArtifacts: (next) => {
      artifacts = next;
    },
    emitArtifactSaved: (event) => act(() => savedListener?.(event)),
  };
}

// M07.B: generation is manual and this component owns no toasts (the run toast is the
// app-level GenerationStatusToast), so a plain render suffices.
function view(h: Harness) {
  return render(<GeneratedDocView sessionId="s1" client={h.client} />);
}

function docFrame(): HTMLIFrameElement | null {
  return document.querySelector('iframe[data-testid="generated-doc-frame"]');
}

// Flush pending microtask state updates (mount artifact reload, export effects) so
// they land inside act() before assertions.
async function flushInline(): Promise<void> {
  await act(async () => {});
}

describe('GeneratedDocView', () => {
  it('streams a white paper for the session when Generate is clicked', async () => {
    const h = harness();
    view(h);

    await userEvent.click(screen.getByRole('button', GENERATE));

    expect(h.wpCalls()).toBe(1);
    expect(h.lastWpRequest()).toMatchObject({ sessionId: 's1' });
  });

  it('shows a template chip next to the model badge naming the template that produced the doc', async () => {
    const h = harness({
      artifacts: [
        {
          id: 'd1',
          sessionId: 's1',
          kind: 'whitepaper',
          content: '<h1>Doc</h1>',
          templateId: 'tmpl-1',
          model: 'claude-opus-4-8',
          createdAt: 1,
        },
      ],
      templates: [
        {
          id: 'tmpl-1',
          name: 'My template',
          focusPrompt: '',
          whitepaperPrompt: '',
          isDefault: false,
        },
      ],
    });
    view(h);

    expect(await screen.findByTestId('template-badge')).toHaveTextContent('My template');
    expect(screen.getByTestId('model-badge')).toHaveTextContent('Claude Opus 4.8');
  });

  it('passes the active templateId on a minutes run (minutes is template-driven now)', async () => {
    const h = harness();
    view(h);

    await userEvent.click(screen.getByRole('button', { name: 'Minutes' }));
    await userEvent.click(screen.getByRole('button', { name: 'Generate minutes' }));

    expect(h.minutesCalls()).toBe(1);
    expect(h.lastMinutesRequest()).toMatchObject({ sessionId: 's1', templateId: 'default' });
  });

  it('offers the Edit prompt affordance in minutes mode, opening the editor with a minutes prompt field', async () => {
    const h = harness();
    view(h);

    await userEvent.click(screen.getByRole('button', { name: 'Minutes' }));
    await userEvent.click(screen.getByRole('button', { name: /edit prompt/i }));

    expect(await screen.findByLabelText(/minutes prompt/i)).toBeInTheDocument();
  });

  it('offers Retry on a transient TIMEOUT_CEILING and re-runs the SAME mode (M04.C cycle 2)', async () => {
    const h = harness();
    view(h);

    await userEvent.click(screen.getByRole('button', GENERATE));
    expect(h.wpCalls()).toBe(1);

    // The stream times out mid-generation — surface the typed error + a Retry affordance.
    h.emitError('TIMEOUT_CEILING');
    const retry = await screen.findByRole('button', { name: /retry/i });

    // Retry re-runs generation for the same (whitepaper) mode — a fresh attempt.
    await userEvent.click(retry);
    expect(h.wpCalls()).toBe(2);
  });

  it('does NOT offer Retry on an AUTH error (a key problem is not retryable)', async () => {
    const h = harness();
    view(h);

    await userEvent.click(screen.getByRole('button', GENERATE));
    h.emitError('AUTH');

    expect(await screen.findByRole('alert')).toHaveTextContent(/AUTH/);
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it('Retry re-runs the SAME action — after a failed Start over it re-analyzes, not just writes', async () => {
    const h = harness();
    view(h);

    // Commit a non-empty doc so "Start over" (re-analyze) is offered.
    await userEvent.click(screen.getByRole('button', GENERATE));
    h.emitChunk('<html><body><h1>Doc</h1></body></html>');
    h.emitDone();
    await flushInline();

    await userEvent.click(screen.getByRole('button', { name: /start over/i }));
    expect(h.wpCalls()).toBe(2); // one whitepaper run, re-analyzing
    expect(h.focusCalls()).toBe(0); // no separate focus leg
    expect(h.lastWpRequest()?.reanalyze).toBe(true);

    // The re-analysis times out — Retry must re-run START OVER (reanalyze again), not a plain write.
    h.emitError('TIMEOUT_CEILING');
    await userEvent.click(await screen.findByRole('button', { name: /retry/i }));
    expect(h.wpCalls()).toBe(3);
    expect(h.lastWpRequest()?.reanalyze).toBe(true);
  });

  it('does NOT render partial HTML while streaming; reveals the doc only on done', async () => {
    const h = harness();
    view(h);
    await userEvent.click(screen.getByRole('button', GENERATE));

    h.emitChunk('<html><body><h1>Partial</h1>');
    // Mid-stream: the frame must not exist (no partial render → no flicker).
    expect(docFrame()).toBeNull();

    h.emitChunk('<p>more</p></body></html>');
    h.emitDone();
    await flushInline();

    // On done the committed doc is revealed.
    const frame = docFrame();
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute('srcdoc') ?? '').toContain('Partial');
  });

  it('SANITIZES the committed HTML before it reaches the sandboxed iframe', async () => {
    const h = harness();
    view(h);
    await userEvent.click(screen.getByRole('button', GENERATE));

    h.emitChunk('<html><body><h1 class="t">Paper</h1>');
    h.emitChunk('<script>window.__DOCVIEW_XSS__=1</script></body></html>');
    h.emitDone();
    await flushInline();

    const srcdoc = docFrame()?.getAttribute('srcdoc') ?? '';
    expect(srcdoc).toContain('Paper');
    expect(srcdoc).not.toMatch(/<script/i);
    expect(srcdoc).not.toContain('__DOCVIEW_XSS__');
  });

  /*
   * S2-002 (independent audit 2026-06-17) — strip remote references from the in-app render too.
   * DOMPurify preserves remote <img src>/CSS url()/@import; the in-app view previously relied SOLELY
   * on the parent CSP being inherited into the sandbox="" srcdoc iframe to block a prompt-injected
   * beacon. Applying stripRemoteRefs in-app (the same control the export uses) makes the defense
   * app-owned and not contingent on Chromium srcdoc CSP-inheritance. Mutation-verified: drop the
   * in-app strip and the remote src survives in the srcdoc.
   */
  it('STRIPS remote references from the committed HTML before it reaches the iframe (S2-002)', async () => {
    const h = harness();
    view(h);
    await userEvent.click(screen.getByRole('button', GENERATE));

    h.emitChunk(
      '<html><body><h1>Paper</h1>' +
        '<img src="https://evil.example/beacon.gif">' +
        '<div style="background:url(https://evil.example/bg.png)">x</div>' +
        '</body></html>',
    );
    h.emitDone();
    await flushInline();

    const srcdoc = docFrame()?.getAttribute('srcdoc') ?? '';
    expect(srcdoc).toContain('Paper');
    expect(srcdoc).not.toContain('https://evil.example/beacon.gif');
    expect(srcdoc).not.toContain('https://evil.example/bg.png');
  });

  it('injects the self-hosted @font-face fonts into the committed document', async () => {
    const h = harness();
    view(h);
    await userEvent.click(screen.getByRole('button', GENERATE));

    h.emitChunk('<!doctype html><html><head></head><body><h1>Doc</h1></body></html>');
    h.emitDone();
    await flushInline();

    const srcdoc = docFrame()?.getAttribute('srcdoc') ?? '';
    expect(srcdoc).toContain('@font-face');
    expect(srcdoc).toContain('Merriweather');
    expect(srcdoc).toMatch(/base64,/);
  });

  it('disables mode / model / generate while streaming and Cancel stops the run', async () => {
    const h = harness();
    view(h);
    await userEvent.click(screen.getByRole('button', GENERATE));
    h.emitProgress('section'); // now streaming

    expect(screen.getByRole('button', { name: 'Minutes' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: /generation model/i })).toBeDisabled();

    // Anchored '^Cancel$' — the app-level progress toast's action is 'Cancel All', so a
    // loose /cancel/i would match both (M07.B). This targets the modal's own Cancel.
    await userEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));

    expect(h.cancels()).toBe(1);
    // Controls re-enabled, no frame committed, no ambiguous state.
    expect(screen.getByRole('button', { name: 'Minutes' })).toBeEnabled();
    expect(docFrame()).toBeNull();
  });

  it('surfaces a non-crashing error state on a gen error', async () => {
    const h = harness();
    view(h);
    await userEvent.click(screen.getByRole('button', GENERATE));

    h.emitError();

    expect(screen.getByRole('alert')).toHaveTextContent('Rate limited.');
  });

  it('loads the latest persisted whitepaper artifact on mount', async () => {
    const h = harness({
      artifacts: [
        {
          id: 'd1',
          sessionId: 's1',
          kind: 'whitepaper',
          content: '<html><body><h1>Persisted paper</h1></body></html>',
          templateId: 'default',
          createdAt: 2,
        },
      ],
    });
    view(h);

    await screen.findByRole('button', { name: /regenerate/i });
    expect(docFrame()?.getAttribute('srcdoc') ?? '').toContain('Persisted paper');
  });

  it('shows a badge for the model that ran once generation completes', async () => {
    const h = harness();
    view(h);
    await userEvent.click(screen.getByRole('button', GENERATE));

    h.emitChunk('<html><body><h1>Done</h1></body></html>');
    h.emitDone({ model: 'claude-opus-4-8' });
    await flushInline();

    expect(screen.getByTestId('model-badge')).toHaveTextContent('Claude Opus 4.8');
  });

  it('offers write-only Regenerate + re-analyze Start over once a doc exists', async () => {
    const h = harness();
    view(h);
    // Produce a first doc.
    await userEvent.click(screen.getByRole('button', GENERATE));
    h.emitChunk('<html><body><h1>v1</h1></body></html>');
    h.emitDone();

    // Regenerate = write-only (reuses FOCUS via generateWhitepaper).
    await userEvent.click(screen.getByRole('button', { name: /^regenerate$/i }));
    expect(h.wpCalls()).toBe(2);
    expect(h.focusCalls()).toBe(0);
    h.emitChunk('<html><body><h1>v2</h1></body></html>');
    h.emitDone();

    // Start over = re-analyze, now ONE whitepaper run carrying reanalyze:true — NOT a
    // separate renderer-orchestrated focus leg.
    await userEvent.click(screen.getByRole('button', { name: /start over/i }));
    expect(h.wpCalls()).toBe(3);
    expect(h.focusCalls()).toBe(0);
    expect(h.lastWpRequest()?.reanalyze).toBe(true);
  });

  it('does NOT inline screenshots into the in-app preview (text-only — the v1 split)', async () => {
    // The in-app preview is text-only by design (C-14): the rendered doc carries no
    // data: screenshots and never pops a dialog. Screenshots ride the export instead.
    const h = harness();
    view(h);

    await userEvent.click(screen.getByRole('button', { name: 'Minutes' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Generate minutes' }));
    h.emitChunk('<html><body><h1>Meeting Minutes</h1></body></html>');
    h.emitDone({ kind: 'minutes' });
    await flushInline();

    const srcdoc = docFrame()?.getAttribute('srcdoc') ?? '';
    expect(srcdoc).toContain('Meeting Minutes');
    expect(srcdoc).not.toContain('data:image'); // no inlined screenshots in the preview
    expect(srcdoc).not.toContain('Session captures');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('exposes Export HTML + markdown once a doc exists, and assembles the export via the IPC', async () => {
    const h = harness();
    view(h);
    await userEvent.click(screen.getByRole('button', GENERATE));
    h.emitChunk('<html><body><h1>Strategy</h1></body></html>');
    h.emitDone();
    await flushInline();

    // Export HTML: pulls full-res raw images, assembles a sanitized self-contained file.
    await userEvent.click(screen.getByRole('button', { name: /export html/i }));
    await waitFor(() => expect(h.lastExportHtml()).not.toBeNull());
    expect(h.exportImagesCalls()).toBe(1);
    const html = h.lastExportHtml()?.content ?? '';
    expect(html).toContain('Strategy');
    expect(html).toContain('data:image/png;base64,RAW=='); // raw screenshot inlined
    expect(html).not.toMatch(/<script/i); // sanitized

    // Export markdown: plain-text, no screenshots, no script.
    await userEvent.click(screen.getByRole('button', { name: /export markdown/i }));
    await waitFor(() => expect(h.lastExportMarkdown()).not.toBeNull());
    const md = h.lastExportMarkdown()?.content ?? '';
    expect(md).toContain('Strategy');
    expect(md).not.toContain('<');
  });

  it('offers no export affordances until a document exists', () => {
    const h = harness();
    view(h);
    expect(screen.queryByRole('button', { name: /export/i })).toBeNull();
  });

  it('exports PDF from the SAME assembled self-contained HTML (M06.C)', async () => {
    const h = harness();
    view(h);
    await userEvent.click(screen.getByRole('button', GENERATE));
    h.emitChunk('<html><body><h1>Strategy</h1></body></html>');
    h.emitDone();
    await flushInline();

    await userEvent.click(screen.getByRole('button', { name: /export pdf/i }));
    await waitFor(() => expect(h.lastExportPdf()).not.toBeNull());
    expect(h.exportImagesCalls()).toBe(1);
    const pdfHtml = h.lastExportPdf()?.content ?? '';
    expect(pdfHtml).toContain('Strategy');
    expect(pdfHtml).toContain('data:image/png;base64,RAW=='); // same inlined screenshot as HTML
    expect(pdfHtml).not.toMatch(/<script/i); // sanitized
  });

  it('threads the export image-cap omitted-count into the exported file (F26 — never silent)', async () => {
    const h = harness({ omittedCount: 5 });
    view(h);
    await userEvent.click(screen.getByRole('button', GENERATE));
    h.emitChunk('<html><body><h1>Big session</h1></body></html>');
    h.emitDone();
    await flushInline();

    await userEvent.click(screen.getByRole('button', { name: /export html/i }));
    await waitFor(() => expect(h.lastExportHtml()).not.toBeNull());
    const html = h.lastExportHtml()?.content ?? '';
    expect(html).toContain('ms-shots-omitted');
    expect(html).toMatch(/5 image/i);
  });

  // --- Per-mode committed-doc + persistence (the minutes state bugs from the IRL) ---

  it('retains each mode’s committed doc across mode switches (whitepaper ↔ minutes)', async () => {
    const h = harness();
    view(h);

    // Generate a white paper.
    await userEvent.click(screen.getByRole('button', GENERATE));
    h.emitChunk('<html><body><h1>WP-DOC</h1></body></html>');
    h.emitDone();
    await flushInline();
    expect(docFrame()?.getAttribute('srcdoc') ?? '').toContain('WP-DOC');

    // Switch to minutes and generate — must NOT render blank.
    await userEvent.click(screen.getByRole('button', { name: 'Minutes' }));
    await userEvent.click(screen.getByRole('button', { name: 'Generate minutes' }));
    h.emitChunk('<html><body><h1>MIN-DOC</h1></body></html>');
    h.emitDone({ kind: 'minutes' });
    await flushInline();
    expect(docFrame()?.getAttribute('srcdoc') ?? '').toContain('MIN-DOC');

    // Switch back to the white paper — its doc is still there (not lost to minutes).
    await userEvent.click(screen.getByRole('button', { name: 'White paper' }));
    expect(docFrame()?.getAttribute('srcdoc') ?? '').toContain('WP-DOC');
  });

  it('keeps Regenerate + Start over in white-paper mode after a minutes doc was generated', async () => {
    const h = harness();
    view(h);

    await userEvent.click(screen.getByRole('button', GENERATE));
    h.emitChunk('<html><body><h1>WP</h1></body></html>');
    h.emitDone();
    await flushInline();

    await userEvent.click(screen.getByRole('button', { name: 'Minutes' }));
    await userEvent.click(screen.getByRole('button', { name: 'Generate minutes' }));
    h.emitChunk('<html><body><h1>MIN</h1></body></html>');
    h.emitDone({ kind: 'minutes' });
    await flushInline();

    await userEvent.click(screen.getByRole('button', { name: 'White paper' }));
    expect(screen.getByRole('button', { name: /^regenerate$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start over/i })).toBeInTheDocument();
  });

  it('reloads a persisted MINUTES artifact on reopen and restores minutes mode', async () => {
    const h = harness({
      artifacts: [
        {
          id: 'm1',
          sessionId: 's1',
          kind: 'minutes',
          content: '<html><body><h1>Persisted minutes</h1></body></html>',
          templateId: null,
          createdAt: 9,
        },
      ],
    });
    view(h);

    // Restored to minutes mode showing the persisted minutes doc (per-mode reload).
    await waitFor(() =>
      expect(docFrame()?.getAttribute('srcdoc') ?? '').toContain('Persisted minutes'),
    );
  });

  it('restores the most-recently generated mode on reopen (newest artifact wins)', async () => {
    // getArtifacts returns newest-first; minutes is newer than the whitepaper here.
    const h = harness({
      artifacts: [
        {
          id: 'm1',
          sessionId: 's1',
          kind: 'minutes',
          content: '<html><body><h1>Newer minutes</h1></body></html>',
          templateId: null,
          createdAt: 20,
        },
        {
          id: 'w1',
          sessionId: 's1',
          kind: 'whitepaper',
          content: '<html><body><h1>Older paper</h1></body></html>',
          templateId: 'default',
          createdAt: 5,
        },
      ],
    });
    view(h);

    await waitFor(() =>
      expect(docFrame()?.getAttribute('srcdoc') ?? '').toContain('Newer minutes'),
    );
    // The older white paper is still retained — switching to it shows it (not blank).
    await userEvent.click(screen.getByRole('button', { name: 'White paper' }));
    expect(docFrame()?.getAttribute('srcdoc') ?? '').toContain('Older paper');
  });

  // M05.A: the persisted-doc model badge. A doc reloaded from `documents` carries the
  // model that produced it (migration v5), so the badge survives reopen/restart — not
  // only the just-generated case.
  it('shows the model badge for a doc reloaded from storage (migration v5)', async () => {
    const h = harness({
      artifacts: [
        {
          id: 'w1',
          sessionId: 's1',
          kind: 'whitepaper',
          content: '<html><body><h1>Reloaded paper</h1></body></html>',
          templateId: 'default',
          createdAt: 5,
          model: 'claude-sonnet-4-6',
        },
      ],
    });
    view(h);

    await waitFor(() =>
      expect(docFrame()?.getAttribute('srcdoc') ?? '').toContain('Reloaded paper'),
    );
    expect(screen.getByTestId('model-badge')).toHaveTextContent('Claude Sonnet 4.6');
  });

  // --- A run closes the editor through its unsaved-edits guard (issue: warn before close) ---

  const TEMPLATES: GenTemplate[] = [
    {
      id: 'default',
      name: 'Default',
      focusPrompt: 'D-FOCUS',
      whitepaperPrompt: 'D-WP',
      isDefault: true,
    },
    {
      id: 'tmpl-1',
      name: 'My template',
      focusPrompt: 'F-FOCUS',
      whitepaperPrompt: 'F-WP',
      isDefault: false,
    },
  ];

  it('Generate collapses an open (clean) editor and starts the run', async () => {
    const h = harness({ templates: TEMPLATES });
    view(h);

    await userEvent.click(screen.getByRole('button', { name: /edit prompt/i }));
    expect(await screen.findByLabelText(/focus prompt/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', GENERATE));

    expect(h.wpCalls()).toBe(1);
    expect(screen.queryByLabelText(/focus prompt/i)).toBeNull(); // editor collapsed
  });

  it('Generate with unsaved prompt edits HOLDS the run behind the warning; Keep editing cancels it', async () => {
    const h = harness({ templates: TEMPLATES });
    view(h);

    await userEvent.click(screen.getByRole('button', { name: /edit prompt/i }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /template/i }), 'tmpl-1');
    const focus = (await screen.findByLabelText(/focus prompt/i)) as HTMLTextAreaElement;
    await waitFor(() => expect(focus).toHaveValue('F-FOCUS'));
    await userEvent.type(focus, ' edit'); // dirty

    await userEvent.click(screen.getByRole('button', GENERATE));

    // The run is held — the confirm is shown and nothing generated yet.
    expect(screen.getByRole('alertdialog', { name: /unsaved/i })).toBeInTheDocument();
    expect(h.wpCalls()).toBe(0);

    await userEvent.click(screen.getByRole('button', { name: /keep editing/i }));
    expect(h.wpCalls()).toBe(0); // run cancelled by "Keep editing"
    expect(screen.getByLabelText(/focus prompt/i)).toBeInTheDocument(); // editor still open
  });

  it('Discard & close from a Generate-triggered warning closes the editor and starts the run', async () => {
    const h = harness({ templates: TEMPLATES });
    view(h);

    await userEvent.click(screen.getByRole('button', { name: /edit prompt/i }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /template/i }), 'tmpl-1');
    const focus = (await screen.findByLabelText(/focus prompt/i)) as HTMLTextAreaElement;
    await waitFor(() => expect(focus).toHaveValue('F-FOCUS'));
    await userEvent.type(focus, ' edit'); // dirty

    await userEvent.click(screen.getByRole('button', GENERATE));
    await userEvent.click(screen.getByRole('button', { name: /discard & close/i }));

    expect(h.wpCalls()).toBe(1);
    expect(screen.queryByLabelText(/focus prompt/i)).toBeNull(); // editor collapsed
  });

  // --- Cancel reverts the doc + template chip to the last committed state (issue 3) ---

  const OLD_DOC: GenDocument = {
    id: 'd1',
    sessionId: 's1',
    kind: 'whitepaper',
    content: '<html><body><h1>OLD</h1></body></html>',
    templateId: 'default',
    model: 'claude-opus-4-8',
    createdAt: 1,
  };
  const NEW_DOC: GenDocument = {
    id: 'd2',
    sessionId: 's1',
    kind: 'whitepaper',
    content: '<html><body><h1>NEW</h1></body></html>',
    templateId: 'tmpl-1',
    model: 'claude-opus-4-8',
    createdAt: 2,
  };

  it('reverts the doc + template chip to the last committed state when a regenerate is cancelled', async () => {
    const h = harness({ artifacts: [OLD_DOC], templates: TEMPLATES });
    view(h);
    expect(await screen.findByTestId('template-badge')).toHaveTextContent('Default');

    // Regenerate starts a run (snapshot of the committed slot is taken).
    await userEvent.click(screen.getByRole('button', { name: /^regenerate$/i }));

    // A late save for the just-started run lands and is adopted into the slot...
    h.setArtifacts([NEW_DOC]);
    h.emitArtifactSaved({ sessionId: 's1', kind: 'whitepaper', id: 'd2' });
    await flushInline();

    // ...but the user cancels — the shown doc + chip must revert to the last committed.
    await userEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
    await flushInline();

    expect(screen.getByTestId('template-badge')).toHaveTextContent('Default');
    expect(docFrame()?.getAttribute('srcdoc') ?? '').toContain('OLD');
  });

  it('ignores a late artifact-save for a run the user already cancelled', async () => {
    const h = harness({ artifacts: [OLD_DOC], templates: TEMPLATES });
    view(h);
    expect(await screen.findByTestId('template-badge')).toHaveTextContent('Default');

    await userEvent.click(screen.getByRole('button', { name: /^regenerate$/i }));
    await userEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
    await flushInline();

    // The abandoned run's save arrives AFTER the cancel — it must not be adopted.
    h.setArtifacts([NEW_DOC]);
    h.emitArtifactSaved({ sessionId: 's1', kind: 'whitepaper', id: 'd2' });
    await flushInline();

    expect(screen.getByTestId('template-badge')).toHaveTextContent('Default');
    expect(docFrame()?.getAttribute('srcdoc') ?? '').toContain('OLD');
  });
});
