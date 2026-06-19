import { describe, expect, it, vi } from 'vitest';

import type { MenuItemConstructorOptions } from 'electron';

import { buildAppMenuTemplate, type AppMenuCommands } from '../../electron/menu';

/*
 * The native application menu (M06.A; REVIEW-V11 F1/F30). The TEMPLATE is a pure seam —
 * it returns MenuItemConstructorOptions[] with no Electron runtime call, so the load-bearing
 * invariants are Node-unit-testable: clipboard/zoom roles are always present (so building a
 * real menu never loses the macOS clipboard accelerators the default menu used to provide),
 * and DevTools/Reload are OMITTED when app.isPackaged. The thin Menu.buildFromTemplate +
 * setApplicationMenu call lives in electron/main.ts (coverage-excluded wrapper).
 */
function noopCommands(): AppMenuCommands {
  return {
    newSession: vi.fn(),
    focusSearch: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    zoomReset: vi.fn(),
    setTheme: vi.fn(),
    showAbout: vi.fn(),
    openLogs: vi.fn(),
  };
}

// Recursively collect every item's `role` across the whole template tree.
function collectRoles(items: readonly MenuItemConstructorOptions[]): string[] {
  const roles: string[] = [];
  for (const item of items) {
    if (typeof item.role === 'string') {
      roles.push(item.role);
    }
    if (Array.isArray(item.submenu)) {
      roles.push(...collectRoles(item.submenu));
    }
  }
  return roles;
}

// Find the first item with a given label across the tree.
function findByLabel(
  items: readonly MenuItemConstructorOptions[],
  label: string,
): MenuItemConstructorOptions | undefined {
  for (const item of items) {
    if (item.label === label) {
      return item;
    }
    if (Array.isArray(item.submenu)) {
      const found = findByLabel(item.submenu, label);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

const DEV_ROLES = ['toggleDevTools', 'reload', 'forceReload'];

describe('buildAppMenuTemplate', () => {
  it('always includes the clipboard roles (so a real menu preserves the accelerators the default menu provided)', () => {
    const roles = collectRoles(
      buildAppMenuTemplate({ platform: 'win32', isPackaged: true, commands: noopCommands() }),
    );

    for (const role of ['cut', 'copy', 'paste', 'selectAll', 'undo', 'redo']) {
      expect(roles).toContain(role);
    }
  });

  it('always includes the zoom and fullscreen/window roles', () => {
    const template = buildAppMenuTemplate({
      platform: 'win32',
      isPackaged: true,
      commands: noopCommands(),
    });
    const roles = collectRoles(template);

    expect(roles).toContain('togglefullscreen');
    expect(roles).toContain('windowMenu');
    expect(findByLabel(template, 'Zoom In')).toBeDefined();
    expect(findByLabel(template, 'Zoom Out')).toBeDefined();
    expect(findByLabel(template, 'Actual Size')).toBeDefined();
  });

  it('OMITS DevTools and Reload when packaged (F1/F30 — the mutation pin)', () => {
    const roles = collectRoles(
      buildAppMenuTemplate({ platform: 'win32', isPackaged: true, commands: noopCommands() }),
    );

    for (const role of DEV_ROLES) {
      expect(roles).not.toContain(role);
    }
  });

  it('INCLUDES DevTools and Reload when NOT packaged (dev affordance)', () => {
    const roles = collectRoles(
      buildAppMenuTemplate({ platform: 'win32', isPackaged: false, commands: noopCommands() }),
    );

    for (const role of DEV_ROLES) {
      expect(roles).toContain(role);
    }
  });

  it('puts the macOS app menu first only on darwin', () => {
    const mac = buildAppMenuTemplate({
      platform: 'darwin',
      isPackaged: true,
      commands: noopCommands(),
    });
    const win = buildAppMenuTemplate({
      platform: 'win32',
      isPackaged: true,
      commands: noopCommands(),
    });

    expect(mac[0]?.role).toBe('appMenu');
    expect(collectRoles(win)).not.toContain('appMenu');
  });

  it('does not register an accelerator for Find / New Session (the renderer owns the keypress — no double-fire)', () => {
    const template = buildAppMenuTemplate({
      platform: 'win32',
      isPackaged: true,
      commands: noopCommands(),
    });

    expect(findByLabel(template, 'Find…')?.registerAccelerator).toBe(false);
    expect(findByLabel(template, 'New Session')?.registerAccelerator).toBe(false);
  });

  it('offers a View ▸ Appearance theme submenu wired to setTheme (M06.A IRL fix)', () => {
    const commands = noopCommands();
    const template = buildAppMenuTemplate({ platform: 'win32', isPackaged: true, commands });

    for (const label of ['System', 'Light', 'Dark']) {
      expect(findByLabel(template, label)).toBeDefined();
    }
    findByLabel(template, 'Light')?.click?.({} as never, undefined as never, {} as never);
    expect(commands.setTheme).toHaveBeenCalledWith('light');
  });

  it('offers Help ▸ About + Open Logs Folder wired to the injected commands (M06.E)', () => {
    const commands = noopCommands();
    const template = buildAppMenuTemplate({ platform: 'win32', isPackaged: true, commands });

    const about = findByLabel(template, 'About MeetingSpace');
    const logs = findByLabel(template, 'Open Logs Folder');
    expect(about).toBeDefined();
    expect(logs).toBeDefined();

    about?.click?.({} as never, undefined as never, {} as never);
    logs?.click?.({} as never, undefined as never, {} as never);
    expect(commands.showAbout).toHaveBeenCalledOnce();
    expect(commands.openLogs).toHaveBeenCalledOnce();
  });

  it('has NO "Check for Updates" affordance — auto-update is deferred (ADR-0023)', () => {
    const template = buildAppMenuTemplate({
      platform: 'win32',
      isPackaged: true,
      commands: noopCommands(),
    });
    const labels: string[] = [];
    const walk = (items: readonly MenuItemConstructorOptions[]): void => {
      for (const item of items) {
        if (typeof item.label === 'string') {
          labels.push(item.label);
        }
        if (Array.isArray(item.submenu)) {
          walk(item.submenu);
        }
      }
    };
    walk(template);
    expect(labels.some((l) => /update/i.test(l))).toBe(false);
  });

  it('routes the New Session / Find / Zoom clicks to the injected commands', () => {
    const commands = noopCommands();
    const template = buildAppMenuTemplate({ platform: 'win32', isPackaged: true, commands });

    findByLabel(template, 'New Session')?.click?.({} as never, undefined as never, {} as never);
    findByLabel(template, 'Find…')?.click?.({} as never, undefined as never, {} as never);
    findByLabel(template, 'Zoom In')?.click?.({} as never, undefined as never, {} as never);
    findByLabel(template, 'Zoom Out')?.click?.({} as never, undefined as never, {} as never);
    findByLabel(template, 'Actual Size')?.click?.({} as never, undefined as never, {} as never);

    expect(commands.newSession).toHaveBeenCalledOnce();
    expect(commands.focusSearch).toHaveBeenCalledOnce();
    expect(commands.zoomIn).toHaveBeenCalledOnce();
    expect(commands.zoomOut).toHaveBeenCalledOnce();
    expect(commands.zoomReset).toHaveBeenCalledOnce();
  });
});
