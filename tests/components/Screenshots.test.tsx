// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AssetsApi, CaptureApi } from '@shared/api';
import type { Asset, CaptureSource } from '@shared/types';

import { Screenshots } from '../../src/components/Screenshots';

// A fake assets client backed by an in-memory list, capturing save/delete calls
// so the container's three ingest paths (drop / paste / file-upload) and the
// thumbnail grid are exercised at the renderer level without a real window.api.
function asset(id: string, sessionId = 's1'): Asset {
  return {
    id,
    sessionId,
    kind: 'screenshot',
    relativePath: `${sessionId}/${id}.png`,
    createdAt: 1,
  };
}

function fakeAssets(seed: Asset[]): {
  client: AssetsApi;
  saves: Array<{ mime: string; kind: string; byteLength: number }>;
  deleted: string[];
} {
  let rows = [...seed];
  let seq = seed.length;
  const saves: Array<{ mime: string; kind: string; byteLength: number }> = [];
  const deleted: string[] = [];
  return {
    saves,
    deleted,
    client: {
      list: () => Promise.resolve([...rows]),
      save: (sessionId, bytes, mime, kind) => {
        saves.push({ mime, kind, byteLength: bytes.byteLength });
        seq += 1;
        const created = asset(`shot${seq}`, sessionId);
        rows.push(created);
        return Promise.resolve(created);
      },
      delete: (id) => {
        deleted.push(id);
        rows = rows.filter((r) => r.id !== id);
        return Promise.resolve();
      },
    },
  };
}

function imageFile(name = 'shot.png', type = 'image/png'): File {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type });
}

// A fake capture client: listSources returns the given sources/permission, grab
// returns fixed PNG bytes — so the container's screen-capture path (open picker →
// pick → grab → asset:save) is exercised without a real desktopCapturer.
function fakeCapture(
  sources: CaptureSource[],
  permission = 'granted',
): { client: CaptureApi; grabbed: string[] } {
  const grabbed: string[] = [];
  return {
    grabbed,
    client: {
      listSources: () => Promise.resolve({ permission, sources }),
      grab: (sourceId) => {
        grabbed.push(sourceId);
        return Promise.resolve(new Uint8Array([137, 80, 78, 71]).buffer);
      },
    },
  };
}

const SCREEN_SOURCE: CaptureSource = {
  id: 'screen:0',
  name: 'Entire screen',
  preview: 'data:image/png;base64,AAA',
};

let fake: ReturnType<typeof fakeAssets>;

beforeEach(() => {
  fake = fakeAssets([asset('existing')]);
});

function thumbs(): HTMLElement[] {
  return screen.queryAllByTestId('screenshot-thumb');
}

describe('Screenshots', () => {
  it('renders existing screenshots as lazy thumbnail derivatives served from the asset scheme', async () => {
    render(<Screenshots sessionId="s1" client={fake.client} />);

    await waitFor(() => expect(thumbs()).toHaveLength(1));
    // M06.C (F25): the grid shows the downscaled sibling thumbnail, lazily loaded.
    expect(screen.getByRole('img', { name: /screenshot 1/i })).toHaveAttribute(
      'src',
      'asset://s1/existing.thumb.jpg',
    );
  });

  it('stores a dropped image as kind "screenshot"', async () => {
    render(<Screenshots sessionId="s1" client={fake.client} />);
    await waitFor(() => expect(thumbs()).toHaveLength(1));

    fireEvent.drop(screen.getByTestId('screenshot-drop'), {
      dataTransfer: { files: [imageFile()] },
    });

    await waitFor(() => expect(fake.saves).toHaveLength(1));
    expect(fake.saves[0]).toMatchObject({ mime: 'image/png', kind: 'screenshot' });
    await waitFor(() => expect(thumbs()).toHaveLength(2));
  });

  it('stores a pasted image as kind "paste"', async () => {
    render(<Screenshots sessionId="s1" client={fake.client} />);
    await waitFor(() => expect(thumbs()).toHaveLength(1));

    const file = imageFile('pasted.png');
    fireEvent.paste(screen.getByTestId('screenshot-drop'), {
      clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] },
    });

    await waitFor(() => expect(fake.saves).toHaveLength(1));
    expect(fake.saves[0]).toMatchObject({ kind: 'paste' });
  });

  it('stores an uploaded file as kind "upload"', async () => {
    render(<Screenshots sessionId="s1" client={fake.client} />);
    await waitFor(() => expect(thumbs()).toHaveLength(1));

    fireEvent.change(screen.getByLabelText('Add screenshot file'), {
      target: { files: [imageFile('chosen.png')] },
    });

    await waitFor(() => expect(fake.saves).toHaveLength(1));
    expect(fake.saves[0]).toMatchObject({ kind: 'upload' });
  });

  it('ignores a non-image drop', async () => {
    render(<Screenshots sessionId="s1" client={fake.client} />);
    await waitFor(() => expect(thumbs()).toHaveLength(1));

    fireEvent.drop(screen.getByTestId('screenshot-drop'), {
      dataTransfer: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })] },
    });

    // No save scheduled for a non-image; give any stray async a tick.
    await Promise.resolve();
    expect(fake.saves).toEqual([]);
  });

  it('deletes a screenshot', async () => {
    render(<Screenshots sessionId="s1" client={fake.client} />);
    await waitFor(() => expect(thumbs()).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: 'Delete screenshot 1' }));

    await waitFor(() => expect(thumbs()).toHaveLength(0));
    expect(fake.deleted).toEqual(['existing']);
  });

  it('opens the capture picker and stores the grabbed screen as kind "capture"', async () => {
    const capture = fakeCapture([SCREEN_SOURCE]);
    render(<Screenshots sessionId="s1" client={fake.client} capture={capture.client} />);
    await waitFor(() => expect(thumbs()).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: 'Capture screen' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Entire screen' }));

    await waitFor(() => expect(capture.grabbed).toEqual(['screen:0']));
    await waitFor(() => expect(fake.saves).toHaveLength(1));
    expect(fake.saves[0]).toMatchObject({ mime: 'image/png', kind: 'capture' });
    // The picker closes and the captured screenshot joins the grid.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(thumbs()).toHaveLength(2));
  });

  it('shows the guided permission error and grabs nothing when capture is denied', async () => {
    const capture = fakeCapture([], 'denied');
    render(<Screenshots sessionId="s1" client={fake.client} capture={capture.client} />);
    await waitFor(() => expect(thumbs()).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: 'Capture screen' }));

    expect(await screen.findByText(/screen recording/i)).toBeInTheDocument();
    expect(capture.grabbed).toEqual([]);
    expect(fake.saves).toEqual([]);
  });
});
