import { type ReactElement } from 'react';

import type { CaptureSourcesResult } from '@shared/types';

import { Modal } from './Modal';

export interface CapturePickerProps {
  result: CaptureSourcesResult;
  onPick(sourceId: string): void;
  onClose(): void;
}

/*
 * The screen-capture source picker (M02.C). It now consumes the shared Modal
 * (M03.A): scrim, shadow-lg, role="dialog", and a REAL focus trap (Tab contained,
 * focus restored) — resolving the M02 over-claim. Presentational — the container
 * (Screenshots) loads the sources and turns a pick into a grab → asset:save. When
 * permission is missing (macOS), the sources list is empty and we render a guided
 * error instead of an empty grid, never offering a grab (gotcha §4 — no
 * black-frame capture).
 */
export function CapturePicker({ result, onPick, onClose }: CapturePickerProps): ReactElement {
  const granted = result.permission === 'granted';

  return (
    <Modal
      label="Capture screen"
      className="capture-modal"
      scrimTestId="capture-scrim"
      onClose={onClose}
    >
      <h2 className="capture-modal-title">Capture screen</h2>

      {granted ? (
        <ul className="capture-source-grid">
          {result.sources.map((source) => (
            <li key={source.id}>
              <button
                type="button"
                className="capture-source"
                data-testid="capture-source"
                aria-label={source.name}
                onClick={() => onPick(source.id)}
              >
                <img className="capture-source-preview" src={source.preview} alt="" />
                <span className="capture-source-name">{source.name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="capture-permission-error">
          MeetingSpace needs Screen Recording permission to capture your screen. Grant it in System
          Settings › Privacy &amp; Security › Screen Recording, then try again.
        </p>
      )}

      <div className="capture-modal-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
