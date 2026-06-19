import type { CaptureDeps, CapturerSource } from './screen-capture';

/*
 * Deterministic capture sources for tests (M05.A / TD-008). Gated by
 * MEETINGSPACE_FAKE_CAPTURE=1 AND an UNPACKAGED build in main.ts — mirrors the
 * MEETINGSPACE_FAKE_LLM seam (electron/llm/fake-streaming-client.ts) and is
 * structurally unreachable in a shipped app. It fakes ONLY the OS boundary
 * (`CaptureDeps`); the real createCaptureService logic still runs, so the picker
 * baseline exercises the genuine seam against a stable, machine-independent source
 * list instead of the live desktop (which is never pixel-stable across runners).
 */

// A 1×1 PNG data URL — a fixed preview so the picker grid renders identical pixels.
const FAKE_THUMBNAIL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function fakeSource(id: string, name: string): CapturerSource {
  return {
    id,
    name,
    display_id: '1',
    thumbnail: {
      toDataURL: () => FAKE_THUMBNAIL,
      toPNG: () => new Uint8Array([0]),
    },
  };
}

export function createFakeCaptureDeps(): CaptureDeps {
  const sources = [fakeSource('screen:0', 'Entire screen'), fakeSource('window:1', 'MeetingSpace')];
  return {
    getSources: () => Promise.resolve(sources),
    getMediaAccessStatus: () => 'granted',
    getDisplays: () => [{ id: 1, size: { width: 1920, height: 1080 }, scaleFactor: 1 }],
    platform: 'win32',
  };
}
