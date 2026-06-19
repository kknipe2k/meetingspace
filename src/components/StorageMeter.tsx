import { useEffect, useState, type ReactElement } from 'react';

import type { StorageSummary } from '@shared/types';

import { formatBytes } from '../format/bytes';
import { storageClient, type StorageClient } from '../ipc/client';

/*
 * The storage meter (M06.B, REVIEW-V11 F28). Shows total + per-session byte usage so disk growth
 * is visible (it was previously silent — F28). Reads the aggregate summary over IPC; holds no DB
 * handle and no key. Rendered inside Settings.
 */
export interface StorageMeterProps {
  /** Injectable for tests; defaults to the real storage IPC client. The meter only reads the
   *  summary, so the prop is narrowed to that one method (backup/restore live in Settings). */
  client?: Pick<StorageClient, 'summary'>;
}

export function StorageMeter({ client = storageClient }: StorageMeterProps): ReactElement {
  const [summary, setSummary] = useState<StorageSummary | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    client
      .summary()
      .then((result) => {
        if (active) {
          setSummary(result);
        }
      })
      .catch(() => {
        if (active) {
          setFailed(true);
        }
      });
    return () => {
      active = false;
    };
  }, [client]);

  return (
    <section className="settings-section storage-meter" data-testid="storage-meter">
      <h3 className="settings-subheading">Storage</h3>
      {failed && (
        <p className="settings-error" role="alert">
          Couldn’t read storage usage.
        </p>
      )}
      {summary && (
        <>
          <p className="storage-meter-total">
            Total used: <strong>{formatBytes(summary.totalBytes)}</strong>
          </p>
          {summary.perSession.length > 0 && (
            // Collapsible + scroll-bounded so a store with many sessions doesn't blow up the modal.
            <details className="storage-meter-details">
              <summary>Per-session breakdown ({summary.perSession.length})</summary>
              <ul className="storage-meter-list">
                {summary.perSession.map((s) => (
                  <li key={s.sessionId} className="storage-meter-row">
                    <span className="storage-meter-name">{s.name}</span>
                    <span className="storage-meter-bytes">{formatBytes(s.bytes)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}
