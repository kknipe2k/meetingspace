import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import { injectFontFaces } from '@shared/fonts/font-faces';
import { DEFAULT_GENERATION_MODEL, modelLabel } from '@shared/models';
import type { GenTemplate } from '@shared/types';

import { docIdentityKey } from '../gen/doc-key';
import { buildExportHtml, stripRemoteRefs } from '../gen/export-html';
import { buildMarkdown } from '../gen/export-markdown';
import { GENERATED_DOC_FONT_STYLE } from '../gen/fonts';
import { genKindLabel } from '../gen/progress';
import { sanitizeHtml } from '../gen/sanitize-html';
import { formatElapsed } from '../hooks/useElapsed';
import { useGeneration, type GenMode } from '../hooks/useGeneration';
import { useToasts } from '../hooks/useToasts';
import { genClient, type GenClient } from '../ipc/client';

import { ModelPicker } from './ModelPicker';
import { PromptTemplateEditor, type PromptTemplateEditorHandle } from './PromptTemplateEditor';
import { SandboxedHtmlFrame } from './SandboxedHtmlFrame';

// The default (shipped) prompt template id — the read-only seed (M04.A).
const SEED_TEMPLATE_ID = 'default';

const MODES: ReadonlyArray<{ id: GenMode; label: string; action: string }> = [
  { id: 'whitepaper', label: 'White paper', action: 'Generate white paper' },
  { id: 'minutes', label: 'Minutes', action: 'Generate minutes' },
  { id: 'raw', label: 'Raw notes', action: 'Show raw notes' },
];

// AUTH / NO_KEY are fixed by re-entering the key (Settings); the rest are transient
// (TIMEOUT tiers, RATE_LIMIT, OFFLINE, OVERLOADED, UNKNOWN) and offer an in-place Retry.
function isKeyError(code: string): boolean {
  return code === 'AUTH' || code === 'NO_KEY';
}

export interface GeneratedDocViewProps {
  sessionId: string;
  /** Injectable for tests; defaults to the real gen IPC client. */
  client?: GenClient;
  /** The generation model (owned by LLMPanel via prefs); defaults to Sonnet 4.6. */
  generationModel?: string;
  onGenerationModelChange?(model: string): void;
  /** Resolves a session id to its display name — the busy toast names the LIVE run's
   *  session, which may not be this modal's session (App passes the live list). */
  sessionName?(sessionId: string): string | undefined;
}

/*
 * The generated-document surface (M04.B render; M04.C experience; M04.D export; M07.B
 * truthful modal). B's load-bearing control is REUSED UNCHANGED: the COMMITTED document is
 * sanitized (DOMPurify) and rendered inside SandboxedHtmlFrame (no allow-scripts /
 * allow-same-origin).
 *
 * M07.B (product-owner IRL reversal): generation is MANUAL — opening the modal NEVER starts
 * a run; each mode's Generate button is the only trigger. A persisted doc shows on open; an
 * in-flight run reattaches (streaming UI), with the doc reloaded from storage on done. The
 * live-run + Cancel surface is the app-level GenerationStatusToast (a persistent toast that
 * outlives the modal); this component owns NO toasts. Errors live in the persistent
 * role="alert" block. The modal also offers a manual Refresh (re-run the mount query).
 *
 * The IN-APP preview is TEXT-ONLY (the pinned v1 split): screenshots ride the EXPORT, not
 * the rendered doc (M04.C C-14). Partial streamed HTML is NEVER rendered.
 */
export function GeneratedDocView({
  sessionId,
  client,
  generationModel,
  onGenerationModelChange,
  sessionName,
}: GeneratedDocViewProps): ReactElement {
  const {
    docFor,
    isStreaming,
    error,
    progress,
    busy,
    initialMode,
    generate,
    startOver,
    retry,
    cancel,
    cancelCurrentAndStart,
    refresh,
  } = useGeneration(sessionId, {
    ...(client ? { client } : {}),
  });
  const { show, dismiss } = useToasts();

  const [mode, setMode] = useState<GenMode>('whitepaper');
  const [templateId, setTemplateId] = useState<string>(SEED_TEMPLATE_ID);
  const [showEditor, setShowEditor] = useState(false);
  const [model, setModel] = useState<string>(generationModel ?? DEFAULT_GENERATION_MODEL);
  const [exporting, setExporting] = useState(false);
  // Template list for the doc's template chip (resolves a doc's templateId → name).
  const [templates, setTemplates] = useState<GenTemplate[]>([]);
  // Imperative handle to the editor so a run routes through its unsaved-edits guard.
  const editorRef = useRef<PromptTemplateEditorHandle>(null);

  const gen = useMemo(() => client ?? genClient, [client]);

  // Keep the template list fresh: on open, on selection change, and when the editor
  // closes (a save/rename may have changed a name).
  useEffect(() => {
    let active = true;
    void gen.listTemplates().then((list) => {
      if (active) {
        setTemplates(list);
      }
    });
    return () => {
      active = false;
    };
  }, [gen, templateId, showEditor]);

  const templateNameFor = (id: string | null): string | null =>
    id === null ? null : (templates.find((t) => t.id === id)?.name ?? null);

  // The committed doc for the mode being shown (each mode keeps its own — switching
  // never blanks another mode's result).
  const current = docFor(mode);
  const doc = current.html;

  // Adopt the owner-provided pref once it resolves (LLMPanel reads it from prefs).
  useEffect(() => {
    if (generationModel) {
      setModel(generationModel);
    }
  }, [generationModel]);

  // The single-slot busy toast (M07.C amendment): a refused Generate is NEVER silent —
  // explain what is running ({session} · {kind} — elapsed) and offer the ONE
  // explicitly-labeled auto-start path. Plain cancel lives on the app-level run toast
  // (B's surface) and never chains into a start. The resolver rides a ref (the
  // graduated context-value dep-loop gotcha: depend only on stable callbacks + busy).
  const sessionNameRef = useRef(sessionName);
  sessionNameRef.current = sessionName;
  useEffect(() => {
    if (busy === null) {
      dismiss('gen-busy');
      return undefined;
    }
    const name = sessionNameRef.current?.(busy.sessionId);
    const kindLabel =
      busy.kind === 'whitepaper' || busy.kind === 'minutes' ? genKindLabel(busy.kind) : 'Analysis';
    const elapsed = formatElapsed(Math.max(0, Date.now() - busy.startedAt));
    show({
      key: 'gen-busy',
      variant: 'info',
      message: `A build is already running: ${name ? `${name} · ` : ''}${kindLabel} — ${elapsed}`,
      action: { label: 'Cancel current & start this one', onClick: cancelCurrentAndStart },
      durationMs: null,
    });
    return () => dismiss('gen-busy');
  }, [busy, show, dismiss, cancelCurrentAndStart]);

  // Reopen on whatever mode was last shown (the most-recent persisted artifact). Apply
  // ONCE so it never fights a user's mode switch.
  const appliedInitial = useRef(false);
  useEffect(() => {
    if (!appliedInitial.current && initialMode) {
      appliedInitial.current = true;
      setMode(initialMode);
    }
  }, [initialMode]);

  const runParams = (): { mode: GenMode; model?: string; templateId?: string } => ({
    mode,
    ...(mode !== 'raw' ? { model } : {}),
    // Both whitepaper and minutes are template-driven now (minutes gained an editable
    // prompt); raw assembles notes main-side and uses no template.
    ...(mode !== 'raw' ? { templateId } : {}),
  });

  // A run first closes the open editor — through its unsaved-edits guard, so a dirty draft
  // raises the Save/Discard/Keep-editing confirm and HOLDS the run until resolved ("Keep
  // editing" cancels it). With the editor closed (or clean) the run starts immediately.
  const runGen = (): void => generate(runParams());
  const runReanalyze = (): void => startOver(runParams());
  const start = (): void => {
    if (showEditor && editorRef.current) {
      editorRef.current.attemptClose(runGen);
    } else {
      runGen();
    }
  };
  const reanalyze = (): void => {
    if (showEditor && editorRef.current) {
      editorRef.current.attemptClose(runReanalyze);
    } else {
      runReanalyze();
    }
  };

  // Sanitize the COMMITTED doc, then STRIP REMOTE REFS, then inject the self-hosted fonts (after
  // sanitization, app-trusted). The in-app preview is TEXT-ONLY — screenshots ride the export.
  // Audit S2-002: stripRemoteRefs is applied in-app too (the same control the export uses) so a
  // prompt-injected remote <img>/url()/@import in untrusted meeting content can't beacon at view
  // time. This makes the in-app no-remote-load defense APP-OWNED rather than depending solely on
  // Chromium inheriting the parent CSP into the sandbox="" srcdoc iframe.
  const safeBody = useMemo(() => (doc.length > 0 ? stripRemoteRefs(sanitizeHtml(doc)) : ''), [doc]);
  const safeDoc = useMemo(
    () => (safeBody.length === 0 ? '' : injectFontFaces(safeBody, GENERATED_DOC_FONT_STYLE)),
    [safeBody],
  );

  const hasWhitepaper = docFor('whitepaper').html.length > 0;
  const ranModel = current.model;
  const showDoc = !isStreaming && safeDoc.length > 0;

  // Identity key for the rendered doc (M06.E iframe-paint blocker): the frame REMOUNTS only
  // when the content actually changes (switching artifacts / regenerate), never on an unrelated
  // re-render — a fresh element guarantees a clean srcDoc load. Stable per content = no thrash.
  const docKey = useMemo(() => docIdentityKey(safeDoc), [safeDoc]);

  // Export the SHOWN doc. HTML = the self-contained file (full-res raw-base64 screenshots
  // + pure-CSS lightbox, sanitized via the same seam); markdown = plain text.
  const exportDoc = async (format: 'html' | 'markdown' | 'pdf'): Promise<void> => {
    if (doc.length === 0 || exporting) {
      return;
    }
    setExporting(true);
    try {
      const defaultName = `${MODES.find((m) => m.id === mode)?.label ?? 'Document'}`;
      if (format === 'markdown') {
        await gen.exportMarkdown({ content: buildMarkdown(doc), defaultName });
        return;
      }
      // HTML + PDF share the same assembled self-contained document; PDF just renders it via
      // printToPDF main-side. F26: the screenshot set is capped — thread omittedCount so the
      // exported file carries an honest "N images omitted" notice (never silently lossy).
      const { images, omittedCount } = await gen.exportImages(sessionId);
      const heading = mode === 'whitepaper' ? 'Session captures' : 'Screenshots';
      const content = buildExportHtml(doc, images, GENERATED_DOC_FONT_STYLE, {
        heading,
        ...(omittedCount > 0 ? { omittedCount } : {}),
      });
      await (format === 'pdf'
        ? gen.exportPdf({ content, defaultName })
        : gen.exportHtml({ content, defaultName }));
    } catch {
      // F15: an export rejection (exportImages/exportHtml/exportMarkdown/exportPdf) used to vanish
      // silently (try/finally with no catch). Surface it.
      show({ variant: 'error', message: "Couldn't export the document." });
    } finally {
      setExporting(false);
    }
  };

  const handleModelChange = (next: string): void => {
    setModel(next);
    onGenerationModelChange?.(next);
  };

  const primaryLabel =
    mode === 'whitepaper' && hasWhitepaper
      ? 'Regenerate'
      : (MODES.find((m) => m.id === mode)?.action ?? 'Generate');

  return (
    <div
      className="generated-doc"
      data-testid="generated-doc"
      // Observability for the iframe-paint bug class (M06.E real blocker): the harness reads
      // these to assert the frame's render preconditions independently of whether it painted.
      data-show-doc={String(showDoc)}
      data-doc-len={safeDoc.length}
      data-streaming={String(isStreaming)}
    >
      <div className="generated-doc-toolbar">
        <div className="generated-doc-modes" role="group" aria-label="Document type">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`btn-mode${m.id === mode ? ' is-active' : ''}`}
              aria-pressed={m.id === mode}
              disabled={isStreaming}
              onClick={() => setMode(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>

        {mode !== 'raw' && (
          <ModelPicker model={model} onChange={handleModelChange} disabled={isStreaming} />
        )}

        {mode !== 'raw' && (
          <button
            type="button"
            className="btn btn-secondary"
            aria-expanded={showEditor}
            disabled={isStreaming}
            onClick={() => setShowEditor((v) => !v)}
          >
            Edit prompt
          </button>
        )}

        {isStreaming ? (
          <button type="button" className="btn btn-secondary" onClick={cancel}>
            Cancel
          </button>
        ) : (
          <>
            <button type="button" className="btn btn-primary" onClick={start}>
              {primaryLabel}
            </button>
            {mode === 'whitepaper' && hasWhitepaper && (
              <button type="button" className="btn btn-secondary" onClick={reanalyze}>
                Start over
              </button>
            )}
            <button
              type="button"
              className="btn-icon generated-doc-refresh"
              aria-label="Refresh"
              title="Refresh"
              onClick={refresh}
            >
              ⟳
            </button>
          </>
        )}
        {!isStreaming && doc.length > 0 && (
          <div className="generated-doc-export" role="group" aria-label="Export">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={exporting}
              onClick={() => void exportDoc('html')}
            >
              Export HTML
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={exporting}
              onClick={() => void exportDoc('markdown')}
            >
              Export markdown
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={exporting}
              onClick={() => void exportDoc('pdf')}
            >
              Export PDF
            </button>
          </div>
        )}
      </div>

      {mode === 'whitepaper' && hasWhitepaper && !isStreaming && (
        <p className="generated-doc-hint">
          Regenerate re-runs the write step from the saved analysis (output will vary). Start over
          re-analyzes the session first.
        </p>
      )}

      {showEditor && mode !== 'raw' && (
        <PromptTemplateEditor
          ref={editorRef}
          {...(client ? { client } : {})}
          selectedTemplateId={templateId}
          onSelectTemplate={setTemplateId}
          onClose={() => setShowEditor(false)}
        />
      )}

      {isStreaming && (
        <p className="generated-doc-progress" role="status" aria-live="polite">
          {progress
            ? `${progress.label} (step ${progress.index} of ${progress.total})`
            : 'Generating…'}
        </p>
      )}

      {showDoc && (ranModel !== null || templateNameFor(current.templateId) !== null) && (
        <div className="generated-doc-meta">
          {ranModel !== null && (
            <span className="generated-doc-badge" data-testid="model-badge">
              {modelLabel(ranModel)}
            </span>
          )}
          {templateNameFor(current.templateId) !== null && (
            <span className="generated-doc-badge" data-testid="template-badge">
              {templateNameFor(current.templateId)}
            </span>
          )}
        </div>
      )}

      {error !== null && (
        <div className="generated-doc-error" role="alert">
          <span className="generated-doc-error-message">{error.message}</span>
          {!isKeyError(error.code) && (
            <button
              type="button"
              className="btn btn-secondary generated-doc-error-action"
              onClick={retry}
              disabled={isStreaming}
            >
              Retry
            </button>
          )}
        </div>
      )}

      {showDoc ? (
        <SandboxedHtmlFrame
          key={docKey}
          html={safeDoc}
          title="Generated document"
          className="generated-doc-frame"
          testId="generated-doc-frame"
        />
      ) : (
        !isStreaming &&
        error === null && (
          <p className="generated-doc-empty">
            No document yet. Choose a type and generate one from this session’s notes and
            screenshots.
          </p>
        )
      )}
    </div>
  );
}
