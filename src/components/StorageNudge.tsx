import { useEffect } from 'react';

import { crossesStorageThreshold } from '@shared/limits';

import { useToasts } from '../hooks/useToasts';
import { storageClient, type StorageClient } from '../ipc/client';

/*
 * Storage threshold nudge (M06.B, REVIEW-V11 F28). On mount (≈ once per app run) reads the total
 * usage and, if it has crossed the soft threshold, raises ONE informational toast so silent disk
 * growth becomes visible. Renderer-only — reads aggregate counts, holds no key and no DB handle.
 */
export interface StorageNudgeProps {
  /** Injectable for tests; defaults to the real storage IPC client. */
  client?: StorageClient;
}

export function StorageNudge({ client = storageClient }: StorageNudgeProps): null {
  const { show } = useToasts();

  useEffect(() => {
    let active = true;
    client
      .summary()
      .then((summary) => {
        if (active && crossesStorageThreshold(summary.totalBytes)) {
          show({
            key: 'storage-threshold',
            variant: 'info',
            message:
              'MeetingSpace is using over 1 GB of storage — consider deleting old sessions to free space.',
            durationMs: 10_000,
          });
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, show]);

  return null;
}
