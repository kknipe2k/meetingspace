// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { LlmApi } from '@shared/api';
import type { Prefs, Session } from '@shared/types';

import { ChatPanel } from '../../src/components/ChatPanel';
import { LLMPanel } from '../../src/components/LLMPanel';

/*
 * F8 chat scroll retention (M06.A carry → M06.D — meaningful now the thread persists). The
 * per-session offset is owned by LLMPanel above the session-keyed ChatPanel remount and persisted
 * to prefs, so a session reopens where it was left. ChatPanel applies the restored offset and
 * reports scroll changes back up.
 */
const SESSION: Session = {
  id: 's1',
  spaceId: 'sp1',
  name: 'Design review',
  createdAt: 1,
  updatedAt: 1,
};

const emptyLlm: LlmApi = { chat: () => () => undefined, history: vi.fn(async () => []) };

function fakeSettings(initial: Prefs) {
  let prefs: Prefs = { ...initial };
  return {
    setKey: vi.fn(async () => ({ ok: true as const })),
    keyStatus: vi.fn(async () => ({ hasKey: true, encryptionAvailable: true })),
    clearKey: vi.fn(async () => undefined),
    getPrefs: vi.fn(async () => prefs),
    setPrefs: vi.fn(async (next: Prefs) => {
      prefs = { ...prefs, ...next };
      return prefs;
    }),
    getProvider: vi.fn(async () => ({ provider: 'anthropic' as const })),
    setProvider: vi.fn(async (p) => p),
  };
}

describe('ChatPanel scroll retention', () => {
  it('restores the provided scroll offset onto the conversation container', async () => {
    render(<ChatPanel sessionId="s1" client={emptyLlm} initialScrollTop={140} />);
    const log = screen.getByRole('log', { name: 'Conversation' });
    await waitFor(() => expect(log.scrollTop).toBe(140));
  });

  it('reports scroll changes via onScrollChange', () => {
    const onScrollChange = vi.fn();
    render(<ChatPanel sessionId="s1" client={emptyLlm} onScrollChange={onScrollChange} />);
    const log = screen.getByRole('log', { name: 'Conversation' });
    log.scrollTop = 88;
    fireEvent.scroll(log);
    expect(onScrollChange).toHaveBeenCalledWith(88);
  });
});

describe('LLMPanel scroll retention', () => {
  it('restores the per-session offset from prefs on load', async () => {
    render(
      <LLMPanel session={SESSION} settingsClient={fakeSettings({ chatScroll: { s1: 175 } })} />,
    );
    const log = await screen.findByRole('log', { name: 'Conversation' });
    await waitFor(() => expect(log.scrollTop).toBe(175));
  });

  it('persists the chat scroll offset to prefs (debounced)', async () => {
    vi.useFakeTimers();
    try {
      const settings = fakeSettings({});
      render(<LLMPanel session={SESSION} settingsClient={settings} />);
      // Let the async prefs load settle, then scroll.
      await vi.runOnlyPendingTimersAsync();
      const log = screen.getByRole('log', { name: 'Conversation' });
      log.scrollTop = 210;
      fireEvent.scroll(log);
      await vi.advanceTimersByTimeAsync(600); // past the 500ms debounce
      expect(settings.setPrefs).toHaveBeenCalledWith({ chatScroll: { s1: 210 } });
    } finally {
      vi.useRealTimers();
    }
  });
});
