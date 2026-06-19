// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NotesApi, SessionApi } from '@shared/api';

import { noteClient, sessionClient } from '../../src/ipc/client';

// The renderer's single IPC entry point: every method must delegate to
// window.api.{sessions,notes}.* (the contextBridge surface) and pass its args
// through unchanged. This is the only place in src/ allowed to read window.api.
function recorder(): {
  calls: Array<{ method: string; args: unknown[] }>;
  record: <T>(method: string, result: T) => (...args: unknown[]) => Promise<T>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    record:
      <T>(method: string, result: T) =>
      (...args: unknown[]): Promise<T> => {
        calls.push({ method, args });
        return Promise.resolve(result);
      },
  };
}

let calls: Array<{ method: string; args: unknown[] }>;

beforeEach(() => {
  const { calls: c, record } = recorder();
  calls = c;
  const sessions: SessionApi = {
    create: record('create', { id: 's1' }) as SessionApi['create'],
    list: record('list', []) as SessionApi['list'],
    get: record('get', null) as SessionApi['get'],
    rename: record('rename', undefined) as SessionApi['rename'],
    delete: record('delete', undefined) as SessionApi['delete'],
    deleteMany: record('deleteMany', undefined) as SessionApi['deleteMany'],
  };
  const notes: NotesApi = {
    add: record('add', { id: 'n1' }) as NotesApi['add'],
    addWithContent: record('addWithContent', { id: 'n1' }) as NotesApi['addWithContent'],
    list: record('notes.list', []) as NotesApi['list'],
    update: record('update', { id: 'n1' }) as NotesApi['update'],
    updateSync: record('updateSync', { id: 'n1' }) as unknown as NotesApi['updateSync'],
    delete: record('notes.delete', undefined) as NotesApi['delete'],
    reorder: record('reorder', undefined) as NotesApi['reorder'],
  };
  vi.stubGlobal('window', { api: { meta: { appName: 'MeetingSpace' }, sessions, notes } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sessionClient', () => {
  it('delegates create with the name', async () => {
    await sessionClient.create('Kickoff');
    expect(calls).toEqual([{ method: 'create', args: ['Kickoff'] }]);
  });

  it('delegates list', async () => {
    await sessionClient.list();
    expect(calls).toEqual([{ method: 'list', args: [] }]);
  });

  it('delegates get with the id', async () => {
    await sessionClient.get('abc');
    expect(calls).toEqual([{ method: 'get', args: ['abc'] }]);
  });

  it('delegates rename with id and name', async () => {
    await sessionClient.rename('abc', 'New');
    expect(calls).toEqual([{ method: 'rename', args: ['abc', 'New'] }]);
  });

  it('delegates delete with the id', async () => {
    await sessionClient.delete('abc');
    expect(calls).toEqual([{ method: 'delete', args: ['abc'] }]);
  });
});

describe('noteClient', () => {
  it('delegates add with the sessionId', async () => {
    await noteClient.add('s1');
    expect(calls).toEqual([{ method: 'add', args: ['s1'] }]);
  });

  it('delegates addWithContent with the sessionId and content', async () => {
    await noteClient.addWithContent('s1', 'seed.md\n\nbody');
    expect(calls).toEqual([{ method: 'addWithContent', args: ['s1', 'seed.md\n\nbody'] }]);
  });

  it('delegates list with the sessionId', async () => {
    await noteClient.list('s1');
    expect(calls).toEqual([{ method: 'notes.list', args: ['s1'] }]);
  });

  it('delegates update with id and content', async () => {
    await noteClient.update('n1', 'body');
    expect(calls).toEqual([{ method: 'update', args: ['n1', 'body'] }]);
  });

  it('delegates updateSync with id and content (synchronous teardown path)', () => {
    noteClient.updateSync('n1', 'body'); // sendSync, not invoke
    expect(calls).toEqual([{ method: 'updateSync', args: ['n1', 'body'] }]);
  });

  it('delegates delete with the id', async () => {
    await noteClient.delete('n1');
    expect(calls).toEqual([{ method: 'notes.delete', args: ['n1'] }]);
  });

  it('delegates reorder with sessionId and ordered ids', async () => {
    await noteClient.reorder('s1', ['n2', 'n1']);
    expect(calls).toEqual([{ method: 'reorder', args: ['s1', ['n2', 'n1']] }]);
  });
});
