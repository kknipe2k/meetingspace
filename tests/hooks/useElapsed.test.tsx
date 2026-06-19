// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatElapsed, useElapsed } from '../../src/hooks/useElapsed';

/*
 * D-01 — the elapsed-time counter behind the expectation toast (replaces the M04.C 12s
 * boolean alarm). While `active`, it ticks the elapsed milliseconds (~1s granularity)
 * so the UI can show a calm persistent "Generating — this can take 5+ minutes" + a live
 * counter; it resets to 0 the moment streaming ends, so a normal-speed response shows
 * nothing meaningful and a re-run starts from zero.
 */
describe('useElapsed', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts at 0 and ticks up while active', () => {
    const { result } = renderHook(() => useElapsed(true));
    expect(result.current).toBe(0);

    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBeGreaterThanOrEqual(1000);

    act(() => vi.advanceTimersByTime(2000));
    expect(result.current).toBeGreaterThanOrEqual(3000);
  });

  it('stays at 0 while inactive', () => {
    const { result } = renderHook(() => useElapsed(false));
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current).toBe(0);
  });

  it('resets to 0 when streaming ends', () => {
    const { result, rerender } = renderHook(({ active }) => useElapsed(active), {
      initialProps: { active: true },
    });
    act(() => vi.advanceTimersByTime(3000));
    expect(result.current).toBeGreaterThanOrEqual(3000);

    rerender({ active: false });
    expect(result.current).toBe(0);
  });
});

describe('formatElapsed', () => {
  it('formats milliseconds as m:ss with a zero-padded seconds field', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(9_000)).toBe('0:09');
    expect(formatElapsed(83_000)).toBe('1:23');
    expect(formatElapsed(600_000)).toBe('10:00');
  });
});
