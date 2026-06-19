import { useCallback, useEffect, useState, type ReactElement } from 'react';

import type { Asset, AssetKind, CaptureSourcesResult } from '@shared/types';

import { useMutationToast } from '../hooks/useMutationToast';
import { useToasts } from '../hooks/useToasts';
import { assetClient, captureClient, type AssetClient, type CaptureClient } from '../ipc/client';

import { CapturePicker } from './CapturePicker';
import { EmptyState } from './EmptyState';
import { ErrorState } from './ErrorState';
import { ScreenshotDrop } from './ScreenshotDrop';
import { Thumbnail } from './Thumbnail';

type LoadStatus = 'loading' | 'ready' | 'error';

export interface ScreenshotsProps {
  sessionId: string;
  client?: AssetClient;
  capture?: CaptureClient;
}

/*
 * The session's screenshot surface (M02.B/C): the capture affordances — drag-drop
 * / paste / file-upload (Stage B) and in-app screen capture (Stage C) — over a
 * thumbnail grid. Loads the session's assets on open and owns add/delete. Every
 * path converges on the typed asset client, so the renderer never touches the
 * filesystem; the screen-capture path grabs PNG bytes from the main process and
 * stores them through the same asset:save (kind 'capture').
 *
 * Render this keyed by session id (see SessionCanvas) so switching sessions
 * remounts with a fresh load.
 */
export function Screenshots({
  sessionId,
  client = assetClient,
  capture = captureClient,
}: ScreenshotsProps): ReactElement {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [status, setStatus] = useState<LoadStatus>('loading');
  // Bumped by the error-state Retry to re-run the load (M05.A).
  const [retryToken, setRetryToken] = useState(0);
  const [picker, setPicker] = useState<CaptureSourcesResult | null>(null);
  const { surface } = useMutationToast();
  const { show } = useToasts();

  useEffect(() => {
    let active = true;
    setStatus('loading');
    client
      .list(sessionId)
      .then((items) => {
        if (active) {
          setAssets(items);
          setStatus('ready');
        }
      })
      .catch(() => {
        if (active) {
          setStatus('error');
        }
      });
    return () => {
      active = false;
    };
  }, [client, sessionId, retryToken]);

  const storeImage = useCallback(
    async (bytes: ArrayBuffer, mime: string, kind: AssetKind): Promise<void> => {
      const saved = await surface(
        () => client.save(sessionId, bytes, mime, kind),
        "Couldn't save the screenshot — it may be too large.",
      );
      if (saved) {
        setAssets((prev) => [...prev, saved]);
      }
    },
    [client, sessionId, surface],
  );

  const handleImage = useCallback(
    async (file: File, kind: AssetKind): Promise<void> => {
      await storeImage(await file.arrayBuffer(), file.type, kind);
    },
    [storeImage],
  );

  const handleDelete = useCallback(
    (id: string): void => {
      const index = assets.findIndex((asset) => asset.id === id);
      const removed = assets[index];
      if (!removed) {
        return;
      }
      // Optimistic removal; restore + surface on failure so the grid never desyncs from storage.
      setAssets((prev) => prev.filter((asset) => asset.id !== id));
      client.delete(id).catch(() => {
        setAssets((prev) => {
          const next = [...prev];
          next.splice(Math.min(index, next.length), 0, removed);
          return next;
        });
        show({ variant: 'error', message: "Couldn't delete the screenshot." });
      });
    },
    [assets, client, show],
  );

  const openPicker = useCallback(async (): Promise<void> => {
    setPicker(await capture.listSources());
  }, [capture]);

  const handlePick = useCallback(
    async (sourceId: string): Promise<void> => {
      setPicker(null);
      const bytes = await capture.grab(sourceId);
      await storeImage(bytes, 'image/png', 'capture');
    },
    [capture, storeImage],
  );

  return (
    <section className="screenshots" aria-label="Screenshots" aria-busy={status === 'loading'}>
      <ScreenshotDrop onImage={(file, kind) => void handleImage(file, kind)} />
      <button
        type="button"
        className="btn btn-secondary screenshots-capture"
        onClick={() => void openPicker()}
      >
        Capture screen
      </button>

      {status === 'loading' && <p className="zone-loading">Loading screenshots…</p>}

      {status === 'error' && (
        <ErrorState
          className="screenshots-error"
          message="Couldn't load screenshots for this session."
          onRetry={() => setRetryToken((token) => token + 1)}
        />
      )}

      {status === 'ready' && assets.length === 0 && (
        <EmptyState
          className="screenshots-empty"
          headline="No screenshots yet"
          hint="Drag, paste, upload, or capture your screen."
        />
      )}

      {status === 'ready' && assets.length > 0 && (
        <div className="screenshot-grid">
          {assets.map((asset, i) => (
            <Thumbnail key={asset.id} asset={asset} index={i + 1} onDelete={handleDelete} />
          ))}
        </div>
      )}
      {picker && (
        <CapturePicker
          result={picker}
          onPick={(sourceId) => void handlePick(sourceId)}
          onClose={() => setPicker(null)}
        />
      )}
    </section>
  );
}
