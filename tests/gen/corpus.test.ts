import { describe, expect, it } from 'vitest';

import {
  buildCorpus,
  CORPUS_CHAR_BUDGET,
  type CorpusAssetReader,
  type CorpusNoteReader,
} from '../../electron/gen/corpus';
import type { Asset, Note } from '@shared/types';

/*
 * Main-side corpus assembly (M04.A): notes become bounded text (reusing the M03
 * grounding budget + truncation-marker discipline — content is never dropped
 * silently), screenshots become base64 image content blocks for the multimodal
 * path. The corpus is BOUNDED on both axes; an empty session yields an empty
 * corpus so generation spends no tokens. Readers are injected (no DB, no disk).
 */
function note(content: string, id = 'n'): Note {
  return { id, sessionId: 's1', content, createdAt: 1, updatedAt: 1 };
}

function asset(id: string, relativePath: string): Asset {
  return { id, sessionId: 's1', kind: 'screenshot', relativePath, createdAt: 1 };
}

function notesWith(notes: Note[]): CorpusNoteReader {
  return { listNotes: () => notes };
}

function assetsWith(
  assets: Asset[],
  read: CorpusAssetReader['readImage'] = () => ({ mediaType: 'image/png', data: 'AAAA' }),
): CorpusAssetReader {
  return { listAssets: () => assets, readImage: read };
}

const NO_ASSETS = assetsWith([]);

describe('buildCorpus', () => {
  it('assembles content-bearing notes into bounded text', () => {
    const corpus = buildCorpus('s1', {
      notes: notesWith([note('Decided to ship Friday.'), note(''), note('Budget approved.')]),
      assets: NO_ASSETS,
    });

    expect(corpus.noteCount).toBe(2); // the blank note is excluded
    expect(corpus.text).toContain('Decided to ship Friday.');
    expect(corpus.text).toContain('Budget approved.');
    expect(corpus.truncated).toBe(false);
  });

  it('truncates note text to the budget and marks it (never drops silently)', () => {
    const huge = 'x'.repeat(CORPUS_CHAR_BUDGET + 5_000);
    const corpus = buildCorpus('s1', { notes: notesWith([note(huge)]), assets: NO_ASSETS });

    expect(corpus.truncated).toBe(true);
    expect(corpus.text.toLowerCase()).toContain('truncated');
    // the included note text is bounded — the full oversized content is not echoed
    expect(corpus.text.length).toBeLessThan(huge.length);
  });

  it('assembles screenshots into base64 image content blocks', () => {
    const corpus = buildCorpus('s1', {
      notes: notesWith([note('see screenshot')]),
      assets: assetsWith([asset('a1', 's1/a1.png')], () => ({
        mediaType: 'image/png',
        data: 'BASE64DATA',
      })),
    });

    expect(corpus.imageCount).toBe(1);
    expect(corpus.imageBlocks[0]).toEqual({
      type: 'image',
      source: { type: 'base64', mediaType: 'image/png', data: 'BASE64DATA' },
    });
  });

  it('skips assets the reader cannot decode (unsupported / unreadable -> null)', () => {
    const corpus = buildCorpus('s1', {
      notes: notesWith([note('hi')]),
      assets: assetsWith([asset('a1', 's1/a1.svg'), asset('a2', 's1/a2.png')], (a) =>
        a.id === 'a2' ? { mediaType: 'image/png', data: 'OK' } : null,
      ),
    });

    expect(corpus.imageCount).toBe(1);
    expect(corpus.imageBlocks[0]?.source.data).toBe('OK');
  });

  it('returns an empty corpus for a session with no content (no token spend downstream)', () => {
    const corpus = buildCorpus('s1', {
      notes: notesWith([note(''), note('   ')]),
      assets: NO_ASSETS,
    });

    expect(corpus.noteCount).toBe(0);
    expect(corpus.imageCount).toBe(0);
    expect(corpus.text).toBe('');
    expect(corpus.imageBlocks).toEqual([]);
  });
});
