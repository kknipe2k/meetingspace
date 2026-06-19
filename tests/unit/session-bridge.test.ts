import { describe, expect, it } from 'vitest';

import { SESSION_CHANNELS } from '../../electron/ipc/channels';
import { createSessionApi } from '../../electron/ipc/session-bridge';

// Records every invoke(channel, ...args) the bridge makes so we can assert the
// renderer-facing methods map to the right channel with the right arguments —
// the contract the preload relies on (ipcRenderer.invoke is injected in prod).
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

describe('createSessionApi (preload → ipcRenderer mapping)', () => {
  it('exposes exactly the session methods (note blocks live on the notes bridge)', () => {
    const { invoke } = recordingInvoke();

    expect(Object.keys(createSessionApi(invoke)).sort()).toEqual([
      'create',
      'delete',
      'deleteMany',
      'get',
      'list',
      'rename',
    ]);
  });

  it('routes create to session:create with the name', async () => {
    const { invoke, calls } = recordingInvoke();

    await createSessionApi(invoke).create('Kickoff');

    expect(calls).toEqual([{ channel: SESSION_CHANNELS.create, args: ['Kickoff'] }]);
  });

  it('routes list to session:list with no args', async () => {
    const { invoke, calls } = recordingInvoke();

    await createSessionApi(invoke).list();

    expect(calls).toEqual([{ channel: SESSION_CHANNELS.list, args: [] }]);
  });

  it('routes get to session:get with the id', async () => {
    const { invoke, calls } = recordingInvoke();

    await createSessionApi(invoke).get('abc');

    expect(calls).toEqual([{ channel: SESSION_CHANNELS.get, args: ['abc'] }]);
  });

  it('routes rename to session:rename with id and name', async () => {
    const { invoke, calls } = recordingInvoke();

    await createSessionApi(invoke).rename('abc', 'Renamed');

    expect(calls).toEqual([{ channel: SESSION_CHANNELS.rename, args: ['abc', 'Renamed'] }]);
  });

  it('routes delete to session:delete with the id', async () => {
    const { invoke, calls } = recordingInvoke();

    await createSessionApi(invoke).delete('abc');

    expect(calls).toEqual([{ channel: SESSION_CHANNELS.delete, args: ['abc'] }]);
  });

  it('routes deleteMany to session:deleteMany with the ids', async () => {
    const { invoke, calls } = recordingInvoke();

    await createSessionApi(invoke).deleteMany(['a', 'b']);

    expect(calls).toEqual([{ channel: SESSION_CHANNELS.deleteMany, args: [['a', 'b']] }]);
  });
});
