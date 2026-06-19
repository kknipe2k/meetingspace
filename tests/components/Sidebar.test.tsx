// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { Session } from '@shared/types';

import { Sidebar } from '../../src/components/Sidebar';

function session(id: string, name: string): Session {
  return { id, spaceId: 'space-default', name, createdAt: 1, updatedAt: 1 };
}

const SESSIONS = [session('s1', 'Design review'), session('s2', 'Roadmap')];

function setup(overrides: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  const props = {
    sessions: SESSIONS,
    selectedId: null as string | null,
    onSelect: vi.fn(),
    onCreate: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
  render(<Sidebar {...props} />);
  return { props, user: userEvent.setup() };
}

describe('Sidebar', () => {
  it('renders one selectable item per session', () => {
    setup();

    expect(screen.getByRole('button', { name: 'Design review' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Roadmap' })).toBeInTheDocument();
  });

  it('marks the selected session with aria-current', () => {
    setup({ selectedId: 's1' });

    expect(screen.getByRole('button', { name: 'Design review' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Roadmap' })).not.toHaveAttribute('aria-current');
  });

  it('calls onSelect with the session id when an item is clicked', async () => {
    const { props, user } = setup();

    await user.click(screen.getByRole('button', { name: 'Design review' }));

    expect(props.onSelect).toHaveBeenCalledWith('s1');
  });

  it('calls onCreate when New session is clicked', async () => {
    const { props, user } = setup();

    await user.click(screen.getByRole('button', { name: /new session/i }));

    expect(props.onCreate).toHaveBeenCalledTimes(1);
  });

  it('commits a rename through the inline editor', async () => {
    const { props, user } = setup({ selectedId: 's1' });

    await user.click(screen.getByRole('button', { name: 'Rename Design review' }));
    const input = screen.getByRole('textbox', { name: /session name/i });
    await user.clear(input);
    await user.type(input, 'Architecture review{Enter}');

    expect(props.onRename).toHaveBeenCalledWith('s1', 'Architecture review');
  });

  // M06.B (F10): delete is immediate-with-Undo — no destructive confirm step. The parent (App)
  // removes the session optimistically and offers an Undo toast; Sidebar just reports the click.
  it('calls onDelete immediately on Delete (no confirm step)', async () => {
    const { props, user } = setup({ selectedId: 's2' });

    await user.click(screen.getByRole('button', { name: 'Delete Roadmap' }));

    expect(props.onDelete).toHaveBeenCalledWith('s2');
    // No confirm affordance is rendered.
    expect(screen.queryByRole('button', { name: /confirm/i })).toBeNull();
  });

  it('commits a rename on blur', async () => {
    const { props, user } = setup({ selectedId: 's1' });

    await user.click(screen.getByRole('button', { name: 'Rename Design review' }));
    const input = screen.getByRole('textbox', { name: /session name/i });
    await user.clear(input);
    await user.type(input, 'Kickoff');
    await user.tab();

    expect(props.onRename).toHaveBeenCalledWith('s1', 'Kickoff');
  });

  it('discards a rename on Escape without calling onRename', async () => {
    const { props, user } = setup({ selectedId: 's1' });

    await user.click(screen.getByRole('button', { name: 'Rename Design review' }));
    const input = screen.getByRole('textbox', { name: /session name/i });
    await user.clear(input);
    await user.type(input, 'Throwaway{Escape}');

    expect(props.onRename).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Design review' })).toBeInTheDocument();
  });
});
