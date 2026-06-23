// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AssetsApi, LlmApi, LlmStreamCallbacks, NotesApi, SettingsApi } from '@shared/api';
import type {
  Asset,
  GenTemplate,
  LlmChatRequest,
  LlmDone,
  Note,
  ThemePreference,
} from '@shared/types';

import type { GenApi } from '@shared/api';
import type { GenDocument } from '@shared/types';

import { ChatPanel } from '../../src/components/ChatPanel';
import { GeneratedDocView } from '../../src/components/GeneratedDocView';
import { LLMPanel } from '../../src/components/LLMPanel';
import { NoteBlock } from '../../src/components/NoteBlock';
import { NoteBlocks } from '../../src/components/NoteBlocks';
import { PromptTemplateEditor } from '../../src/components/PromptTemplateEditor';
import { Screenshots } from '../../src/components/Screenshots';
import { SettingsModal } from '../../src/components/SettingsModal';
import { ToastHost } from '../../src/components/ToastHost';
import { useTheme } from '../../src/hooks/useTheme';
import { ToastProvider } from '../../src/hooks/useToasts';

/*
 * F13 / F15 (M06.B, the last REVIEW-V11 🔴). Every fire-and-forget / catch-less renderer
 * mutation routes its rejection to an error toast — no more silent write failures. Each test
 * here gives a component a REJECTING client and asserts a toast appears (mutation: remove the
 * catch at the site → that test fails). Completeness across ALL mutation sites is enforced
 * separately by mutation-surfacing-guard.test.ts.
 */
import type { ReactElement, ReactNode } from 'react';

function withToasts(ui: ReactNode): ReactElement {
  return (
    <ToastProvider>
      {ui}
      <ToastHost />
    </ToastProvider>
  );
}

function toastHost(): HTMLElement {
  return screen.getByTestId('toast-host');
}

afterEach(() => {
  vi.useRealTimers();
});

function note(id: string, content = '', sessionId = 's1'): Note {
  return { id, sessionId, content, createdAt: 1, updatedAt: 1 };
}

describe('NoteBlocks — mutation failures surface', () => {
  it('an add failure raises an error toast', async () => {
    const client: NotesApi = {
      list: () => Promise.resolve([]),
      add: () => Promise.reject(new Error('db down')),
      addWithContent: () => Promise.reject(new Error('db down')),
      update: () => Promise.resolve(note('n1')),
      updateSync: () => note('n1'),
      delete: () => Promise.resolve(),
      reorder: () => Promise.resolve(),
    } as unknown as NotesApi;
    render(withToasts(<NoteBlocks sessionId="s1" client={client} />));
    await screen.findByText(/no notes yet/i);

    await userEvent.click(screen.getByRole('button', { name: /add note or transcript/i }));

    await waitFor(() => expect(within(toastHost()).getByRole('alert')).toBeInTheDocument());
    expect(within(toastHost()).getByText(/couldn't add/i)).toBeInTheDocument();
  });

  it('an over-cap upload surfaces a real error, not silence (the headline F13 repro)', async () => {
    const client: NotesApi = {
      list: () => Promise.resolve([]),
      add: () => Promise.resolve(note('n1')),
      addWithContent: () => Promise.reject(new RangeError('content exceeds 5242880 bytes')),
      update: () => Promise.resolve(note('n1')),
      updateSync: () => note('n1'),
      delete: () => Promise.resolve(),
      reorder: () => Promise.resolve(),
    } as unknown as NotesApi;
    render(withToasts(<NoteBlocks sessionId="s1" client={client} />));
    await screen.findByText(/no notes yet/i);

    const bigFile = new File(['x'.repeat(10)], 'transcript.txt', { type: 'text/plain' });
    await userEvent.upload(screen.getByLabelText('Add note or transcript file'), bigFile);

    await waitFor(() => expect(within(toastHost()).getByRole('alert')).toBeInTheDocument());
    expect(within(toastHost()).getByText(/couldn't save/i)).toBeInTheDocument();
  });

  it('a reorder failure surfaces an error toast', async () => {
    const client: NotesApi = {
      list: () => Promise.resolve([note('a', 'A'), note('b', 'B')]),
      add: () => Promise.resolve(note('c')),
      addWithContent: () => Promise.resolve(note('c')),
      update: () => Promise.resolve(note('a')),
      updateSync: () => note('a'),
      delete: () => Promise.resolve(),
      reorder: () => Promise.reject(new Error('reorder failed')),
    } as unknown as NotesApi;
    render(withToasts(<NoteBlocks sessionId="s1" client={client} />));
    const handles = await screen.findAllByRole('button', { name: /reorder note/i });

    // Drag block 1 onto block 2's card.
    fireEvent.dragStart(handles[0]!);
    const cards = screen.getAllByTestId('note-block');
    fireEvent.drop(cards[1]!);

    await waitFor(() =>
      expect(within(toastHost()).getByText(/couldn't reorder/i)).toBeInTheDocument(),
    );
  });
});

describe('NoteBlock autosave — failure surfaces ONCE, not per attempt (#4)', () => {
  it('shows a single error toast across repeated failing autosaves, and re-arms after a success', async () => {
    vi.useFakeTimers();
    let mode: 'fail' | 'ok' = 'fail';
    const client = {
      update: () =>
        mode === 'fail' ? Promise.reject(new Error('x')) : Promise.resolve(note('n1')),
      updateSync: () => note('n1'),
    } as unknown as NotesApi;

    render(
      withToasts(
        <NoteBlock
          note={note('n1', 'start')}
          index={1}
          client={client}
          onDelete={() => undefined}
          onDragStart={() => undefined}
          onDropOn={() => undefined}
        />,
      ),
    );
    const textarea = screen.getByRole('textbox', { name: 'Note 1' });

    // Two failing autosaves (edit + blur each time).
    fireEvent.change(textarea, { target: { value: 'edit 1' } });
    fireEvent.blur(textarea);
    await act(async () => undefined);
    fireEvent.change(textarea, { target: { value: 'edit 2' } });
    fireEvent.blur(textarea);
    await act(async () => undefined);

    // Exactly one error toast despite two failures (not per-attempt).
    expect(within(toastHost()).getAllByRole('alert')).toHaveLength(1);

    // Let the error toast auto-dismiss, then fail again — still suppressed (no new toast).
    act(() => vi.advanceTimersByTime(10_000));
    fireEvent.change(textarea, { target: { value: 'edit 3' } });
    fireEvent.blur(textarea);
    await act(async () => undefined);
    expect(within(toastHost()).queryByRole('alert')).toBeNull();

    // A SUCCESSFUL save re-arms; the next failure surfaces again.
    mode = 'ok';
    fireEvent.change(textarea, { target: { value: 'edit 4' } });
    fireEvent.blur(textarea);
    await act(async () => undefined);
    mode = 'fail';
    fireEvent.change(textarea, { target: { value: 'edit 5' } });
    fireEvent.blur(textarea);
    await act(async () => undefined);
    expect(within(toastHost()).getByRole('alert')).toBeInTheDocument();
  });
});

describe('Screenshots — mutation failures surface', () => {
  function asset(id: string): Asset {
    return { id, sessionId: 's1', kind: 'screenshot', relativePath: `s1/${id}.png`, createdAt: 1 };
  }

  it('a save failure (e.g. over-cap image) raises an error toast', async () => {
    const client: AssetsApi = {
      list: () => Promise.resolve([]),
      save: () => Promise.reject(new RangeError('image exceeds 26214400 bytes')),
      delete: () => Promise.resolve(),
    };
    render(withToasts(<Screenshots sessionId="s1" client={client} />));
    await screen.findByText(/no screenshots yet/i);

    fireEvent.drop(screen.getByTestId('screenshot-drop'), {
      dataTransfer: {
        files: [new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' })],
      },
    });

    await waitFor(() =>
      expect(within(toastHost()).getByText(/couldn't save/i)).toBeInTheDocument(),
    );
  });

  it('a delete failure raises an error toast', async () => {
    const client: AssetsApi = {
      list: () => Promise.resolve([asset('existing')]),
      save: () => Promise.resolve(asset('new')),
      delete: () => Promise.reject(new Error('locked')),
    };
    render(withToasts(<Screenshots sessionId="s1" client={client} />));
    await waitFor(() => expect(screen.getAllByTestId('screenshot-thumb')).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: 'Delete screenshot 1' }));

    await waitFor(() =>
      expect(within(toastHost()).getByText(/couldn't delete/i)).toBeInTheDocument(),
    );
  });
});

describe('PromptTemplateEditor — template mutation failures surface', () => {
  const seed: GenTemplate = {
    id: 'default',
    name: 'Default',
    focusPrompt: 'f',
    whitepaperPrompt: 'w',
    isDefault: true,
  };
  const fork: GenTemplate = {
    id: 'fork1',
    name: 'My fork',
    focusPrompt: 'f2',
    whitepaperPrompt: 'w2',
    isDefault: false,
  };

  it('a saveTemplate failure (New from default) raises an error toast', async () => {
    const client = {
      listTemplates: () => Promise.resolve([seed]),
      saveTemplate: () => Promise.reject(new Error('write failed')),
      deleteTemplate: () => Promise.resolve(),
    } as unknown as NonNullable<Parameters<typeof PromptTemplateEditor>[0]['client']>;
    render(
      withToasts(
        <PromptTemplateEditor
          client={client}
          selectedTemplateId="default"
          onSelectTemplate={() => undefined}
        />,
      ),
    );
    await screen.findByDisplayValue('f');

    await userEvent.click(screen.getByRole('button', { name: /new from default/i }));

    await waitFor(() =>
      expect(within(toastHost()).getByText(/couldn't create/i)).toBeInTheDocument(),
    );
  });

  it('an updateTemplate (Save) failure raises an error toast', async () => {
    const client = {
      listTemplates: () => Promise.resolve([seed, fork]),
      saveTemplate: () => Promise.resolve(fork),
      updateTemplate: () => Promise.reject(new Error('write failed')),
      deleteTemplate: () => Promise.resolve(),
    } as unknown as NonNullable<Parameters<typeof PromptTemplateEditor>[0]['client']>;
    render(
      withToasts(
        <PromptTemplateEditor
          client={client}
          selectedTemplateId="fork1"
          onSelectTemplate={() => undefined}
        />,
      ),
    );
    const focus = await screen.findByLabelText(/focus prompt/i);
    await userEvent.type(focus, ' edited');

    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(within(toastHost()).getByText(/couldn't save/i)).toBeInTheDocument(),
    );
  });

  it('a deleteTemplate failure raises an error toast', async () => {
    const client = {
      listTemplates: () => Promise.resolve([seed, fork]),
      saveTemplate: () => Promise.resolve(fork),
      deleteTemplate: () => Promise.reject(new Error('write failed')),
    } as unknown as NonNullable<Parameters<typeof PromptTemplateEditor>[0]['client']>;
    render(
      withToasts(
        <PromptTemplateEditor
          client={client}
          selectedTemplateId="fork1"
          onSelectTemplate={() => undefined}
        />,
      ),
    );
    await screen.findByRole('button', { name: /delete template/i });

    await userEvent.click(screen.getByRole('button', { name: /delete template/i }));

    await waitFor(() =>
      expect(within(toastHost()).getByText(/couldn't delete/i)).toBeInTheDocument(),
    );
  });
});

describe('ChatPanel — save-reply-as-note failure surfaces', () => {
  function llmHarness(): { client: LlmApi; emit(): void } {
    let cbs: LlmStreamCallbacks | null = null;
    return {
      client: {
        chat(_req: LlmChatRequest, callbacks: LlmStreamCallbacks) {
          cbs = callbacks;
          return () => undefined;
        },
        history: async () => [],
      },
      emit: () =>
        act(() => {
          cbs?.onChunk('A reply.');
          cbs?.onDone({
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1 },
          } as LlmDone);
        }),
    };
  }

  it('a failing save-to-notes raises an error toast', async () => {
    const llm = llmHarness();
    const noteClient: Pick<NotesApi, 'addWithContent'> = {
      addWithContent: () => Promise.reject(new Error('db down')),
    };
    render(withToasts(<ChatPanel sessionId="s1" client={llm.client} noteClient={noteClient} />));

    await userEvent.type(
      screen.getByRole('textbox', { name: 'Ask Claude about this session' }),
      'Q?',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }));
    llm.emit();

    await userEvent.click(await screen.findByRole('button', { name: 'Save to notes' }));

    await waitFor(() =>
      expect(within(toastHost()).getByText(/couldn't save/i)).toBeInTheDocument(),
    );
  });
});

describe('Preference writes surface failures (F18 by-design sites, now surfaced)', () => {
  it('LLMPanel: a setPrefs failure on model change raises an error toast', async () => {
    const settings: SettingsApi = {
      getPrefs: () => Promise.resolve({}),
      setPrefs: () => Promise.reject(new Error('prefs write failed')),
      setKey: () => Promise.resolve({ ok: true }),
      keyStatus: () => Promise.resolve({ hasKey: false, encryptionAvailable: true }),
      clearKey: () => Promise.resolve(),
      getProvider: () => Promise.resolve({ provider: 'anthropic' }),
      setProvider: () => Promise.resolve({ provider: 'anthropic' }),
      pingGateway: () => Promise.resolve({ ok: true }),
    };
    render(
      withToasts(
        <LLMPanel
          session={{ id: 's1', spaceId: 'space-default', name: 'X', createdAt: 1, updatedAt: 1 }}
          settingsClient={settings}
        />,
      ),
    );
    const select = await screen.findByRole('combobox', { name: 'Chat model' });
    const options = within(select).getAllByRole('option') as HTMLOptionElement[];
    const other = options.find((o) => o.value !== (select as HTMLSelectElement).value);
    fireEvent.change(select, { target: { value: other?.value } });

    await waitFor(() =>
      expect(within(toastHost()).getByText(/couldn't save/i)).toBeInTheDocument(),
    );
  });

  it('useTheme: a setPrefs failure on appearance change raises an error toast', async () => {
    const settings: Pick<SettingsApi, 'getPrefs' | 'setPrefs'> = {
      getPrefs: () => Promise.resolve({}),
      setPrefs: () => Promise.reject(new Error('prefs write failed')),
    };
    function ThemeHarness(): ReactElement {
      const { setPreference } = useTheme(settings);
      return (
        <button type="button" onClick={() => setPreference('dark' as ThemePreference)}>
          go-dark
        </button>
      );
    }
    render(withToasts(<ThemeHarness />));

    await userEvent.click(screen.getByRole('button', { name: 'go-dark' }));

    await waitFor(() =>
      expect(within(toastHost()).getByText(/couldn't save/i)).toBeInTheDocument(),
    );
  });
});

describe('SettingsModal — credential mutation failures surface', () => {
  function settings(over: Partial<SettingsApi>): SettingsApi {
    return {
      getPrefs: () => Promise.resolve({}),
      setPrefs: () => Promise.resolve({}),
      setKey: () => Promise.resolve({ ok: true }),
      keyStatus: () => Promise.resolve({ hasKey: false, encryptionAvailable: true }),
      clearKey: () => Promise.resolve(),
      getProvider: () => Promise.resolve({ provider: 'anthropic' }),
      setProvider: () => Promise.resolve({ provider: 'anthropic' }),
      pingGateway: () => Promise.resolve({ ok: true }),
      ...over,
    };
  }

  it('a setKey failure raises an error toast', async () => {
    const client = settings({ setKey: () => Promise.reject(new Error('vault locked')) });
    render(withToasts(<SettingsModal client={client} onClose={() => undefined} />));
    await screen.findByText(/no api key saved/i);

    await userEvent.type(screen.getByLabelText('Anthropic API key'), 'sk-ant-xxx');
    await userEvent.click(screen.getByRole('button', { name: 'Save key' }));

    await waitFor(() =>
      expect(within(toastHost()).getByText(/couldn't save/i)).toBeInTheDocument(),
    );
  });

  it('a clearKey failure raises an error toast', async () => {
    const client = settings({
      keyStatus: () => Promise.resolve({ hasKey: true, encryptionAvailable: true }),
      clearKey: () => Promise.reject(new Error('vault locked')),
    });
    render(withToasts(<SettingsModal client={client} onClose={() => undefined} />));
    await screen.findByRole('button', { name: 'Clear key' });

    await userEvent.click(screen.getByRole('button', { name: 'Clear key' }));

    await waitFor(() =>
      expect(within(toastHost()).getByText(/couldn't clear/i)).toBeInTheDocument(),
    );
  });

  it('a setProvider failure (switching to Anthropic) raises an error toast', async () => {
    const client = settings({
      getProvider: () =>
        Promise.resolve({ provider: 'gateway', baseURL: 'https://gw.example.com' }),
      setProvider: () => Promise.reject(new Error('provider write failed')),
    });
    render(withToasts(<SettingsModal client={client} onClose={() => undefined} />));
    await screen.findByLabelText('Claude provider');

    await userEvent.selectOptions(screen.getByLabelText('Claude provider'), 'anthropic');

    await waitFor(() =>
      expect(within(toastHost()).getByText(/couldn't switch/i)).toBeInTheDocument(),
    );
  });
});

describe('GeneratedDocView — export failures surface (F15)', () => {
  function doc(): GenDocument {
    return {
      id: 'd1',
      sessionId: 's1',
      kind: 'whitepaper',
      content: '<h1>Strategy</h1>',
      templateId: null,
      createdAt: 1,
      model: null,
    };
  }

  function genClient(over: Partial<GenApi>): GenApi {
    const handle = () => ({ detach: () => undefined, cancel: () => undefined });
    return {
      generateFocus: () => handle(),
      generateWhitepaper: () => handle(),
      generateMinutes: () => handle(),
      attach: () => handle(),
      status: () => Promise.resolve(null),
      cancel: () => Promise.resolve(),
      onArtifactSaved: () => () => undefined,
      onRunStarted: () => () => undefined,
      onRunEnded: () => () => undefined,
      onProgress: () => () => undefined,
      getLatestArtifacts: () => Promise.resolve([doc()]),
      getArtifacts: () => Promise.resolve([doc()]),
      buildRawDoc: () => Promise.resolve('<html></html>'),
      exportImages: () => Promise.resolve({ images: [], omittedCount: 0 }),
      exportHtml: () => Promise.resolve({ saved: true, path: '/tmp/x.html' }),
      exportMarkdown: () => Promise.resolve({ saved: true, path: '/tmp/x.md' }),
      exportPdf: () => Promise.resolve({ saved: true, path: '/tmp/x.pdf' }),
      listTemplates: () => Promise.resolve([]),
      saveTemplate: () =>
        Promise.resolve({
          id: 't',
          name: 'n',
          focusPrompt: '',
          whitepaperPrompt: '',
          isDefault: false,
        }),
      getTemplate: () => Promise.resolve(null),
      deleteTemplate: () => Promise.resolve(),
      ...over,
    } as unknown as GenApi;
  }

  it('an Export HTML failure raises an error toast', async () => {
    const client = genClient({ exportHtml: () => Promise.reject(new Error('disk full')) });
    render(withToasts(<GeneratedDocView sessionId="s1" client={client} />));
    await screen.findByRole('button', { name: /export html/i });

    await userEvent.click(screen.getByRole('button', { name: /export html/i }));

    await waitFor(() =>
      expect(within(toastHost()).getByText(/couldn't export/i)).toBeInTheDocument(),
    );
  });

  it('an Export markdown failure raises an error toast', async () => {
    const client = genClient({ exportMarkdown: () => Promise.reject(new Error('disk full')) });
    render(withToasts(<GeneratedDocView sessionId="s1" client={client} />));
    await screen.findByRole('button', { name: /export markdown/i });

    await userEvent.click(screen.getByRole('button', { name: /export markdown/i }));

    await waitFor(() =>
      expect(within(toastHost()).getByText(/couldn't export/i)).toBeInTheDocument(),
    );
  });
});
