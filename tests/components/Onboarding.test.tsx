// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Onboarding } from '../../src/components/Onboarding';
import { ToastHost } from '../../src/components/ToastHost';
import { ToastProvider } from '../../src/hooks/useToasts';

/*
 * First-run onboarding (M06.E). Welcomes the user, lets them paste an Anthropic API key, and
 * seeds ONE sample space so the app isn't empty on first launch. Completing or skipping persists
 * the "seen" flag (onboardingSeen) so it appears exactly once. The key is handed straight to the
 * settings client (encrypted main-side, never rendered back) — same posture as SettingsModal.
 */
function fakes(): {
  settings: { setKey: ReturnType<typeof vi.fn>; setPrefs: ReturnType<typeof vi.fn> };
  sessions: { create: ReturnType<typeof vi.fn> };
  notes: { addWithContent: ReturnType<typeof vi.fn> };
  onComplete: ReturnType<typeof vi.fn>;
} {
  return {
    settings: {
      setKey: vi.fn().mockResolvedValue({ ok: true }),
      setPrefs: vi.fn().mockResolvedValue({ onboardingSeen: true }),
    },
    sessions: {
      create: vi.fn().mockResolvedValue({
        id: 'welcome-1',
        name: 'Welcome to MeetingSpace',
        createdAt: 1,
        updatedAt: 1,
      }),
    },
    notes: {
      addWithContent: vi.fn().mockResolvedValue({
        id: 'n1',
        sessionId: 'welcome-1',
        content: '',
        createdAt: 1,
        updatedAt: 1,
      }),
    },
    onComplete: vi.fn(),
  };
}

function renderOnboarding(f: ReturnType<typeof fakes>) {
  return render(
    <Onboarding
      settingsClient={f.settings}
      sessionClient={f.sessions}
      noteClient={f.notes}
      onComplete={f.onComplete}
    />,
  );
}

describe('Onboarding', () => {
  it('welcomes the user', () => {
    renderOnboarding(fakes());
    expect(screen.getByRole('heading', { name: /welcome to meetingspace/i })).toBeInTheDocument();
  });

  it('Get started: saves the entered key, seeds the sample space, persists the seen flag, completes', async () => {
    const f = fakes();
    renderOnboarding(f);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/Anthropic API key/i), 'sk-ant-api03-MyTestKey0001');
    await user.click(screen.getByRole('button', { name: /get started/i }));

    await waitFor(() => expect(f.onComplete).toHaveBeenCalledTimes(1));
    expect(f.settings.setKey).toHaveBeenCalledWith('sk-ant-api03-MyTestKey0001', 'anthropic');
    expect(f.sessions.create).toHaveBeenCalledWith('Welcome to MeetingSpace');
    expect(f.notes.addWithContent).toHaveBeenCalledWith('welcome-1', expect.any(String));
    expect(f.settings.setPrefs).toHaveBeenCalledWith({ onboardingSeen: true });
  });

  it('Get started with no key: still seeds the sample space and sets seen (key is optional)', async () => {
    const f = fakes();
    renderOnboarding(f);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /get started/i }));

    await waitFor(() => expect(f.onComplete).toHaveBeenCalledTimes(1));
    expect(f.settings.setKey).not.toHaveBeenCalled();
    expect(f.sessions.create).toHaveBeenCalledOnce();
    expect(f.settings.setPrefs).toHaveBeenCalledWith({ onboardingSeen: true });
  });

  it('Skip for now: sets the seen flag and completes WITHOUT seeding a sample space', async () => {
    const f = fakes();
    renderOnboarding(f);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /skip for now/i }));

    await waitFor(() => expect(f.onComplete).toHaveBeenCalledTimes(1));
    expect(f.settings.setPrefs).toHaveBeenCalledWith({ onboardingSeen: true });
    expect(f.sessions.create).not.toHaveBeenCalled();
    expect(f.settings.setKey).not.toHaveBeenCalled();
  });

  // F13: a failed mutation in onboarding is never silent — it surfaces a toast and keeps the modal
  // (does not complete into a half-set-up app). Mutation: dropping a surface() wrapper fails this.
  it('surfaces a failed sample-space create and does NOT complete (modal stays)', async () => {
    const f = fakes();
    f.sessions.create = vi.fn().mockRejectedValue(new Error('disk full'));
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Onboarding
          settingsClient={f.settings}
          sessionClient={f.sessions}
          noteClient={f.notes}
          onComplete={f.onComplete}
        />
        <ToastHost />
      </ToastProvider>,
    );

    await user.click(screen.getByRole('button', { name: /get started/i }));

    expect(await screen.findByText(/create the sample space/i)).toBeInTheDocument();
    expect(f.onComplete).not.toHaveBeenCalled();
    expect(f.notes.addWithContent).not.toHaveBeenCalled();
  });
});
