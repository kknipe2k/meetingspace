import { describe, expect, it, vi } from 'vitest';

import { CAPTURE_CHANNELS } from '../../electron/ipc/channels';
import { registerCaptureHandlers } from '../../electron/ipc/capture-handlers';
import type { CaptureService } from '../../electron/screen-capture';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function fakeRegistrar(): {
  handle: (c: string, h: Handler) => void;
  handlers: Map<string, Handler>;
} {
  const handlers = new Map<string, Handler>();
  return { handle: (channel, handler) => handlers.set(channel, handler), handlers };
}

function fakeService(): CaptureService & {
  listSources: ReturnType<typeof vi.fn>;
  grab: ReturnType<typeof vi.fn>;
} {
  return {
    listSources: vi.fn().mockResolvedValue({ permission: 'granted', sources: [] }),
    grab: vi.fn().mockResolvedValue(new Uint8Array([1]).buffer),
  };
}

function call(handlers: Map<string, Handler>, channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel);
  if (!handler) {
    throw new Error(`no handler for ${channel}`);
  }
  return handler({}, ...args);
}

describe('capture IPC handlers', () => {
  it('registers exactly the two capture channels', () => {
    const registrar = fakeRegistrar();
    registerCaptureHandlers(registrar, fakeService());
    expect([...registrar.handlers.keys()].sort()).toEqual(
      [CAPTURE_CHANNELS.listSources, CAPTURE_CHANNELS.grab].sort(),
    );
  });

  it('routes listSources to the service', () => {
    const registrar = fakeRegistrar();
    const service = fakeService();
    registerCaptureHandlers(registrar, service);

    call(registrar.handlers, CAPTURE_CHANNELS.listSources);

    expect(service.listSources).toHaveBeenCalledTimes(1);
  });

  it('routes grab to the service with the source id', () => {
    const registrar = fakeRegistrar();
    const service = fakeService();
    registerCaptureHandlers(registrar, service);

    call(registrar.handlers, CAPTURE_CHANNELS.grab, 'screen:0');

    expect(service.grab).toHaveBeenCalledWith('screen:0');
  });

  it('rejects a non-string source id at the boundary', () => {
    const registrar = fakeRegistrar();
    const service = fakeService();
    registerCaptureHandlers(registrar, service);

    expect(() => call(registrar.handlers, CAPTURE_CHANNELS.grab, 123)).toThrow(TypeError);
    expect(service.grab).not.toHaveBeenCalled();
  });
});
