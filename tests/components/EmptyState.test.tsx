// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { EmptyState } from '../../src/components/EmptyState';

/*
 * The reusable empty-state primitive (M05.A). Token-driven headline + optional hint +
 * optional single action, reused across the no-session / no-notes / no-screenshots
 * surfaces. Spec: docs/design-specs/M05A-states.md §0.
 */
describe('EmptyState', () => {
  it('renders the headline and hint', () => {
    render(<EmptyState headline="No sessions yet" hint="Create one to start." />);
    expect(screen.getByText('No sessions yet')).toBeInTheDocument();
    expect(screen.getByText('Create one to start.')).toBeInTheDocument();
  });

  it('renders an action button and fires its onClick', () => {
    const onClick = vi.fn();
    render(<EmptyState headline="No sessions yet" action={{ label: 'New session', onClick }} />);
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders no button when there is no action', () => {
    render(<EmptyState headline="No notes yet" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('is exposed as a non-alarming note region', () => {
    render(<EmptyState headline="No session selected" />);
    expect(screen.getByTestId('empty-state')).toHaveAttribute('role', 'note');
  });
});
