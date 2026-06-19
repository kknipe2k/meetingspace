// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ErrorState } from '../../src/components/ErrorState';

/*
 * The reusable inline error affordance (M05.A) over the M03 typed taxonomy — NO new
 * error model. Mirrors the isKeyError split already in ChatPanel/GeneratedDocView:
 * AUTH/NO_KEY → Open Settings; everything else → Retry. Non-LLM (storage/search) callers
 * omit `code` and pass onRetry → a plain Retry. Spec: docs/design-specs/M05A-states.md §0.
 */
describe('ErrorState', () => {
  it('shows the message as an alert', () => {
    render(<ErrorState message="Couldn't load your sessions." />);
    const region = screen.getByTestId('error-state');
    expect(region).toHaveAttribute('role', 'alert');
    expect(screen.getByText("Couldn't load your sessions.")).toBeInTheDocument();
  });

  it('offers Retry for a code-less (storage/search) failure', () => {
    const onRetry = vi.fn();
    render(<ErrorState message="Search failed." onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Open Settings' })).toBeNull();
  });

  it('routes AUTH to Open Settings (not Retry)', () => {
    const onOpenSettings = vi.fn();
    const onRetry = vi.fn();
    render(
      <ErrorState
        message="Authentication failed."
        code="AUTH"
        onOpenSettings={onOpenSettings}
        onRetry={onRetry}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('routes NO_KEY to Open Settings', () => {
    const onOpenSettings = vi.fn();
    render(<ErrorState message="No API key." code="NO_KEY" onOpenSettings={onOpenSettings} />);
    expect(screen.getByRole('button', { name: 'Open Settings' })).toBeInTheDocument();
  });

  it('offers Retry for a transient code (TIMEOUT_CEILING)', () => {
    const onRetry = vi.fn();
    render(<ErrorState message="Timed out." code="TIMEOUT_CEILING" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Open Settings' })).toBeNull();
  });

  it('falls back to Retry when AUTH has no onOpenSettings handler', () => {
    const onRetry = vi.fn();
    render(<ErrorState message="Auth failed." code="AUTH" onRetry={onRetry} />);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Settings' })).toBeNull();
  });
});
