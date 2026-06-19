import { describe, expect, it } from 'vitest';

import { CAPTURE_CHANNELS } from '../../electron/ipc/channels';
import { createCaptureApi } from '../../electron/ipc/capture-bridge';

// Asserts the renderer-facing capture methods map to the right channel with the
// right args — the contract the preload relies on (ipcRenderer.invoke injected).
function recordingInvoke(): {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  calls: Array<{ channel: string; args: unknown[] }>;
} {
  const calls: Array<{ channel: string; args: unknown[] }> = [];
  return {
    calls,
    invoke: (channel, ...args) => {
      calls.push({ channel, args });
      return Promise.resolve(undefined);
    },
  };
}

describe('createCaptureApi (preload → ipcRenderer mapping)', () => {
  it('exposes exactly the two capture methods', () => {
    const { invoke } = recordingInvoke();
    expect(Object.keys(createCaptureApi(invoke)).sort()).toEqual(['grab', 'listSources']);
  });

  it('routes listSources to capture:listSources with no args', async () => {
    const { invoke, calls } = recordingInvoke();
    await createCaptureApi(invoke).listSources();
    expect(calls).toEqual([{ channel: CAPTURE_CHANNELS.listSources, args: [] }]);
  });

  it('routes grab to capture:grab with the source id', async () => {
    const { invoke, calls } = recordingInvoke();
    await createCaptureApi(invoke).grab('screen:0');
    expect(calls).toEqual([{ channel: CAPTURE_CHANNELS.grab, args: ['screen:0'] }]);
  });
});
