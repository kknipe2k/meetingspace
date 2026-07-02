import { describe, expect, it, vi } from 'vitest';

import type { AppCommand } from '@shared/types';

import { APP_CHANNELS } from '../../electron/ipc/channels';
import { createAppApi } from '../../electron/ipc/app-bridge';

/*
 * The renderer-facing app-command bridge (M06.A). Native-menu items the renderer must service
 * — Find (focus search), New Session — fire main→renderer over app:command; this bridge maps
 * that subscription onto the typed `app.onCommand(listener)` surface (no key, no DB handle).
 * Pure and transport-agnostic so the mapping is Node-unit-testable, leaving preload.ts thin.
 */
function fakeTransport(): {
  transport: {
    on: (channel: string, listener: (payload: unknown) => void) => () => void;
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  };
  emit: (channel: string, payload: unknown) => void;
  listenerCount: (channel: string) => number;
  invokes: Array<{ channel: string; args: unknown[] }>;
} {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const invokes: Array<{ channel: string; args: unknown[] }> = [];
  return {
    invokes,
    transport: {
      on: (channel, listener) => {
        const set = listeners.get(channel) ?? new Set();
        set.add(listener);
        listeners.set(channel, set);
        return () => set.delete(listener);
      },
      invoke: (channel, ...args) => {
        invokes.push({ channel, args });
        return Promise.resolve(undefined);
      },
    },
    emit: (channel, payload) => {
      for (const listener of listeners.get(channel) ?? []) {
        listener(payload);
      }
    },
    listenerCount: (channel) => listeners.get(channel)?.size ?? 0,
  };
}

describe('createAppApi', () => {
  it('exposes exactly the onCommand, onFullScreenChange, exitFullScreen, and openPricingDocs methods', () => {
    expect(Object.keys(createAppApi(fakeTransport().transport)).sort()).toEqual([
      'exitFullScreen',
      'onCommand',
      'onFullScreenChange',
      'openPricingDocs',
    ]);
  });

  it('delivers app:command payloads to the listener', () => {
    const f = fakeTransport();
    const seen: AppCommand[] = [];
    createAppApi(f.transport).onCommand((command) => seen.push(command));

    f.emit(APP_CHANNELS.command, 'find');
    f.emit(APP_CHANNELS.command, 'theme:dark');

    expect(seen).toEqual(['find', 'theme:dark']);
  });

  it('delivers full-screen change events to the listener', () => {
    const f = fakeTransport();
    const seen: boolean[] = [];
    createAppApi(f.transport).onFullScreenChange((full) => seen.push(full));

    f.emit(APP_CHANNELS.fullScreenChange, true);
    f.emit(APP_CHANNELS.fullScreenChange, false);

    expect(seen).toEqual([true, false]);
  });

  it('invokes the exit-full-screen channel on exitFullScreen()', () => {
    const f = fakeTransport();
    createAppApi(f.transport).exitFullScreen();

    expect(f.invokes).toEqual([{ channel: APP_CHANNELS.exitFullScreen, args: [] }]);
  });

  it('invokes the argument-less open-pricing-docs channel on openPricingDocs() (M10.B ext#2)', () => {
    const f = fakeTransport();
    createAppApi(f.transport).openPricingDocs();

    // No renderer-supplied argument — the URL is chosen main-side.
    expect(f.invokes).toEqual([{ channel: APP_CHANNELS.openPricingDocs, args: [] }]);
  });

  it('unsubscribes when the returned dispose is called', () => {
    const f = fakeTransport();
    const off = createAppApi(f.transport).onCommand(vi.fn());

    expect(f.listenerCount(APP_CHANNELS.command)).toBe(1);
    off();
    expect(f.listenerCount(APP_CHANNELS.command)).toBe(0);
  });
});
