import type { CaptureSource, CaptureSourcesResult } from '@shared/types';

/*
 * In-app screen capture (M02.C, gotcha §4). The fourth screenshot path runs
 * entirely in the main process: desktopCapturer enumerates the screens/windows,
 * the renderer shows a picker, and the chosen source is captured to PNG bytes
 * that flow back through the existing asset:save pipeline (Stage B). Capturing
 * main-side means the renderer never holds a screen MediaStream.
 *
 * The Electron OS calls (desktopCapturer.getSources, systemPreferences
 * .getMediaAccessStatus, screen.getAllDisplays) are injected as `deps`, so the
 * orchestration logic — permission gating, native-resolution sizing, source
 * selection — is unit-tested under Node without an Electron runtime
 * (tests/unit/screen-capture.test.ts). main.ts supplies the real Electron
 * functions; that one injection is the thin, uncovered wrapper.
 *
 * Web-verified for Electron 41 (desktopCapturer is Main-process only; thumbnails
 * are NativeImages; macOS Screen Recording status comes from
 * systemPreferences.getMediaAccessStatus('screen')).
 */

// A NativeImage as we use it: the picker preview (data URL) and the grab (PNG).
export interface NativeThumbnail {
  toPNG(): Uint8Array;
  toDataURL(): string;
}

// The fields we consume from an Electron DesktopCapturerSource. `display_id`
// maps a screen source to a Display so the grab captures at native resolution.
export interface CapturerSource {
  readonly id: string;
  readonly name: string;
  readonly display_id: string;
  readonly thumbnail: NativeThumbnail;
}

export interface DisplayInfo {
  readonly id: number;
  readonly size: { readonly width: number; readonly height: number };
  readonly scaleFactor: number;
}

interface CaptureSize {
  readonly width: number;
  readonly height: number;
}

export interface CaptureDeps {
  getSources(options: {
    types: readonly string[];
    thumbnailSize: CaptureSize;
  }): Promise<CapturerSource[]>;
  getMediaAccessStatus(mediaType: 'screen'): string;
  getDisplays(): DisplayInfo[];
  platform: string;
}

export interface CaptureService {
  listSources(): Promise<CaptureSourcesResult>;
  grab(sourceId: string): Promise<ArrayBuffer>;
}

export const CAPTURE_TYPES: readonly string[] = ['screen', 'window'];

// Small previews for the picker grid; the grab re-enumerates at native size.
export const PREVIEW_THUMBNAIL_SIZE: CaptureSize = { width: 320, height: 180 };

// 0×0 disables thumbnail generation (Electron) — a cheap metadata-only pass to
// read the chosen source's display_id before the full-resolution grab.
const METADATA_THUMBNAIL_SIZE: CaptureSize = { width: 0, height: 0 };

const FALLBACK_CAPTURE_SIZE: CaptureSize = { width: 1920, height: 1080 };

export function selectSourceById(sources: CapturerSource[], id: string): CapturerSource {
  const source = sources.find((candidate) => candidate.id === id);
  if (!source) {
    throw new Error(`screen capture: no source matches id ${id}`);
  }
  return source;
}

/*
 * macOS (10.15+) requires Screen Recording permission, which can only be granted
 * in System Settings — without it desktopCapturer yields black frames. We gate on
 * the status BEFORE offering or performing a grab so a black frame is never
 * written. Windows (and other platforms) need no such grant — treat as granted.
 */
export function isScreenCaptureGranted(status: string, platform: string): boolean {
  if (platform !== 'darwin') {
    return true;
  }
  return status === 'granted';
}

export function summarizeSources(sources: CapturerSource[]): CaptureSource[] {
  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    preview: source.thumbnail.toDataURL(),
  }));
}

/*
 * The native capture size for a source: the bounds of ITS OWN display × that
 * display's scale factor (so a HiDPI screen is captured at full device pixels,
 * never downscaled). getSources applies one thumbnailSize to every enumerated
 * source, so this must be sized from the chosen source's own display (matched by
 * display_id) — sizing from a single/primary display captures non-primary
 * monitors at the wrong box. The product is ROUNDED TO INTEGERS: a fractional
 * scaleFactor (e.g. 1.25/1.5 on Windows) otherwise yields a non-integer
 * thumbnailSize that getSources mishandles, so only the scale-1 (primary) screen
 * grabbed. A window source carries no display_id — fall back to the primary
 * display's native bounds.
 */
export function resolveCaptureSize(source: CapturerSource, displays: DisplayInfo[]): CaptureSize {
  const matched = displays.find((display) => String(display.id) === source.display_id);
  const chosen = matched ?? displays[0];
  if (!chosen) {
    return FALLBACK_CAPTURE_SIZE;
  }
  return {
    width: Math.round(chosen.size.width * chosen.scaleFactor),
    height: Math.round(chosen.size.height * chosen.scaleFactor),
  };
}

export function createCaptureService(deps: CaptureDeps): CaptureService {
  const permissionStatus = (): string =>
    deps.platform === 'darwin' ? deps.getMediaAccessStatus('screen') : 'granted';

  return {
    async listSources(): Promise<CaptureSourcesResult> {
      const status = permissionStatus();
      if (!isScreenCaptureGranted(status, deps.platform)) {
        return { permission: status, sources: [] };
      }
      const sources = await deps.getSources({
        types: CAPTURE_TYPES,
        thumbnailSize: PREVIEW_THUMBNAIL_SIZE,
      });
      return { permission: 'granted', sources: summarizeSources(sources) };
    },

    async grab(sourceId: string): Promise<ArrayBuffer> {
      const status = permissionStatus();
      if (!isScreenCaptureGranted(status, deps.platform)) {
        throw new Error('screen capture: permission not granted');
      }
      const metadata = await deps.getSources({
        types: CAPTURE_TYPES,
        thumbnailSize: METADATA_THUMBNAIL_SIZE,
      });
      const chosen = selectSourceById(metadata, sourceId);
      const thumbnailSize = resolveCaptureSize(chosen, deps.getDisplays());
      const captured = await deps.getSources({ types: CAPTURE_TYPES, thumbnailSize });
      const png = selectSourceById(captured, sourceId).thumbnail.toPNG();
      return png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
    },
  };
}
