import type { ReactElement } from 'react';

import type { Session } from '@shared/types';

import {
  assetClient,
  captureClient,
  noteClient,
  type AssetClient,
  type CaptureClient,
  type NoteClient,
} from '../ipc/client';

import { EmptyState } from './EmptyState';
import { NoteBlocks } from './NoteBlocks';
import { Screenshots } from './Screenshots';

export interface SessionCanvasProps {
  session: Session | null;
  noteClient?: NoteClient;
  assetClient?: AssetClient;
  captureClient?: CaptureClient;
  /** Bumped to make the note list re-fetch (e.g. after a chat reply is saved, M03.D). */
  notesReloadToken?: number;
  /** Create a session from the no-session empty state (M05.A). */
  onCreateSession?(): void;
}

export function SessionCanvas({
  session,
  noteClient: notes = noteClient,
  assetClient: assets = assetClient,
  captureClient: capture = captureClient,
  notesReloadToken = 0,
  onCreateSession,
}: SessionCanvasProps): ReactElement {
  return (
    <main className="zone zone-canvas" data-testid="zone-canvas" aria-label="Session canvas">
      {session ? (
        <div className="canvas-session">
          <h1 className="canvas-title">{session.name}</h1>
          <NoteBlocks
            key={`notes-${session.id}`}
            sessionId={session.id}
            client={notes}
            reloadToken={notesReloadToken}
          />
          <Screenshots
            key={`shots-${session.id}`}
            sessionId={session.id}
            client={assets}
            capture={capture}
          />
        </div>
      ) : (
        <EmptyState
          className="canvas-empty"
          headline="No session selected"
          hint="Select a session on the left, or create a new one."
          {...(onCreateSession
            ? { action: { label: 'Create a session', onClick: onCreateSession } }
            : {})}
        />
      )}
    </main>
  );
}
