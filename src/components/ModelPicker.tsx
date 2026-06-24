import { useEffect, type ReactElement } from 'react';

import { DEFAULT_GENERATION_MODEL } from '@shared/models';

import { useModelCatalog } from '../hooks/useModelCatalog';

export interface ModelPickerProps {
  /** The selected generation model id (owned by LLMPanel via prefs). */
  model: string;
  onChange(model: string): void;
  /** Disabled while a generation is in flight (mode-switch safety, M04.C fix batch). */
  disabled?: boolean;
}

/*
 * The generation model picker (M04.C). Offers all three tiers from the shared
 * catalog (Haiku / Sonnet / Opus); the owner (LLMPanel) persists the choice as a
 * non-secret pref and passes it into each generation request. Controlled select —
 * the catalog is the single source of options (same one the chat picker uses), so
 * the picker can't drift from the priced/labelled models.
 */
export function ModelPicker({ model, onChange, disabled = false }: ModelPickerProps): ReactElement {
  const { models } = useModelCatalog();
  // Stale / out-of-catalog selection guard (same as chat): if the persisted generation model isn't in
  // the active catalog (a raw gateway id from an older build, or after the gateway curation changed),
  // snap to a valid option and persist it — so the dropdown never shows one model while generation
  // sends another, and main never silently defaults the pick.
  useEffect(() => {
    if (model && models.length > 0 && !models.some((option) => option.id === model)) {
      const preferred =
        models.find((option) => option.id === DEFAULT_GENERATION_MODEL) ?? models[0];
      if (preferred) {
        onChange(preferred.id);
      }
    }
  }, [model, models, onChange]);
  return (
    <div className="model-picker">
      <label className="model-picker-label" htmlFor="generation-model">
        Model
      </label>
      <select
        id="generation-model"
        className="model-picker-select"
        aria-label="Generation model"
        value={model}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {models.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
