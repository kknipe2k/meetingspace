import { describe, expect, it } from 'vitest';

import { ASSET_CHANNELS } from '../../electron/ipc/channels';
import { createAssetsApi } from '../../electron/ipc/assets-bridge';

// Asserts the renderer-facing asset methods map to the right channel with the
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

describe('createAssetsApi (preload → ipcRenderer mapping)', () => {
  it('exposes exactly the three asset methods', () => {
    const { invoke } = recordingInvoke();
    expect(Object.keys(createAssetsApi(invoke)).sort()).toEqual(['delete', 'list', 'save']);
  });

  it('routes save to asset:save with sessionId, bytes, mime and kind', async () => {
    const { invoke, calls } = recordingInvoke();
    const buf = new Uint8Array([1, 2]).buffer;
    await createAssetsApi(invoke).save('s1', buf, 'image/png', 'paste');
    expect(calls).toEqual([
      { channel: ASSET_CHANNELS.save, args: ['s1', buf, 'image/png', 'paste'] },
    ]);
  });

  it('routes list to asset:list with the sessionId', async () => {
    const { invoke, calls } = recordingInvoke();
    await createAssetsApi(invoke).list('s1');
    expect(calls).toEqual([{ channel: ASSET_CHANNELS.list, args: ['s1'] }]);
  });

  it('routes delete to asset:delete with the id', async () => {
    const { invoke, calls } = recordingInvoke();
    await createAssetsApi(invoke).delete('a1');
    expect(calls).toEqual([{ channel: ASSET_CHANNELS.delete, args: ['a1'] }]);
  });
});
