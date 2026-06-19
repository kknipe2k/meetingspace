import { useRef, type ClipboardEvent, type DragEvent, type ReactElement } from 'react';

import type { AssetKind } from '@shared/types';

export interface ScreenshotDropProps {
  onImage(file: File, kind: AssetKind): void;
}

function imageFiles(files: FileList | File[] | null | undefined): File[] {
  return Array.from(files ?? []).filter((file) => file.type.startsWith('image/'));
}

/*
 * The screenshot capture affordance: a drop zone that accepts three byte-source
 * paths (drag-drop, clipboard paste, file upload), all converging on the single
 * `onImage(file, kind)` callback the container turns into an asset:save. The
 * desktopCapturer path (M02.C) rides the same callback. Non-image payloads are
 * ignored. Presentational — it holds no asset state.
 */
export function ScreenshotDrop({ onImage }: ScreenshotDropProps): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    for (const file of imageFiles(event.dataTransfer.files)) {
      onImage(file, 'screenshot');
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>): void => {
    for (const item of Array.from(event.clipboardData.items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          onImage(file, 'paste');
        }
      }
    }
  };

  return (
    <div
      className="screenshot-drop"
      data-testid="screenshot-drop"
      onDragOver={(event) => event.preventDefault()}
      onDrop={handleDrop}
      onPaste={handlePaste}
    >
      <p className="screenshot-drop-hint">Drop or paste an image, or</p>
      <label className="btn btn-secondary screenshot-drop-upload">
        Upload image
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          aria-label="Add screenshot file"
          className="screenshot-drop-input"
          onChange={(event) => {
            for (const file of imageFiles(event.target.files)) {
              onImage(file, 'upload');
            }
            event.target.value = '';
          }}
        />
      </label>
    </div>
  );
}
