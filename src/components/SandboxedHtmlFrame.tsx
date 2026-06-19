import { useRef, type ReactElement } from 'react';

export interface SandboxedHtmlFrameProps {
  /** The HTML document to render. Passed through to `srcDoc` VERBATIM — this
   *  primitive does NOT sanitize; the caller sanitizes first (defense-in-depth). */
  html: string;
  /** Accessible name for the frame. */
  title: string;
  className?: string;
  testId?: string;
}

/*
 * A NON-RELOADING repaint nudge (M06.E iframe-paint blocker). Some Chromium/Electron
 * compositor states load the srcDoc but never commit the paint under render churn, leaving a
 * white frame (research: paint isn't reliable until after `load`). We force the compositor to
 * re-raster AFTER the document has loaded, WITHOUT detaching the frame or reloading its srcDoc:
 *   - reading offsetHeight forces a synchronous layout (a reflow), and
 *   - a one-tick translateZ(0)→'' toggle forces a fresh compositor frame.
 * We deliberately AVOID display:none / src reassignment: toggling display can detach and
 * RELOAD an iframe's srcDoc, re-entering the un-committed-reload race — exactly the failure the
 * prior imperative attempt hit (it blanked everything). The harness pins that this nudge never
 * blanks-in-test.
 */
function repaintNudge(frame: HTMLIFrameElement | null): void {
  if (!frame) {
    return;
  }
  void frame.offsetHeight; // reflow read — layout only, no reload
  frame.style.transform = 'translateZ(0)';
  const raf =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0);
  raf(() => {
    frame.style.transform = '';
  });
}

/*
 * The sandboxed-iframe primitive (M04.B) — the LOAD-BEARING primary control for
 * untrusted, LLM-generated HTML. The content renders via `srcDoc` inside an iframe
 * whose `sandbox` attribute is EMPTY: it grants neither `allow-scripts` (so no
 * script — inline, <script>, on*=, or javascript: — can execute) nor
 * `allow-same-origin` (so the frame gets an opaque origin with no reach into the
 * parent window, the preload bridge, IPC, or Node). CSS and font/image resource
 * loads are unaffected by the sandbox, so the white paper's styling still renders.
 *
 * This primitive deliberately does NOT sanitize — it is the sole control standing
 * between raw HTML and execution, which is exactly what lets the e2e sandbox probe
 * prove the sandbox blocks scripts on its own (raw, unsanitized input). Adding any
 * token to `sandbox` (e.g. allow-scripts) is the mutation that makes that proof
 * fail. ADR-0010.
 */
export function SandboxedHtmlFrame({
  html,
  title,
  className,
  testId,
}: SandboxedHtmlFrameProps): ReactElement {
  const frameRef = useRef<HTMLIFrameElement>(null);
  return (
    <iframe
      ref={frameRef}
      title={title}
      className={className}
      data-testid={testId}
      // Empty sandbox = maximally restrictive: no allow-scripts, no allow-same-origin.
      sandbox=""
      srcDoc={html}
      // Force a paint after the srcDoc loads (M06.E) — non-reloading; see repaintNudge.
      onLoad={() => repaintNudge(frameRef.current)}
    />
  );
}
