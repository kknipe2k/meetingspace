import { describe, expect, it } from 'vitest';

import { NOTE_CHANNELS } from '../../electron/ipc/channels';
import { createNotesApi } from '../../electron/ipc/notes-bridge';

// Records every invoke(channel, ...args) the bridge makes so we can assert the
// renderer-facing note methods map to the right channel with the right args —
// the contract the preload relies on (ipcRenderer.invoke injected in prod).
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

// Records every sendSync(channel, ...args) the bridge makes (ipcRenderer.sendSync
// injected in prod), returning a stand-in Note so the synchronous method has a value.
function recordingSendSync(): {
  sendSync: (channel: string, ...args: unknown[]) => unknown;
  calls: Array<{ channel: string; args: unknown[] }>;
} {
  const calls: Array<{ channel: string; args: unknown[] }> = [];
  return {
    calls,
    sendSync: (channel, ...args) => {
      calls.push({ channel, args });
      return { id: 'n1', content: String(args[1] ?? '') };
    },
  };
}

describe('createNotesApi (preload → ipcRenderer mapping)', () => {
  it('exposes exactly the seven note methods (incl. the sync updateSync)', () => {
    const { invoke } = recordingInvoke();
    const { sendSync } = recordingSendSync();

    expect(Object.keys(createNotesApi(invoke, sendSync)).sort()).toEqual([
      'add',
      'addWithContent',
      'delete',
      'list',
      'reorder',
      'update',
      'updateSync',
    ]);
  });

  it('routes updateSync to note:updateSync over sendSync (not invoke) and returns the row', () => {
    const { invoke, calls: invokeCalls } = recordingInvoke();
    const { sendSync, calls: syncCalls } = recordingSendSync();

    const result = createNotesApi(invoke, sendSync).updateSync('n1', 'flushed');

    expect(syncCalls).toEqual([{ channel: NOTE_CHANNELS.updateSync, args: ['n1', 'flushed'] }]);
    expect(invokeCalls).toEqual([]); // the sync path must NOT use the async invoke
    expect(result).toEqual({ id: 'n1', content: 'flushed' });
  });

  it('routes add to note:add with the sessionId', async () => {
    const { invoke, calls } = recordingInvoke();
    await createNotesApi(invoke).add('s1');
    expect(calls).toEqual([{ channel: NOTE_CHANNELS.add, args: ['s1'] }]);
  });

  it('routes addWithContent to note:addWithContent with the sessionId and content', async () => {
    const { invoke, calls } = recordingInvoke();
    await createNotesApi(invoke).addWithContent('s1', 'seed.md\n\nbody');
    expect(calls).toEqual([
      { channel: NOTE_CHANNELS.addWithContent, args: ['s1', 'seed.md\n\nbody'] },
    ]);
  });

  it('routes list to note:list with the sessionId', async () => {
    const { invoke, calls } = recordingInvoke();
    await createNotesApi(invoke).list('s1');
    expect(calls).toEqual([{ channel: NOTE_CHANNELS.list, args: ['s1'] }]);
  });

  it('routes update to note:update with the id and content', async () => {
    const { invoke, calls } = recordingInvoke();
    await createNotesApi(invoke).update('n1', 'body');
    expect(calls).toEqual([{ channel: NOTE_CHANNELS.update, args: ['n1', 'body'] }]);
  });

  it('routes delete to note:delete with the id', async () => {
    const { invoke, calls } = recordingInvoke();
    await createNotesApi(invoke).delete('n1');
    expect(calls).toEqual([{ channel: NOTE_CHANNELS.delete, args: ['n1'] }]);
  });

  it('routes reorder to note:reorder with the sessionId and ordered ids', async () => {
    const { invoke, calls } = recordingInvoke();
    await createNotesApi(invoke).reorder('s1', ['n2', 'n1']);
    expect(calls).toEqual([{ channel: NOTE_CHANNELS.reorder, args: ['s1', ['n2', 'n1']] }]);
  });
});
