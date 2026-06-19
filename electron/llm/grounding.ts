import type { Note } from '@shared/types';

/*
 * Main-side grounding assembly (M03.C). On `llm:chat`, the LLM service reads the
 * session's note blocks from storage (the single source of truth — the renderer
 * never supplies the note text it would be grounded on, gotcha: don't trust the
 * renderer) and folds them into a `system` prefix Claude answers against. The
 * anthropic-client wrapper prompt-caches that prefix (cache_control: ephemeral), so
 * a stable grounding context is billed at cache-read rates on repeat turns.
 *
 * The context is BOUNDED: at most GROUNDING_CHAR_BUDGET characters of note text are
 * included. When the session's notes exceed that, the included text is truncated and
 * an explicit marker is appended — content is never dropped silently.
 */
export interface NoteReader {
  listNotes(sessionId: string): Note[];
}

export interface GroundingContext {
  /** The system prompt: instructions + the (bounded) session note text. */
  readonly system: string;
  /** Count of content-bearing notes in the session (0 ⇒ nothing to ground on). */
  readonly noteCount: number;
  /** True when note text was truncated to fit the budget. */
  readonly truncated: boolean;
}

// ~100k characters of note text (~25k tokens) — generous for a meeting session,
// but bounded so a runaway transcript can't blow up the request or the bill.
export const GROUNDING_CHAR_BUDGET = 100_000;

const PREAMBLE = [
  'You are an assistant embedded in MeetingSpace, helping the user understand one',
  'meeting session. Answer using ONLY the content of this session below. If the',
  'answer is not covered by it, say so plainly rather than guessing. Be concise.',
].join(' ');

const NOTE_SEPARATOR = '\n\n---\n\n';
const TRUNCATION_MARKER =
  '\n\n[…notes truncated to fit the context budget — some later content is not shown.]';
const NOTES_HEADER = '\n\n--- Session notes ---\n\n';

export function buildGroundingContext(sessionId: string, notes: NoteReader): GroundingContext {
  const contentNotes = notes
    .listNotes(sessionId)
    .map((note) => note.content)
    .filter((content) => content.trim().length > 0);

  const parts: string[] = [];
  let used = 0;
  let truncated = false;
  for (const content of contentNotes) {
    if (used >= GROUNDING_CHAR_BUDGET) {
      truncated = true;
      break;
    }
    const remaining = GROUNDING_CHAR_BUDGET - used;
    if (content.length <= remaining) {
      parts.push(content);
      used += content.length;
    } else {
      parts.push(content.slice(0, remaining));
      used += remaining;
      truncated = true;
      break;
    }
  }

  const system =
    PREAMBLE + NOTES_HEADER + parts.join(NOTE_SEPARATOR) + (truncated ? TRUNCATION_MARKER : '');

  return { system, noteCount: contentNotes.length, truncated };
}
