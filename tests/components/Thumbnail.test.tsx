// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Asset } from '@shared/types';

import { Thumbnail } from '../../src/components/Thumbnail';

function asset(id = 'shot1', sessionId = 's1'): Asset {
  return {
    id,
    sessionId,
    kind: 'screenshot',
    relativePath: `${sessionId}/${id}.png`,
    createdAt: 1,
  };
}

// The thumbnail expands into the Lightbox on click and exposes a delete control.
// The guarded invariant: clicking delete must NOT also open the lightbox.
describe('Thumbnail', () => {
  it('renders the lazy-loaded DOWNSCALED thumbnail derivative in the grid (F25)', () => {
    render(<Thumbnail asset={asset()} index={1} onDelete={() => {}} />);

    const img = screen.getByRole('img', { name: 'Screenshot 1' });
    // The grid shows the sibling .thumb.jpg, not the full-res image.
    expect(img).toHaveAttribute('src', 'asset://s1/shot1.thumb.jpg');
    expect(img).toHaveAttribute('loading', 'lazy');
  });

  it('falls back to the full-res image when the thumbnail is missing (pre-M06.C asset / decode fail)', () => {
    render(<Thumbnail asset={asset()} index={1} onDelete={() => {}} />);

    const img = screen.getByRole('img', { name: 'Screenshot 1' });
    expect(img).toHaveAttribute('src', 'asset://s1/shot1.thumb.jpg');
    fireEvent.error(img); // the thumb file 404s
    expect(img).toHaveAttribute('src', 'asset://s1/shot1.png');
    // A second error on the full image does not loop back to the thumb.
    fireEvent.error(img);
    expect(img).toHaveAttribute('src', 'asset://s1/shot1.png');
  });

  it('opens the lightbox with the full-size image when the thumbnail is clicked', () => {
    render(<Thumbnail asset={asset()} index={1} onDelete={() => {}} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand screenshot 1' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    // The same asset:// path the thumbnail uses, now served full-size in the overlay.
    expect(
      screen.getAllByRole('img').some((img) => img.getAttribute('src') === 'asset://s1/shot1.png'),
    ).toBe(true);
  });

  it('deletes without opening the lightbox (the delete control is not hijacked by expand)', () => {
    const onDelete = vi.fn();
    render(<Thumbnail asset={asset()} index={1} onDelete={onDelete} />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete screenshot 1' }));

    expect(onDelete).toHaveBeenCalledWith('shot1');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
