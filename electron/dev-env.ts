import { app } from 'electron';

/*
 * The single dev/test environment-seam accessor (CFG-001 / M05.G).
 *
 * Successive audits kept surfacing the same class — a dev/test `process.env` seam
 * honored in a PACKAGED build because it wasn't gated `!app.isPackaged`. This is the
 * one place `process.env` is read for those seams: a packaged build returns
 * `undefined` for EVERY override, so the value can only ever take effect in an
 * unpackaged dev/e2e build (mirrors `sandboxProbeEnabled`). The class is enforced by
 * `tests/security/env-seams.test.ts`, which fails CI on any raw `process.env` read in
 * `electron/` outside this file.
 *
 * `readDevEnv` is the pure, injectable seam (isPackaged passed in) so the gating is
 * unit-tested; `devEnv` is the thin Electron wrapper that sources the real
 * `process.env` + `app.isPackaged` (not loadable under Node — same pattern as
 * `app-paths.ts`).
 */
export function readDevEnv(
  env: NodeJS.ProcessEnv,
  isPackaged: boolean,
  key: string,
): string | undefined {
  return isPackaged ? undefined : env[key];
}

export function devEnv(key: string): string | undefined {
  return readDevEnv(process.env, app.isPackaged, key);
}
