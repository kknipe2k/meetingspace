import { useCallback, useState, type ReactElement } from 'react';

import type { NoteClient, SessionClient, SettingsClient } from '../ipc/client';
import { useMutationToast } from '../hooks/useMutationToast';

import { Modal } from './Modal';

/*
 * First-run onboarding (M06.E). Welcomes the user, lets them paste an Anthropic API key, and
 * seeds ONE sample space so the app isn't empty on first launch. Completing ("Get started") or
 * skipping persists the seen flag (onboardingSeen) — gated with hasKey in shouldShowOnboarding —
 * so the flow appears exactly once. The key is handed straight to the settings client (encrypted
 * main-side, never rendered back), the same posture as SettingsModal; the renderer holds no key.
 *
 * Every mutation (setKey / create / addWithContent / setPrefs) routes through `surface` so a
 * failed write is never silent (F13) — a key-save or seed failure shows an error toast and keeps
 * the modal open to retry, rather than dropping the user into a half-set-up app. Gateway / advanced
 * credentials are configured later in Settings — onboarding covers the common direct-key path so
 * first launch is one screen, not a setup wizard.
 */
const SAMPLE_SPACE_NAME = 'Welcome to MeetingSpace';
const SAMPLE_NOTE = [
  'Welcome! This is a sample space to show how MeetingSpace works.',
  '',
  'During a meeting, drop in typed notes, paste or upload screenshots, and add transcripts —',
  'everything autosaves and stays searchable. When you are ready, the assistant panel can turn a',
  'space into a white paper, structured minutes, or just keep your raw notes.',
  '',
  'Create a new space from the sidebar to get started, or delete this one anytime.',
].join('\n');

export interface OnboardingProps {
  settingsClient: Pick<SettingsClient, 'setKey' | 'setPrefs'>;
  sessionClient: Pick<SessionClient, 'create'>;
  noteClient: Pick<NoteClient, 'addWithContent'>;
  /** Called once the flow has persisted the seen flag (and seeded the sample space, if applicable). */
  onComplete(): void;
}

export function Onboarding({
  // Destructured to the guard-tracked receiver names (settings / client / notes) so the F13
  // completeness guard sees these mutation call sites rather than missing them on a prop alias.
  settingsClient: settings,
  sessionClient: client,
  noteClient: notes,
  onComplete,
}: OnboardingProps): ReactElement {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const { surface } = useMutationToast();

  // Persist the seen flag, then hand control back to the app. A failed write is surfaced but still
  // completes — the only consequence is onboarding may reappear next launch (never data loss).
  const finish = useCallback(async (): Promise<void> => {
    await surface(() => settings.setPrefs({ onboardingSeen: true }), "Couldn't save your setup.");
    onComplete();
  }, [onComplete, settings, surface]);

  const handleGetStarted = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      const trimmed = key.trim();
      if (trimmed.length > 0) {
        const saved = await surface(
          () => settings.setKey(trimmed, 'anthropic'),
          "Couldn't save your API key. You can add it later in Settings.",
        );
        if (saved === undefined) {
          return; // surfaced; keep the modal open so the user can retry or skip
        }
        setKey(''); // drop the plaintext from renderer state the moment it is handed off
      }
      // Seed one sample space so the app isn't empty on first launch.
      const session = await surface(
        () => client.create(SAMPLE_SPACE_NAME),
        "Couldn't create the sample space.",
      );
      if (!session) {
        return;
      }
      await surface(
        () => notes.addWithContent(session.id, SAMPLE_NOTE),
        "Couldn't add the welcome note.",
      );
      await finish();
    } finally {
      setBusy(false);
    }
  }, [client, finish, key, notes, settings, surface]);

  const handleSkip = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      await finish();
    } finally {
      setBusy(false);
    }
  }, [finish]);

  return (
    <Modal
      label="Welcome to MeetingSpace"
      className="onboarding-modal"
      scrimTestId="onboarding-scrim"
      closeOnScrimClick={false}
      onClose={() => void handleSkip()}
    >
      <h2 className="onboarding-title">Welcome to MeetingSpace</h2>
      <p className="onboarding-lead">
        A local-first place to capture meeting notes, screenshots, and transcripts — with a built-in
        Claude assistant that can turn them into white papers or minutes on demand.
      </p>

      <section className="settings-section">
        <h3 className="settings-subheading">Connect Claude (optional)</h3>
        <p className="settings-help">
          Paste your Anthropic API key to use the assistant. It’s encrypted at rest by your
          operating system and never leaves this device in plain text. You can also add it later in
          Settings.
        </p>
        <label className="settings-field-label" htmlFor="onboarding-api-key">
          Anthropic API key
        </label>
        <input
          id="onboarding-api-key"
          className="settings-key-input"
          type="password"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          placeholder="sk-ant-…"
          autoComplete="off"
          spellCheck={false}
        />
      </section>

      <div className="settings-actions onboarding-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void handleGetStarted()}
          disabled={busy}
        >
          Get started
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => void handleSkip()}
          disabled={busy}
        >
          Skip for now
        </button>
      </div>
    </Modal>
  );
}
