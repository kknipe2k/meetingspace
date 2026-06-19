import { describe, expect, it } from 'vitest';

import {
  buildGroundingContext,
  GROUNDING_CHAR_BUDGET,
  type NoteReader,
} from '../../electron/llm/grounding';
import type { Note } from '@shared/types';

/*
 * Grounding assembly (M03.C). Main-side: the session's note blocks are read from a
 * NoteReader (NoteStore in prod — the single source of truth; the renderer-supplied
 * text is never trusted) and folded into a `system` prefix Claude answers against.
 * The context is BOUNDED — over-budget content is truncated with an explicit marker,
 * never silently dropped.
 */
function note(id: string, content: string): Note {
  return { id, sessionId: 's1', content, createdAt: 1, updatedAt: 1 };
}

function reader(notes: Note[]): NoteReader {
  return { listNotes: () => notes };
}

describe('buildGroundingContext', () => {
  it('folds every content-bearing note into the system prompt and counts them', () => {
    const ctx = buildGroundingContext(
      's1',
      reader([note('a', 'Decided to ship Friday.'), note('b', 'Owner: Kurt.')]),
    );

    expect(ctx.noteCount).toBe(2);
    expect(ctx.system).toContain('Decided to ship Friday.');
    expect(ctx.system).toContain('Owner: Kurt.');
    expect(ctx.truncated).toBe(false);
  });

  it('instructs the model to answer only from this session and to flag gaps', () => {
    const ctx = buildGroundingContext('s1', reader([note('a', 'x')]));
    // The grounding contract: answer from the session content only.
    expect(ctx.system.toLowerCase()).toContain('only');
  });

  it('treats a session with no content-bearing notes as empty (no fabricated content)', () => {
    expect(buildGroundingContext('s1', reader([])).noteCount).toBe(0);
    // Blank / whitespace-only blocks carry nothing to ground on.
    expect(buildGroundingContext('s1', reader([note('a', '   '), note('b', '')])).noteCount).toBe(
      0,
    );
  });

  it('bounds the context and marks truncation rather than dropping content silently', () => {
    const atBudget = 'x'.repeat(GROUNDING_CHAR_BUDGET);
    const overflow = 'y'.repeat(50_000);
    const ctx = buildGroundingContext('s1', reader([note('a', atBudget), note('b', overflow)]));

    expect(ctx.truncated).toBe(true);
    expect(ctx.system).toMatch(/truncat/i);
    // Mutation target: remove the cap → the system balloons past the budget (plus a
    // small fixed overhead for the preamble + marker) and this assertion fails.
    expect(ctx.system.length).toBeLessThanOrEqual(GROUNDING_CHAR_BUDGET + 2_000);
  });

  it('slices a single over-budget note rather than including it whole', () => {
    const huge = 'z'.repeat(GROUNDING_CHAR_BUDGET + 5_000);
    const ctx = buildGroundingContext('s1', reader([note('a', huge)]));

    expect(ctx.noteCount).toBe(1);
    expect(ctx.truncated).toBe(true);
    expect(ctx.system).toMatch(/truncat/i);
    expect(ctx.system.length).toBeLessThanOrEqual(GROUNDING_CHAR_BUDGET + 2_000);
  });

  it('reads notes for the requested session id (single source of truth)', () => {
    let askedFor = '';
    const r: NoteReader = {
      listNotes: (id) => {
        askedFor = id;
        return [note('a', 'hi')];
      },
    };

    buildGroundingContext('session-xyz', r);

    expect(askedFor).toBe('session-xyz');
  });
});
