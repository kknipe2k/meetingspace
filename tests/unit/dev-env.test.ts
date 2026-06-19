import { describe, expect, it } from 'vitest';

import { readDevEnv } from '../../electron/dev-env';

/*
 * The dev/test env-seam accessor (M05.G / CFG-001). Every MEETINGSPACE_* and
 * ELECTRON_RENDERER_URL seam is honored ONLY in an unpackaged (dev/e2e) build and
 * is structurally ignored in a packaged build — mirroring the sandboxProbeEnabled
 * gate. `readDevEnv` is the pure, injectable seam (isPackaged passed in); the thin
 * `devEnv` wrapper that reads the real process.env + app.isPackaged is the
 * Electron-only OS wrapper (not loadable under Node, same pattern as app-paths.ts).
 *
 * This pins the class-level invariant: a packaged build returns undefined for
 * EVERY override key, regardless of what the environment carries.
 */
const SEAM_KEYS = [
  'MEETINGSPACE_USER_DATA',
  'ELECTRON_RENDERER_URL',
  'MEETINGSPACE_SANDBOX_PROBE',
  'MEETINGSPACE_FAKE_LLM',
  'MEETINGSPACE_FAKE_CAPTURE',
];

describe('readDevEnv — the !app.isPackaged-gated dev/test env accessor', () => {
  it.each(SEAM_KEYS)(
    'ignores %s in a packaged build (returns undefined regardless of the env value)',
    (key) => {
      const env: NodeJS.ProcessEnv = { [key]: 'attacker-controlled-value' };
      expect(readDevEnv(env, true, key)).toBeUndefined();
    },
  );

  it.each(SEAM_KEYS)('honors %s in an unpackaged (dev/e2e) build', (key) => {
    const env: NodeJS.ProcessEnv = { [key]: 'dev-value' };
    expect(readDevEnv(env, false, key)).toBe('dev-value');
  });

  it('returns undefined for an unset key in an unpackaged build', () => {
    expect(readDevEnv({}, false, 'MEETINGSPACE_USER_DATA')).toBeUndefined();
  });
});
