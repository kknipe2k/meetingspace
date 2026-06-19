import type { Asset, LlmImageBlock, Note } from '@shared/types';

/*
 * Main-side corpus assembly (M04.A). On a generation request the main process
 * reads the session's notes and screenshots from storage (the single source of
 * truth — the renderer never supplies them) and assembles them into the model
 * input: notes as bounded text, screenshots as base64 image content blocks for
 * the multimodal path built in M03.B.
 *
 * The corpus is BOUNDED on both axes (mirroring M03 grounding): at most
 * CORPUS_CHAR_BUDGET characters of note text and at most CORPUS_MAX_IMAGES
 * screenshots within CORPUS_IMAGE_BUDGET_BYTES. When the session exceeds either
 * bound the included content is truncated and `truncated` is set — content is
 * never dropped silently. An empty session yields an empty corpus, so generation
 * spends no tokens.
 */
export interface CorpusNoteReader {
  listNotes(sessionId: string): Note[];
}

// A decoded screenshot ready to ride as a base64 image content block; null means
// the asset is unreadable or an unsupported image type and is skipped.
export interface CorpusImage {
  readonly mediaType: string;
  readonly data: string;
}

export interface CorpusAssetReader {
  listAssets(sessionId: string): Asset[];
  readImage(asset: Asset): CorpusImage | null;
}

export interface Corpus {
  /** The bounded session note text (empty when there is nothing to include). */
  readonly text: string;
  /** Screenshots as base64 image content blocks (bounded). */
  readonly imageBlocks: LlmImageBlock[];
  /** Count of content-bearing notes (0 ⇒ no text to ground on). */
  readonly noteCount: number;
  /** Count of included image blocks. */
  readonly imageCount: number;
  /** True when note text OR images were bounded out. */
  readonly truncated: boolean;
}

// ~100k characters of note text (~25k tokens) — generous for a meeting session,
// bounded so a runaway transcript can't blow up the request or the bill.
export const CORPUS_CHAR_BUDGET = 100_000;
// At most this many screenshots, within this many base64-decoded bytes, so a
// screenshot-heavy session can't blow up the request payload.
export const CORPUS_MAX_IMAGES = 20;
export const CORPUS_IMAGE_BUDGET_BYTES = 20 * 1024 * 1024;

const NOTE_SEPARATOR = '\n\n---\n\n';
const TRUNCATION_MARKER =
  '\n\n[…content truncated to fit the generation budget — some later notes or screenshots are not shown.]';

export function buildCorpus(
  sessionId: string,
  readers: { notes: CorpusNoteReader; assets: CorpusAssetReader },
): Corpus {
  const { text, noteCount, textTruncated } = assembleText(sessionId, readers.notes);
  const { imageBlocks, imageTruncated } = assembleImages(sessionId, readers.assets);

  const truncated = textTruncated || imageTruncated;
  const withMarker = text.length > 0 && truncated ? text + TRUNCATION_MARKER : text;

  return {
    text: withMarker,
    imageBlocks,
    noteCount,
    imageCount: imageBlocks.length,
    truncated,
  };
}

function assembleText(
  sessionId: string,
  notes: CorpusNoteReader,
): { text: string; noteCount: number; textTruncated: boolean } {
  const contentNotes = notes
    .listNotes(sessionId)
    .map((note) => note.content)
    .filter((content) => content.trim().length > 0);

  const parts: string[] = [];
  let used = 0;
  let textTruncated = false;
  for (const content of contentNotes) {
    if (used >= CORPUS_CHAR_BUDGET) {
      textTruncated = true;
      break;
    }
    const remaining = CORPUS_CHAR_BUDGET - used;
    if (content.length <= remaining) {
      parts.push(content);
      used += content.length;
    } else {
      parts.push(content.slice(0, remaining));
      used += remaining;
      textTruncated = true;
      break;
    }
  }

  return { text: parts.join(NOTE_SEPARATOR), noteCount: contentNotes.length, textTruncated };
}

function assembleImages(
  sessionId: string,
  assets: CorpusAssetReader,
): { imageBlocks: LlmImageBlock[]; imageTruncated: boolean } {
  const imageBlocks: LlmImageBlock[] = [];
  let bytes = 0;
  let imageTruncated = false;

  for (const asset of assets.listAssets(sessionId)) {
    if (imageBlocks.length >= CORPUS_MAX_IMAGES) {
      imageTruncated = true;
      break;
    }
    const image = assets.readImage(asset);
    if (!image) {
      continue; // unreadable / unsupported type — skip, don't fail the whole corpus
    }
    // base64 decodes to ~3/4 of its character length.
    const decodedBytes = Math.floor((image.data.length * 3) / 4);
    if (bytes + decodedBytes > CORPUS_IMAGE_BUDGET_BYTES) {
      imageTruncated = true;
      break;
    }
    bytes += decodedBytes;
    imageBlocks.push({
      type: 'image',
      source: { type: 'base64', mediaType: image.mediaType, data: image.data },
    });
  }

  return { imageBlocks, imageTruncated };
}
