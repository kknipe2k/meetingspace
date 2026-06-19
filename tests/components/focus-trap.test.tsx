// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Modal } from '../../src/components/Modal';

// The shared modal primitive that resolves M02 Finding 1 (Lightbox/CapturePicker
// over-claimed "focus trap" — initial focus + Esc but no Tab containment). Modal
// (via useFocusTrap) contains Tab/Shift-Tab within the dialog and restores focus
// to the opener on close. Lightbox, CapturePicker, and SettingsModal all consume it.
function twoButtonModal(onClose = vi.fn()): { onClose: ReturnType<typeof vi.fn> } {
  render(
    <Modal label="Test dialog" className="test-modal" scrimTestId="test-scrim" onClose={onClose}>
      <button type="button">first</button>
      <button type="button">last</button>
    </Modal>,
  );
  return { onClose };
}

describe('Modal focus-trap', () => {
  it('renders a labelled dialog through a portal at document.body', () => {
    twoButtonModal();

    const dialog = screen.getByRole('dialog', { name: 'Test dialog' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByTestId('test-scrim').parentElement).toBe(document.body);
  });

  it('moves initial focus into the dialog (first focusable) on open', () => {
    twoButtonModal();

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'first' }));
  });

  it('Tab from the last focusable wraps to the first (contained)', () => {
    twoButtonModal();
    const first = screen.getByRole('button', { name: 'first' });
    const last = screen.getByRole('button', { name: 'last' });
    last.focus();

    fireEvent.keyDown(last, { key: 'Tab' });

    expect(document.activeElement).toBe(first);
  });

  it('Shift+Tab from the first focusable wraps to the last (contained)', () => {
    twoButtonModal();
    const first = screen.getByRole('button', { name: 'first' });
    const last = screen.getByRole('button', { name: 'last' });
    first.focus();

    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });

    expect(document.activeElement).toBe(last);
  });

  it('closes on Escape', () => {
    const { onClose } = twoButtonModal();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a scrim click but not on a click inside the dialog', () => {
    const { onClose } = twoButtonModal();

    fireEvent.click(screen.getByRole('button', { name: 'first' }));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('test-scrim'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('restores focus to the opener when the modal unmounts', async () => {
    const user = userEvent.setup();
    function Harness(): ReactElement {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            open
          </button>
          {open && (
            <Modal label="Test dialog" className="test-modal" onClose={() => setOpen(false)}>
              <button type="button">inside</button>
            </Modal>
          )}
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'open' });
    await user.click(opener);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'inside' }));

    await user.keyboard('{Escape}');

    expect(document.activeElement).toBe(opener);
  });
});
