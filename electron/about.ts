/*
 * The About dialog content seam (M06.E). buildAboutInfo maps the app version (read main-side
 * via app.getVersion()) to the native message-box fields; the dialog.showMessageBox call is the
 * thin OS wrapper in electron/main.ts.
 *
 * Per ADR-0023 (auto-update deferred to a future milestone) the About dialog shows the CURRENT
 * VERSION ONLY — there is no "check for updates" affordance and no releases link in v1.1; users
 * update by downloading a new build manually. It carries the AI-assistance disclosure (CLAUDE §13).
 */
export interface AboutInfo {
  readonly title: string;
  readonly message: string;
  readonly detail: string;
}

export function buildAboutInfo(version: string): AboutInfo {
  return {
    title: 'About MeetingSpace',
    message: `MeetingSpace ${version}`,
    detail:
      'A Windows-first desktop note-taking app for meetings, with a built-in Claude layer.\n\n' +
      'Built with Claude Code under the Build Framework methodology; all work is human-reviewed before merge.',
  };
}
