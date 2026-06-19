import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { thumbnailRelativePath } from '../../shared/images/thumbnail-path';
import {
  makeThumbnail,
  backfillThumbnails,
  thumbnailAbsolutePath,
  THUMBNAIL_MAX_EDGE,
  type ThumbnailCodec,
} from '../../electron/thumbnails';
import { openDatabase } from '../../electron/storage/db';
import { DEFAULT_SPACE_ID } from '../../electron/storage/schema';

/*
 * F25 (REVIEW-V11): full-resolution images were mounted eagerly with no derivatives. The fix
 * generates a downscaled JPEG thumbnail at save time (and an idempotent startup backfill for
 * pre-M06.C assets), stored as a sibling blob by CONVENTION — `<sessionId>/<id>.thumb.jpg` —
 * so NO schema migration is needed (M06.C adds none). The grid serves the thumb; the lightbox
 * + export keep full-res; a missing thumb (or a decode failure, the C-14 class) falls back to
 * the full image. The path convention is the ONE source shared by main + renderer.
 */
describe('thumbnailRelativePath (shared convention)', () => {
  it('derives <sessionId>/<id>.thumb.jpg from the full blob path, replacing the extension', () => {
    expect(thumbnailRelativePath('s1/abc.png')).toBe('s1/abc.thumb.jpg');
    expect(thumbnailRelativePath('s1/abc.jpeg')).toBe('s1/abc.thumb.jpg');
    expect(thumbnailRelativePath('sess/id-with.dots.webp')).toBe('sess/id-with.dots.thumb.jpg');
  });
});

describe('thumbnailAbsolutePath (on-save destination, confined to the assets root)', () => {
  it('resolves the sibling thumb path under the session dir', () => {
    const abs = thumbnailAbsolutePath('/root', 's1', 's1/abc.png');
    expect(abs).not.toBeNull();
    expect(abs?.replace(/\\/g, '/')).toMatch(/\/root\/s1\/abc\.thumb\.jpg$/);
  });

  it('rejects a path that would escape the assets root (confinement)', () => {
    expect(thumbnailAbsolutePath('/root', '..', '../evil.png')).toBeNull();
  });
});

// A fake codec: reports a fixed natural size and returns a marker JPEG buffer, recording the
// target width it was asked for — so the don't-upscale + skip-empty logic is testable in Node.
function fakeCodec(natural: { width: number; height: number; empty?: boolean }): {
  codec: ThumbnailCodec;
  widths: number[];
} {
  const widths: number[] = [];
  return {
    widths,
    codec: {
      decode: () => ({
        width: natural.width,
        height: natural.height,
        empty: natural.empty ?? false,
      }),
      encodeJpeg: (_bytes, targetWidth) => {
        widths.push(targetWidth);
        return Buffer.from(`JPEG@${targetWidth}`);
      },
    },
  };
}

describe('makeThumbnail', () => {
  it('downscales a large image to the max edge (never wider than the cap)', () => {
    const { codec, widths } = fakeCodec({ width: 4000, height: 3000 });
    const out = makeThumbnail(new Uint8Array([1, 2, 3]), codec);
    expect(out?.toString()).toBe(`JPEG@${THUMBNAIL_MAX_EDGE}`);
    expect(widths).toEqual([THUMBNAIL_MAX_EDGE]);
  });

  it('NEVER upscales a small image (target width clamps to the natural width)', () => {
    const { codec, widths } = fakeCodec({ width: 120, height: 90 });
    makeThumbnail(new Uint8Array([1]), codec);
    expect(widths).toEqual([120]);
  });

  it('returns null on an undecodable image (the C-14 class) so the grid falls back to full-res', () => {
    const { codec } = fakeCodec({ width: 0, height: 0, empty: true });
    expect(makeThumbnail(new Uint8Array([1]), codec)).toBeNull();
  });
});

describe('backfillThumbnails', () => {
  let dir: string;
  let dbPath: string;
  let assetsRoot: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'meetingspace-thumbs-'));
    dbPath = join(dir, 'store.db');
    assetsRoot = join(dir, 'assets');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function seedAsset(db: Database.Database, id: string): void {
    const sessionId = 's1';
    db.prepare('INSERT OR IGNORE INTO sessions VALUES (?, ?, ?, ?, ?)').run(
      sessionId,
      DEFAULT_SPACE_ID,
      'S',
      1,
      1,
    );
    db.prepare(
      'INSERT INTO assets (id, session_id, kind, relative_path, created_at, byte_size) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, sessionId, 'capture', `${sessionId}/${id}.png`, 1, 4);
    const fullPath = join(assetsRoot, sessionId, `${id}.png`);
    writeFileSync(fullPath, Buffer.from([0, 1, 2, 3]));
  }

  function deps(): Parameters<typeof backfillThumbnails>[2] {
    return {
      readBytes: (abs) => (existsSync(abs) ? new Uint8Array(readFileSync(abs)) : null),
      writeThumb: (abs, buf) => writeFileSync(abs, buf),
      makeThumb: () => Buffer.from('THUMB'),
    };
  }

  it('generates a sibling .thumb.jpg for every asset lacking one and is idempotent on re-run', () => {
    const db = openDatabase(dbPath);
    // openDatabase creates the assets dir parent lazily on write; ensure the session dir exists.
    rmSync(assetsRoot, { recursive: true, force: true });
    mkdirSync(join(assetsRoot, 's1'), { recursive: true });
    seedAsset(db, 'a');
    seedAsset(db, 'b');

    const first = backfillThumbnails(db, assetsRoot, deps());
    expect(first).toBe(2);
    expect(existsSync(join(assetsRoot, 's1', 'a.thumb.jpg'))).toBe(true);
    expect(existsSync(join(assetsRoot, 's1', 'b.thumb.jpg'))).toBe(true);

    // Idempotent: a second run finds both thumbs present and generates none.
    const second = backfillThumbnails(db, assetsRoot, deps());
    expect(second).toBe(0);
    db.close();
  });

  it('skips an asset whose source is unreadable or undecodable rather than crashing the pass', () => {
    const db = openDatabase(dbPath);
    mkdirSync(join(assetsRoot, 's1'), { recursive: true });
    seedAsset(db, 'a');
    // 'b' row exists but its blob is missing on disk.
    db.prepare('INSERT OR IGNORE INTO sessions VALUES (?, ?, ?, ?, ?)').run(
      'b',
      DEFAULT_SPACE_ID,
      'S',
      1,
      1,
    );
    db.prepare(
      'INSERT INTO assets (id, session_id, kind, relative_path, created_at, byte_size) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('b', 's1', 'capture', 's1/b.png', 1, 0);

    const generated = backfillThumbnails(db, assetsRoot, {
      readBytes: (abs) => (existsSync(abs) ? new Uint8Array(readFileSync(abs)) : null),
      writeThumb: (abs, buf) => writeFileSync(abs, buf),
      makeThumb: (bytes) => (bytes.length > 0 ? Buffer.from('THUMB') : null),
    });
    expect(generated).toBe(1); // only 'a' had readable bytes
    db.close();
  });
});
