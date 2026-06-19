// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { FullScreenToast } from '../../src/components/FullScreenToast';
import { ToastHost } from '../../src/components/ToastHost';
import { ToastProvider } from '../../src/hooks/useToasts';

/*
 * Full-screen exit affordance (M06.A IRL fix). Entering full screen hides the menu bar, so a
 * user who doesn't know F11 is effectively trapped. On entering full screen we raise a
 * persistent app-level toast with a visible Exit control; it auto-clears on leaving full
 * screen. Driven here with a fake app client that emits the main-process full-screen events.
 */
function fakeClient(): {
  client: {
    onFullScreenChange: (l: (full: boolean) => void) => () => void;
    exitFullScreen: () => void;
  };
  emit(full: boolean): void;
  exitFullScreen: ReturnType<typeof vi.fn>;
} {
  let listener: ((full: boolean) => void) | null = null;
  const exitFullScreen = vi.fn();
  return {
    client: {
      onFullScreenChange: (l) => {
        listener = l;
        return () => {
          listener = null;
        };
      },
      exitFullScreen,
    },
    emit: (full) => listener?.(full),
    exitFullScreen,
  };
}

function renderToast(f: ReturnType<typeof fakeClient>) {
  return render(
    <ToastProvider>
      <FullScreenToast client={f.client} />
      <ToastHost />
    </ToastProvider>,
  );
}

describe('FullScreenToast', () => {
  it('raises a persistent toast with an Exit control on entering full screen', () => {
    const f = fakeClient();
    renderToast(f);

    act(() => f.emit(true));

    expect(screen.getByText(/press F11/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /exit full screen/i })).toBeInTheDocument();
  });

  it('exits full screen when the toast Exit control is clicked', async () => {
    const user = userEvent.setup();
    const f = fakeClient();
    renderToast(f);
    act(() => f.emit(true));

    await user.click(screen.getByRole('button', { name: /exit full screen/i }));

    expect(f.exitFullScreen).toHaveBeenCalledOnce();
  });

  it('clears the toast on leaving full screen', () => {
    const f = fakeClient();
    renderToast(f);
    act(() => f.emit(true));
    expect(screen.getByText(/press F11/i)).toBeInTheDocument();

    act(() => f.emit(false));

    expect(screen.queryByText(/press F11/i)).not.toBeInTheDocument();
  });
});
