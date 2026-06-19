import type { ReactElement } from 'react';

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
