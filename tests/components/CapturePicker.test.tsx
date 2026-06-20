// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CaptureSourcesResult } from '@shared/types';

import { CapturePicker } from '../../src/components/CapturePicker';

function granted(): CaptureSourcesResult {
  return {
    permission: 'granted',
    sources: [
      { id: 'screen:0', name: 'Entire screen', preview: 'data:image/png;base64,AAA' },
      { id: 'window:7', name: 'Editor window', preview: 'data:image/png;base64,BBB' },
    ],
  };
}

function denied(): CaptureSourcesResult {
  return { permission: 'denied', sources: [] };
}

describe('CapturePicker', () => {
  it('lists the capturable sources and picks one on click', () => {
    const onPick = vi.fn();
    render(<CapturePicker result={granted()} onPick={onPick} onClose={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Editor window' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Entire screen' }));

    expect(onPick).toHaveBeenCalledWith('screen:0');
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<CapturePicker result={granted()} onPick={vi.fn()} onClose={onClose} />);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a click outside the dialog (the scrim)', () => {
    const onClose = vi.fn();
    render(<CapturePicker result={granted()} onPick={vi.fn()} onClose={onClose} />);

    const scrim = screen.getByTestId('capture-scrim');
    fireEvent.mouseDown(scrim);
    fireEvent.click(scrim);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the guided permission error and no source buttons when capture is not granted', () => {
    const onPick = vi.fn();
    render(<CapturePicker result={denied()} onPick={onPick} onClose={vi.fn()} />);

    expect(screen.getByText(/screen recording/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Entire screen' })).not.toBeInTheDocument();
  });

  // M02 Finding 1 closed on the real component: it inherits the shared focus-trap,
  // so Tab is CONTAINED within the dialog (it previously did initial-focus + Esc
  // but let Tab walk out behind the scrim).
  it('contains Tab within the dialog (inherits the shared focus-trap)', () => {
    render(<CapturePicker result={granted()} onPick={vi.fn()} onClose={vi.fn()} />);
    const buttons = within(screen.getByRole('dialog')).getAllByRole('button');
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (!first || !last) {
      throw new Error('expected the two source buttons plus Cancel');
    }
    last.focus();

    fireEvent.keyDown(last, { key: 'Tab' });

    expect(document.activeElement).toBe(first);
  });
});
