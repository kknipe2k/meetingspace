import { describe, expect, it } from 'vitest';

import { buildAboutInfo } from '../../electron/about';

/*
 * The About dialog content seam (M06.E). buildAboutInfo is a PURE function — it maps the
 * app version (read main-side via app.getVersion()) to the message-box fields. The
 * dialog.showMessageBox call is the thin OS wrapper in electron/main.ts (coverage-excluded).
 *
 * Per ADR-0023 (auto-update deferred) the About dialog shows the CURRENT VERSION ONLY —
 * no "check for updates" affordance and no releases link.
 */
describe('buildAboutInfo', () => {
  it('names the product and shows the supplied version', () => {
    const info = buildAboutInfo('1.1.0');
    expect(info.title).toMatch(/MeetingSpace/);
    expect(`${info.message} ${info.detail}`).toMatch(/1\.1\.0/);
  });

  it('shows no releases link and no update affordance (ADR-0023)', () => {
    const blob = JSON.stringify(buildAboutInfo('1.1.0'));
    expect(blob).not.toMatch(/https?:\/\//);
    expect(blob).not.toMatch(/update/i);
  });
});
