// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAutosave } from '../../src/hooks/useAutosave';

// Fake timers let us assert the debounce boundary precisely without sleeping.
const DELAY = 500;

describe('useAutosave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not save the initial value (mounting is not an edit)', () => {
    const save = vi.fn();

    renderHook(() => useAutosave('hello', save, { delayMs: DELAY }));
    act(() => vi.advanceTimersByTime(DELAY * 2));

    expect(save).not.toHaveBeenCalled();
  });

  it('collapses rapid edits into a single trailing save with the last value', () => {
    const save = vi.fn();
    const { rerender } = renderHook(({ value }) => useAutosave(value, save, { delayMs: DELAY }), {
      initialProps: { value: '' },
    });

    rerender({ value: 'h' });
    act(() => vi.advanceTimersByTime(200));
    rerender({ value: 'he' });
    act(() => vi.advanceTimersByTime(200));
    rerender({ value: 'hel' });
    act(() => vi.advanceTimersByTime(DELAY));

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('hel');
  });

  it('does not fire until the full quiet period has elapsed', () => {
    const save = vi.fn();
    const { rerender } = renderHook(({ value }) => useAutosave(value, save, { delayMs: DELAY }), {
      initialProps: { value: '' },
    });

    rerender({ value: 'a' });
    act(() => vi.advanceTimersByTime(DELAY - 1));
    expect(save).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('saves an emptied value (clearing the note) without error', () => {
    const save = vi.fn();
    const { rerender } = renderHook(({ value }) => useAutosave(value, save, { delayMs: DELAY }), {
      initialProps: { value: 'draft' },
    });

    rerender({ value: '' });
    act(() => vi.advanceTimersByTime(DELAY));

    expect(save).toHaveBeenCalledWith('');
  });

  it('does not save when an edit is reverted to the saved baseline before firing', () => {
    const save = vi.fn();
    const { rerender } = renderHook(({ value }) => useAutosave(value, save, { delayMs: DELAY }), {
      initialProps: { value: 'saved' },
    });

    rerender({ value: 'saved edit' });
    act(() => vi.advanceTimersByTime(200));
    rerender({ value: 'saved' }); // reverted within the quiet window
    act(() => vi.advanceTimersByTime(DELAY));

    expect(save).not.toHaveBeenCalled();
  });

  it('flushes a pending edit on unmount (switching sessions inside the window)', () => {
    // V-2: the edit is made, then the component unmounts BEFORE the debounce fires.
    // Without the unmount flush this write is silently dropped — the data-loss bug.
    const save = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ value }) => useAutosave(value, save, { delayMs: DELAY }),
      { initialProps: { value: 'saved' } },
    );

    rerender({ value: 'unsaved edit' });
    act(() => vi.advanceTimersByTime(200)); // still inside the 500ms window
    expect(save).not.toHaveBeenCalled();

    act(() => unmount());

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('unsaved edit');
  });

  it('flush() writes the pending edit immediately and cancels the debounce', () => {
    // The returned flush is what NoteBlock wires to onBlur.
    const save = vi.fn();
    const { result, rerender } = renderHook(
      ({ value }) => useAutosave(value, save, { delayMs: DELAY }),
      { initialProps: { value: 'saved' } },
    );

    rerender({ value: 'blurred edit' });
    act(() => result.current()); // blur
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('blurred edit');

    // The debounce that was in flight must not fire a second, duplicate save.
    act(() => vi.advanceTimersByTime(DELAY));
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('flush() is a no-op when nothing is pending', () => {
    const save = vi.fn();
    const { result } = renderHook(() => useAutosave('hello', save, { delayMs: DELAY }));

    act(() => result.current());

    expect(save).not.toHaveBeenCalled();
  });

  it('flush() does not resurrect an edit that was reverted to the baseline', () => {
    const save = vi.fn();
    const { result, rerender } = renderHook(
      ({ value }) => useAutosave(value, save, { delayMs: DELAY }),
      { initialProps: { value: 'saved' } },
    );

    rerender({ value: 'saved edit' });
    act(() => vi.advanceTimersByTime(200));
    rerender({ value: 'saved' }); // reverted within the window
    act(() => result.current()); // blur

    expect(save).not.toHaveBeenCalled();
  });

  it('flushes synchronously on pagehide when an edit is pending (edit-then-quit, D-03)', () => {
    // pagehide is the real teardown signal on app quit; the sync path is what makes
    // the write land before the window closes (saveSync, not the async save).
    const save = vi.fn();
    const saveSync = vi.fn();
    const { rerender } = renderHook(
      ({ value }) => useAutosave(value, save, { delayMs: DELAY, saveSync }),
      { initialProps: { value: 'saved' } },
    );

    rerender({ value: 'edit before quit' });
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });

    expect(saveSync).toHaveBeenCalledTimes(1);
    expect(saveSync).toHaveBeenCalledWith('edit before quit');
    expect(save).not.toHaveBeenCalled(); // the sync path took it, not the async one
  });

  it('does not flush on pagehide when nothing is pending', () => {
    const save = vi.fn();
    const saveSync = vi.fn();
    renderHook(() => useAutosave('saved', save, { delayMs: DELAY, saveSync }));

    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });

    expect(saveSync).not.toHaveBeenCalled();
  });

  it('flushes asynchronously on visibilitychange→hidden (minimize/tab-away, not sync)', () => {
    // visibilitychange also fires on ordinary minimize; a sync write every minimize
    // is wasteful, so the hidden transition uses the async flush, not saveSync.
    const save = vi.fn();
    const saveSync = vi.fn();
    const { rerender } = renderHook(
      ({ value }) => useAutosave(value, save, { delayMs: DELAY, saveSync }),
      { initialProps: { value: 'saved' } },
    );

    rerender({ value: 'edit before minimize' });
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('edit before minimize');
    expect(saveSync).not.toHaveBeenCalled();
  });

  it('does not flush on visibilitychange→visible', () => {
    const save = vi.fn();
    const { rerender } = renderHook(({ value }) => useAutosave(value, save, { delayMs: DELAY }), {
      initialProps: { value: 'saved' },
    });

    rerender({ value: 'still typing' });
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(save).not.toHaveBeenCalled();
  });

  it('falls back to the async save on pagehide when no saveSync is provided', () => {
    const save = vi.fn();
    const { rerender } = renderHook(({ value }) => useAutosave(value, save, { delayMs: DELAY }), {
      initialProps: { value: 'saved' },
    });

    rerender({ value: 'edit' });
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });

    expect(save).toHaveBeenCalledWith('edit');
  });

  it('adopts the loaded value as baseline on enable, then saves later edits', () => {
    const save = vi.fn();
    const { rerender } = renderHook(
      ({ value, enabled }) => useAutosave(value, save, { delayMs: DELAY, enabled }),
      { initialProps: { value: '', enabled: false } },
    );

    // The async load arrives: content + enabled flip together (batched).
    rerender({ value: 'loaded note', enabled: true });
    act(() => vi.advanceTimersByTime(DELAY));
    expect(save).not.toHaveBeenCalled();

    rerender({ value: 'loaded note!', enabled: true });
    act(() => vi.advanceTimersByTime(DELAY));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('loaded note!');
  });
});
