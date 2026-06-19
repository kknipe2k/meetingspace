import { describe, expect, it, vi } from 'vitest';

import {
  buildContextMenuTemplate,
  type ContextMenuActions,
  type ContextMenuParams,
} from '../../electron/context-menu';

/*
 * The right-click context menu (M06.A; REVIEW-V11 F2). The TEMPLATE is a pure seam that maps
 * the Electron `context-menu` event's params (editFlags / mediaType / dictionarySuggestions)
 * onto an editFlags-aware cut/copy/paste/select-all menu, spellcheck suggestions, and
 * copy-image on images — so the mapping is Node-unit-testable; the popup() call is the thin
 * wrapper in electron/main.ts.
 */
function params(overrides: Partial<ContextMenuParams> = {}): ContextMenuParams {
  return {
    isEditable: false,
    editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: true },
    mediaType: 'none',
    dictionarySuggestions: [],
    selectionText: '',
    ...overrides,
  };
}

function actions(): ContextMenuActions {
  return { replaceMisspelling: vi.fn(), copyImage: vi.fn() };
}

describe('buildContextMenuTemplate', () => {
  it('maps editFlags onto enabled cut/copy/paste in an editable field', () => {
    const template = buildContextMenuTemplate(
      params({
        isEditable: true,
        editFlags: { canCut: true, canCopy: true, canPaste: false, canSelectAll: true },
      }),
      actions(),
    );
    const byRole = (role: string): boolean | undefined =>
      template.find((item) => item.role === role)?.enabled;

    expect(byRole('cut')).toBe(true);
    expect(byRole('copy')).toBe(true);
    expect(byRole('paste')).toBe(false);
    expect(template.some((item) => item.role === 'selectAll')).toBe(true);
  });

  it('offers copy (no paste) on a non-editable selection', () => {
    const template = buildContextMenuTemplate(
      params({
        isEditable: false,
        selectionText: 'hello',
        editFlags: { canCut: false, canCopy: true, canPaste: true, canSelectAll: true },
      }),
      actions(),
    );

    expect(template.some((item) => item.role === 'copy')).toBe(true);
    expect(template.some((item) => item.role === 'paste')).toBe(false);
  });

  it('adds a Copy Image item that calls the injected action on an image', () => {
    const a = actions();
    const template = buildContextMenuTemplate(params({ mediaType: 'image' }), a);
    const copyImage = template.find((item) => item.label === 'Copy Image');

    expect(copyImage).toBeDefined();
    copyImage?.click?.({} as never, undefined as never, {} as never);
    expect(a.copyImage).toHaveBeenCalledOnce();
  });

  it('separates Copy Image from the copy item when a copyable image is right-clicked', () => {
    const template = buildContextMenuTemplate(
      params({
        mediaType: 'image',
        editFlags: { canCut: false, canCopy: true, canPaste: false, canSelectAll: false },
      }),
      actions(),
    );
    const copyImageIndex = template.findIndex((item) => item.label === 'Copy Image');

    expect(template.some((item) => item.role === 'copy')).toBe(true);
    expect(copyImageIndex).toBeGreaterThan(0);
    expect(template[copyImageIndex - 1]?.type).toBe('separator');
  });

  it('lists spellcheck suggestions that replace the misspelling when clicked', () => {
    const a = actions();
    const template = buildContextMenuTemplate(
      params({ isEditable: true, dictionarySuggestions: ['recieve', 'receive'] }),
      a,
    );
    const suggestion = template.find((item) => item.label === 'receive');

    expect(template.find((item) => item.label === 'recieve')).toBeDefined();
    suggestion?.click?.({} as never, undefined as never, {} as never);
    expect(a.replaceMisspelling).toHaveBeenCalledWith('receive');
  });

  it('shows no suggestions when the field is not editable even if the params carry some', () => {
    const template = buildContextMenuTemplate(
      params({ isEditable: false, dictionarySuggestions: ['recieve'] }),
      actions(),
    );

    expect(template.find((item) => item.label === 'recieve')).toBeUndefined();
  });
});
