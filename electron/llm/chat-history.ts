import type { ChatMessage } from '@shared/types';

/*
 * The token-budgeted chat-history window (M06.D, ADR-0020). A bounded window of the most recent
 * prior turns is threaded into the chat request (AFTER the cached grounding prefix — see
 * llm-service) so a follow-up has a referent, while per-turn cost stays bounded. OLDEST turns drop
 * first; the most recent turn is always kept (dropping it would leave the follow-up groundless).
 * Pure + deterministic — the estimate is chars/4 (no tokenizer dependency; the real spend is the
 * usage counter, not this estimate).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function selectHistoryWindow(
  messages: readonly ChatMessage[],
  budgetTokens: number,
): ChatMessage[] {
  if (messages.length === 0) {
    return [];
  }
  // Walk newest→oldest, keeping turns while the cumulative estimate fits; always keep the most
  // recent turn even if it alone exceeds the budget.
  const kept: ChatMessage[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    const cost = estimateTokens(message.content);
    if (kept.length > 0 && used + cost > budgetTokens) {
      break;
    }
    kept.push(message);
    used += cost;
  }
  return kept.reverse();
}
