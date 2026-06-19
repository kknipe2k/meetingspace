import { describe, expect, it } from 'vitest';

import { estimateTokens, selectHistoryWindow } from '../../electron/llm/chat-history';
import type { ChatMessage } from '@shared/types';

/*
 * The token-budgeted history window (ADR-0020). A bounded, recent window of prior turns is
 * threaded into the chat request so a follow-up has a referent — but the window is capped so
 * per-turn cost can't run away. OLDEST turns drop first; the most recent turns are always kept.
 */
function msg(id: string, content: string, role: 'user' | 'assistant' = 'user'): ChatMessage {
  return { id, sessionId: 's1', role, content, model: null, createdAt: Number(id) };
}

describe('estimateTokens', () => {
  it('approximates ~4 chars per token (ceil)', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('selectHistoryWindow', () => {
  it('keeps everything when under budget, preserving order', () => {
    const history = [msg('1', 'aaaa'), msg('2', 'bbbb'), msg('3', 'cccc')];
    expect(selectHistoryWindow(history, 100).map((m) => m.content)).toEqual([
      'aaaa',
      'bbbb',
      'cccc',
    ]);
  });

  it('drops oldest first when over budget', () => {
    // Each message ~1 token (4 chars). Budget 2 tokens keeps only the two most recent.
    const history = [msg('1', 'aaaa'), msg('2', 'bbbb'), msg('3', 'cccc')];
    expect(selectHistoryWindow(history, 2).map((m) => m.content)).toEqual(['bbbb', 'cccc']);
  });

  it('returns the most recent turn even if a single turn exceeds the budget', () => {
    const history = [msg('1', 'aaaa'), msg('2', 'x'.repeat(400))];
    // The latest turn alone is ~100 tokens > a 1-token budget, but dropping it would leave the
    // follow-up groundless — keep at least the most recent turn.
    expect(selectHistoryWindow(history, 1).map((m) => m.content)).toEqual(['x'.repeat(400)]);
  });

  it('is empty for an empty history', () => {
    expect(selectHistoryWindow([], 100)).toEqual([]);
  });
});
