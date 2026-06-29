import type { MenuItemConstructorOptions } from 'electron';

import type { ThemePreference } from '@shared/types';

/*
 * The native application menu (M06.A; REVIEW-V11 F1/F30). The app shipped Electron's DEFAULT
 * menu, which exposes Reload / Force Reload / Toggle DevTools in packaged builds — and whose
 * only saving grace was the clipboard/zoom roles it provided for free. Replacing it with
 * `setApplicationMenu(null)` would silently kill the macOS clipboard accelerators, so the real
 * menu is built IN THE SAME CHANGE that removes the default (the F1 trap).
 *
 * `buildAppMenuTemplate` is a PURE seam — it returns a MenuItemConstructorOptions[] with no
 * Electron runtime call (a type-only import, erased at build), so the load-bearing invariants
 * are Node-unit-testable: clipboard/zoom roles always present; DevTools/Reload omitted when
 * `isPackaged`. The Menu.buildFromTemplate + setApplicationMenu call is the thin wrapper in
 * electron/main.ts (coverage-excluded, like the other OS-call wrappers).
 *
 * Find and New Session carry their accelerator LABEL for discoverability but set
 * `registerAccelerator: false`: the renderer owns the actual Ctrl/Cmd+F / Ctrl/Cmd+N keypress
 * (so the behavior is jsdom-testable and there is no double-fire), while a mouse click routes
 * through the injected command — main forwards it to the renderer over app:command.
 */
export interface AppMenuCommands {
  newSession(): void;
  focusSearch(): void;
  zoomIn(): void;
  zoomOut(): void;
  zoomReset(): void;
  setTheme(preference: ThemePreference): void;
  // M06.E: Help ▸ About (version + AI-disclosure dialog) and Open Logs Folder (the findable
  // main.log location). There is deliberately NO "Check for Updates" item — auto-update is
  // deferred (ADR-0023).
  showAbout(): void;
  openLogs(): void;
}

export interface AppMenuOptions {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly commands: AppMenuCommands;
}

export function buildAppMenuTemplate({
  platform,
  isPackaged,
  commands,
}: AppMenuOptions): MenuItemConstructorOptions[] {
  const mac = platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [];

  if (mac) {
    template.push({ role: 'appMenu' });
  }

  template.push({
    label: 'File',
    submenu: [
      {
        label: 'New Session',
        accelerator: 'CmdOrCtrl+N',
        // The renderer owns the keypress (see file header) — show the accelerator, don't bind it.
        registerAccelerator: false,
        click: () => commands.newSession(),
      },
      { type: 'separator' },
      mac ? { role: 'close' } : { role: 'quit' },
    ],
  });

  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(mac
        ? ([{ role: 'pasteAndMatchStyle' }, { role: 'delete' }] as MenuItemConstructorOptions[])
        : []),
      { role: 'selectAll' },
      { type: 'separator' },
      {
        label: 'Find…',
        accelerator: 'CmdOrCtrl+F',
        registerAccelerator: false,
        click: () => commands.focusSearch(),
      },
    ],
  });

  template.push({
    label: 'View',
    submenu: [
      { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => commands.zoomIn() },
      { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => commands.zoomOut() },
      { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => commands.zoomReset() },
      { type: 'separator' },
      // Appearance preference (M06.A IRL fix): System follows the OS, Light/Dark override it.
      // Plain items (not radio) so there is no menu-rebuild needed to keep a checkmark in sync —
      // the active appearance is visible in the app itself. Routed to the renderer (theme:*).
      {
        label: 'Appearance',
        submenu: [
          { label: 'System', click: () => commands.setTheme('system') },
          { label: 'Light', click: () => commands.setTheme('light') },
          { label: 'Dark', click: () => commands.setTheme('dark') },
        ],
      },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      // DevTools / Reload are dev affordances only — omitted from packaged builds (F1/F30).
      ...(isPackaged
        ? []
        : ([
            { type: 'separator' },
            { role: 'reload' },
            { role: 'forceReload' },
            { role: 'toggleDevTools' },
          ] as MenuItemConstructorOptions[])),
    ],
  });

  // M09: an explicit Window submenu replaces the built-in `{ role: 'windowMenu' }`. That role's
  // default carried a macOS-style "Zoom" (window-maximize) item that is dead/orphaned on Windows —
  // the app's real zoom lives in View ▸ Zoom In/Out/Actual Size. A role's items can't be removed
  // individually, so the whole role is replaced with the standard window controls minus zoom:
  // Minimize + Close on Win/Linux, Minimize + Bring All to Front on macOS.
  template.push({
    label: 'Window',
    submenu: [
      { role: 'minimize' },
      ...(mac
        ? ([{ type: 'separator' }, { role: 'front' }] as MenuItemConstructorOptions[])
        : ([{ role: 'close' }] as MenuItemConstructorOptions[])),
    ],
  });

  // Help (M06.E): About shows the version + AI-assistance disclosure (no update affordance —
  // ADR-0023); Open Logs Folder reveals the findable main.log directory. A plain submenu (not
  // role:'help') so the two custom items read identically on Windows and macOS.
  template.push({
    label: 'Help',
    submenu: [
      { label: 'About MeetingSpace', click: () => commands.showAbout() },
      { label: 'Open Logs Folder', click: () => commands.openLogs() },
    ],
  });

  return template;
}
