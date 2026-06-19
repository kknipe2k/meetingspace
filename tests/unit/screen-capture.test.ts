import { describe, expect, it, vi } from 'vitest';

import {
  CAPTURE_TYPES,
  PREVIEW_THUMBNAIL_SIZE,
  createCaptureService,
  isScreenCaptureGranted,
  resolveCaptureSize,
  selectSourceById,
  summarizeSources,
  type CapturerSource,
  type DisplayInfo,
} from '../../electron/screen-capture';

// A fake Electron DesktopCapturerSource — just the fields the service consumes.
// thumbnail is the NativeImage seam (toPNG for the grab bytes, toDataURL for the
// picker preview); display_id maps a screen source to a Display for native sizing.
function fakeSource(
  id: string,
  name: string,
  options: { displayId?: string; png?: Uint8Array; dataUrl?: string } = {},
): CapturerSource {
  const png = options.png ?? new Uint8Array([137, 80, 78, 71]);
  const dataUrl = options.dataUrl ?? `data:image/png;base64,${id}`;
  return {
    id,
    name,
    display_id: options.displayId ?? '',
    thumbnail: { toPNG: () => png, toDataURL: () => dataUrl },
  };
}

function display(id: number, width: number, height: number, scaleFactor: number): DisplayInfo {
  return { id, size: { width, height }, scaleFactor };
}

describe('selectSourceById', () => {
  it('returns the source whose id matches', () => {
    const sources = [fakeSource('screen:0', 'Screen 1'), fakeSource('window:7', 'Editor')];
    expect(selectSourceById(sources, 'window:7').name).toBe('Editor');
  });

  it('throws when no source matches the id', () => {
    expect(() => selectSourceById([fakeSource('screen:0', 'Screen 1')], 'nope')).toThrow();
  });
});

describe('isScreenCaptureGranted (the permission gate)', () => {
  it('grants on macOS only when the status is exactly "granted"', () => {
    expect(isScreenCaptureGranted('granted', 'darwin')).toBe(true);
    expect(isScreenCaptureGranted('denied', 'darwin')).toBe(false);
    expect(isScreenCaptureGranted('not-determined', 'darwin')).toBe(false);
    expect(isScreenCaptureGranted('restricted', 'darwin')).toBe(false);
  });

  it('treats non-macOS platforms as granted (Windows is the primary target)', () => {
    expect(isScreenCaptureGranted('unknown', 'win32')).toBe(true);
    expect(isScreenCaptureGranted('denied', 'win32')).toBe(true);
    expect(isScreenCaptureGranted('granted', 'linux')).toBe(true);
  });
});

describe('summarizeSources', () => {
  it('maps each source to an id/name/preview DTO from its thumbnail data URL', () => {
    const sources = [fakeSource('screen:0', 'Screen 1', { dataUrl: 'data:image/png;base64,AAA' })];
    expect(summarizeSources(sources)).toEqual([
      { id: 'screen:0', name: 'Screen 1', preview: 'data:image/png;base64,AAA' },
    ]);
  });
});

describe('resolveCaptureSize (native resolution, no downscaled grab)', () => {
  it('uses the matched display bounds multiplied by its scale factor', () => {
    const source = fakeSource('screen:0', 'Screen 1', { displayId: '12' });
    const displays = [display(12, 1920, 1080, 2)];
    expect(resolveCaptureSize(source, displays)).toEqual({ width: 3840, height: 2160 });
  });

  it('falls back to the primary display for a window source with no display match', () => {
    const source = fakeSource('window:7', 'Editor');
    const displays = [display(1, 2560, 1440, 1), display(2, 1280, 720, 1)];
    expect(resolveCaptureSize(source, displays)).toEqual({ width: 2560, height: 1440 });
  });

  it('sizes a non-primary monitor from ITS OWN display, rounding a fractional scale to integers', () => {
    // Primary is scale 1 (the app's screen); the secondary uses a fractional
    // Windows scale factor — its product must round to integers, not the
    // primary's box, or only the primary screen would grab.
    const primary = display(1, 2560, 1440, 1);
    const secondary = display(2, 1366, 768, 1.25);
    const source = fakeSource('screen:1', 'Secondary monitor', { displayId: '2' });

    const size = resolveCaptureSize(source, [primary, secondary]);

    expect(size).toEqual({ width: 1708, height: 960 }); // round(1366×1.25)=1708, 768×1.25=960
    expect(Number.isInteger(size.width) && Number.isInteger(size.height)).toBe(true);
  });
});

describe('createCaptureService.listSources', () => {
  it('returns granted plus the summarized sources, enumerating at the preview size', async () => {
    const getSources = vi.fn().mockResolvedValue([fakeSource('screen:0', 'Screen 1')]);
    const service = createCaptureService({
      getSources,
      getMediaAccessStatus: () => 'granted',
      getDisplays: () => [display(1, 1920, 1080, 1)],
      platform: 'win32',
    });

    const result = await service.listSources();

    expect(result.permission).toBe('granted');
    expect(result.sources).toEqual([
      { id: 'screen:0', name: 'Screen 1', preview: 'data:image/png;base64,screen:0' },
    ]);
    expect(getSources).toHaveBeenCalledWith({
      types: CAPTURE_TYPES,
      thumbnailSize: PREVIEW_THUMBNAIL_SIZE,
    });
  });

  it('returns the denied status with no sources and never enumerates when permission is missing', async () => {
    const getSources = vi.fn();
    const service = createCaptureService({
      getSources,
      getMediaAccessStatus: () => 'denied',
      getDisplays: () => [display(1, 1920, 1080, 1)],
      platform: 'darwin',
    });

    const result = await service.listSources();

    expect(result).toEqual({ permission: 'denied', sources: [] });
    expect(getSources).not.toHaveBeenCalled();
  });
});

describe('createCaptureService.grab', () => {
  it('captures the chosen source at native resolution and returns its PNG bytes', async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10]);
    const source = fakeSource('screen:0', 'Screen 1', { displayId: '9', png });
    const getSources = vi.fn().mockResolvedValue([source]);
    const service = createCaptureService({
      getSources,
      getMediaAccessStatus: () => 'granted',
      getDisplays: () => [display(9, 1600, 900, 2)],
      platform: 'win32',
    });

    const bytes = await service.grab('screen:0');

    expect(new Uint8Array(bytes)).toEqual(png);
    // The second (grab) enumeration requests the native display bounds × scale.
    expect(getSources).toHaveBeenLastCalledWith({
      types: CAPTURE_TYPES,
      thumbnailSize: { width: 3200, height: 1800 },
    });
  });

  it('captures a non-primary monitor at its own (integer) native size, not the primary box', async () => {
    const appPng = new Uint8Array([1, 1, 1]);
    const secondaryPng = new Uint8Array([2, 2, 2]);
    const appScreen = fakeSource('screen:0', 'Primary', { displayId: '1', png: appPng });
    const secondary = fakeSource('screen:1', 'Secondary monitor', {
      displayId: '2',
      png: secondaryPng,
    });
    const getSources = vi.fn().mockResolvedValue([appScreen, secondary]);
    const service = createCaptureService({
      getSources,
      getMediaAccessStatus: () => 'granted',
      // Primary scale 1; secondary a fractional Windows scale factor.
      getDisplays: () => [display(1, 2560, 1440, 1), display(2, 1366, 768, 1.25)],
      platform: 'win32',
    });

    const bytes = await service.grab('screen:1');

    // The non-primary screen actually captured (its bytes, not the app's)…
    expect(new Uint8Array(bytes)).toEqual(secondaryPng);
    // …at its OWN display's integer native size, not the primary's 2560×1440.
    expect(getSources).toHaveBeenLastCalledWith({
      types: CAPTURE_TYPES,
      thumbnailSize: { width: 1708, height: 960 },
    });
  });

  it('throws when the source id is unknown', async () => {
    const getSources = vi.fn().mockResolvedValue([fakeSource('screen:0', 'Screen 1')]);
    const service = createCaptureService({
      getSources,
      getMediaAccessStatus: () => 'granted',
      getDisplays: () => [display(1, 1920, 1080, 1)],
      platform: 'win32',
    });

    await expect(service.grab('window:does-not-exist')).rejects.toThrow();
  });

  it('refuses to capture (never a black frame) when permission is not granted', async () => {
    const getSources = vi.fn();
    const service = createCaptureService({
      getSources,
      getMediaAccessStatus: () => 'denied',
      getDisplays: () => [display(1, 1920, 1080, 1)],
      platform: 'darwin',
    });

    await expect(service.grab('screen:0')).rejects.toThrow();
    expect(getSources).not.toHaveBeenCalled();
  });
});
