import type { ReactElement } from 'react';

import { SandboxedHtmlFrame } from './SandboxedHtmlFrame';

/*
 * E2E-only sandbox probe (M04.B). Mounted by App ONLY when the renderer is loaded
 * with `?probe=1` — a query main.ts adds only under MEETINGSPACE_SANDBOX_PROBE=1 and
 * !app.isPackaged (structurally unreachable in a shipped build; see main.ts). It
 * renders RAW, UNSANITIZED malicious HTML through the SAME SandboxedHtmlFrame the
 * white paper uses, so the e2e can prove the sandbox blocks script execution on its
 * own — independent of the sanitizer. Each vector attempts window.parent.postMessage
 * (which crosses the opaque sandbox origin); a blocked script can't fire it, so the
 * e2e asserting "no SANDBOX_XSS_EXECUTED message" passes only while the sandbox
 * holds. Dropping/loosening the sandbox makes the script run and fails the proof.
 *
 * Harmless even if it ever rendered in production: a static string in a scriptless,
 * origin-less frame with no key/IPC/node reach.
 */
const PROBE_HTML = [
  '<!doctype html><html lang="en"><head><meta charset="utf-8" />',
  '<script>window.parent.postMessage("SANDBOX_XSS_EXECUTED","*")</script>',
  '</head><body>',
  '<img src="x" onerror="window.parent.postMessage(\'SANDBOX_XSS_EXECUTED\',\'*\')" alt="probe" />',
  '<p>sandbox probe</p>',
  '</body></html>',
].join('');

export function SandboxProbe(): ReactElement {
  return (
    <SandboxedHtmlFrame html={PROBE_HTML} title="Sandbox probe" testId="sandbox-probe-frame" />
  );
}
