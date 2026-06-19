/*
 * The sandbox-probe gate (M04.B). The e2e-only sandbox probe renders RAW,
 * unsanitized malicious HTML through SandboxedHtmlFrame under a permissive-CSP
 * probe page (probe.html) so the e2e can prove the sandbox blocks scripts on its
 * own — with the inherited production CSP removed as a confound. That page must be
 * STRUCTURALLY UNREACHABLE in a shipped build (it deliberately relaxes script-src),
 * exactly like the fake-LLM seam: enabled only when the flag is set AND the build is
 * unpackaged. Extracted as a pure predicate so production-unreachability is enforced
 * by a unit test, not just a comment.
 */
export function sandboxProbeEnabled(flag: string | undefined, isPackaged: boolean): boolean {
  return flag === '1' && !isPackaged;
}
