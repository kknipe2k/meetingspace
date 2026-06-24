import { useEffect, type ReactElement } from 'react';

import { DEFAULT_GENERATION_MODEL } from '@shared/models';

import { useModelCatalog } from '../hooks/useModelCatalog';
import type { CatalogClient } from '../ipc/client';

export interface ModelPickerProps {
  /** The selected generation model id (owned by LLMPanel via prefs). */
  model: string;
  onChange(model: string): void;
  /** Disabled while a generation is in flight (mode-switch safety, M04.C fix batch). */
  disabled?: boolean;
  /** Injectable for tests; defaults to the real provider-scoped model catalog. */
  catalogClient?: CatalogClient;
}

/*
 * The generation model picker. It consumes the same provider-scoped catalog and the same persisted
 * selectedModel value as chat, so the two surfaces cannot drift.
 */
export function ModelPicker({
  model,
  onChange,
  disabled = false,
  catalogClient,
}: ModelPickerProps): ReactElement {
  const { models, status: catalogStatus } = useModelCatalog(catalogClient);
  // Stale / out-of-catalog selection guard (same as chat): if the persisted generation model isn't in
  // the active catalog (a raw gateway id from an older build, or after the gateway curation changed),
  // snap to a valid option and persist it — so the dropdown never shows one model while generation
  // sends another, and main never silently defaults the pick.
  useEffect(() => {
    if (
      catalogStatus === 'ready' &&
      model &&
      models.length > 0 &&
      !models.some((option) => option.id === model)
    ) {
      const preferred =
        models.find((option) => option.id === DEFAULT_GENERATION_MODEL) ?? models[0];
      if (preferred) {
        onChange(preferred.id);
      }
    }
  }, [catalogStatus, model, models, onChange]);
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
