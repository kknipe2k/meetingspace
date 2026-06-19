import { inflateSync } from 'node:zlib';

/*
 * A minimal PNG decoder for e2e PAINT verification (M06.E real-blocker). The generated-doc
 * iframe is sandbox="" (opaque origin), so the parent page cannot read its contentDocument —
 * the ONLY way to prove it actually PAINTED (not merely that srcdoc is set and the box is
 * non-zero, which is what the prior false-green e2e checked) is to capture the composited
 * pixels via Playwright's element screenshot and inspect them.
 *
 * Playwright emits 8-bit RGBA, non-interlaced PNGs (colorType 6). We decode exactly that
 * shape: parse IHDR, concat + inflate IDAT, then un-filter the scanlines. No third-party
 * decoder is available at the top level (pngjs ships only minified inside playwright-core),
 * so this is intentionally self-contained and dependency-free.
 */
export interface DecodedPng {
  width: number;
  height: number;
  /** Normalized to RGBA, 4 bytes per pixel, row-major (regardless of source colorType). */
  data: Buffer;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePng(buffer: Buffer): DecodedPng {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG (bad signature)');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const data = buffer.subarray(dataStart, dataStart + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
      interlace = data.readUInt8(12);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataStart + length + 4; // +4 CRC
  }

  // colorType 2 = RGB (3 bytes/px), 6 = RGBA (4 bytes/px). Playwright emits either depending
  // on whether the captured region has transparency; we normalize both to RGBA output.
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
    throw new Error(
      `unsupported PNG shape (bitDepth=${bitDepth}, colorType=${colorType}, interlace=${interlace}) — expected 8-bit RGB/RGBA non-interlaced`,
    );
  }

  const raw = inflateSync(Buffer.concat(idat));
  const bpp = colorType === 6 ? 4 : 3; // source bytes per pixel
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);

  for (let y = 0; y < height; y += 1) {
    const filterType = raw[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x += 1) {
      const rawByte = raw[rowStart + x] ?? 0;
      const a = x >= bpp ? (out[y * stride + x - bpp] ?? 0) : 0; // left
      const b = y > 0 ? (out[(y - 1) * stride + x] ?? 0) : 0; // up
      const c = x >= bpp && y > 0 ? (out[(y - 1) * stride + x - bpp] ?? 0) : 0; // upper-left
      let value: number;
      switch (filterType) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = rawByte + a;
          break;
        case 2:
          value = rawByte + b;
          break;
        case 3:
          value = rawByte + ((a + b) >> 1);
          break;
        case 4:
          value = rawByte + paeth(a, b, c);
          break;
        default:
          throw new Error(`unsupported PNG filter ${filterType}`);
      }
      out[y * stride + x] = value & 0xff;
    }
  }

  if (bpp === 4) {
    return { width, height, data: out };
  }
  // Normalize RGB → RGBA so downstream pixel walks are uniform (alpha = 255).
  const rgba = Buffer.alloc(width * height * 4);
  for (let p = 0; p < width * height; p += 1) {
    rgba[p * 4] = out[p * 3] ?? 0;
    rgba[p * 4 + 1] = out[p * 3 + 1] ?? 0;
    rgba[p * 4 + 2] = out[p * 3 + 2] ?? 0;
    rgba[p * 4 + 3] = 255;
  }
  return { width, height, data: rgba };
}

export interface PaintStats {
  total: number;
  /** Pixels whose RGB differs from near-white by more than the tolerance. */
  nonBackground: number;
  /** nonBackground / total. */
  fraction: number;
  /** Count of distinct quantized (R,G,B) buckets — a uniform fill has very few. */
  distinctColors: number;
}

/*
 * Pixel statistics used to distinguish a PAINTED document (text, an accent border, etc.)
 * from a BLANK/white frame (the paint-failure symptom). A blank iframe screenshots as a
 * near-uniform white fill: nonBackground ≈ 0 and distinctColors ≈ 1.
 */
export function paintStats(buffer: Buffer, whiteTolerance = 12): PaintStats {
  const { width, height, data } = decodePng(buffer);
  const total = width * height;
  let nonBackground = 0;
  const buckets = new Set<number>();
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    if (255 - r > whiteTolerance || 255 - g > whiteTolerance || 255 - b > whiteTolerance) {
      nonBackground += 1;
    }
    // Quantize to 16 levels per channel so anti-aliasing noise doesn't explode the count.
    buckets.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
  }
  return {
    total,
    nonBackground,
    fraction: total === 0 ? 0 : nonBackground / total,
    distinctColors: buckets.size,
  };
}
