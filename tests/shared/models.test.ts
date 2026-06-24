import { describe, expect, it } from 'vitest';

import {
  accessibleGatewayModels,
  CHAT_MODELS,
  curateGatewayModels,
  DEFAULT_CHAT_MODEL,
  DEFAULT_GENERATION_MODEL,
  gatewayModelProfile,
  modelLabel,
  normalizeGatewayProfileKey,
  prefsWithGatewayModelProfile,
} from '@shared/models';
import type { CatalogModel, GatewayModelProfile, GatewayModelVerification } from '@shared/types';

/*
 * The model catalog (M03.D; M04.C flips the generation default Opus -> Sonnet 4.6
 * per ADR-0012, which supersedes the generation half of ADR-0008; the chat default
 * Haiku is unchanged). `modelLabel` is the single id->label helper shared by the
 * chat badge and the generation badge (lifted out of ChatPanel so both render the
 * same friendly name).
 */
describe('shared/models', () => {
  it('defaults generation to Sonnet 4.6 (ADR-0012 supersedes ADR-0008)', () => {
    expect(DEFAULT_GENERATION_MODEL).toBe('claude-sonnet-4-6');
  });

  it('leaves the chat default at Haiku 4.5 (unchanged by ADR-0012)', () => {
    expect(DEFAULT_CHAT_MODEL).toBe('claude-haiku-4-5');
  });

  it('the generation default is a real catalog entry', () => {
    expect(CHAT_MODELS.some((option) => option.id === DEFAULT_GENERATION_MODEL)).toBe(true);
  });

  it('modelLabel maps a catalog id to its friendly label', () => {
    expect(modelLabel('claude-sonnet-4-6')).toBe('Claude Sonnet 4.6');
    expect(modelLabel('claude-opus-4-8')).toBe('Claude Opus 4.8');
  });

  it('modelLabel matches a dated snapshot by prefix and falls back to the raw id', () => {
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Claude Haiku 4.5');
    expect(modelLabel('claude-future-9-9')).toBe('claude-future-9-9');
  });
});

/*
 * The gateway picker curation (Gateway diagnostics). A corporate gateway can advertise the whole
 * Bedrock catalog; the user curates which ids the dropdowns show. Empty selection ⇒ the app's known
 * tiers (de-flood); a selection ⇒ exactly those ids, resolved from the served metadata (or a
 * best-effort synthesized entry if the gateway stopped advertising a still-selected id).
 */
describe('curateGatewayModels', () => {
  const served: CatalogModel[] = [
    {
      id: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      label: 'Claude 3.5 Sonnet',
      maxOutputTokens: 8192,
    },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', maxOutputTokens: 64000 },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', maxOutputTokens: 64000 },
  ];

  it('falls back to the conservative non-Opus tiers when nothing is curated', () => {
    expect(curateGatewayModels(served, []).map((model) => model.id)).toEqual([
      'claude-haiku-4-5',
      'claude-sonnet-4-6',
    ]);
  });

  it('returns exactly the curated ids, in order, resolved from the served metadata', () => {
    const result = curateGatewayModels(served, ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001']);
    expect(result.map((model) => model.id)).toEqual([
      'claude-sonnet-4-6',
      'claude-haiku-4-5-20251001',
    ]);
    expect(result[0]).toEqual({
      id: 'claude-sonnet-4-6',
      label: 'Claude Sonnet 4.6',
      maxOutputTokens: 64000,
    });
  });

  it('synthesizes a best-effort entry for a curated id the gateway no longer serves', () => {
    expect(curateGatewayModels(served, ['ghost-model-x'])).toEqual([
      { id: 'ghost-model-x', label: modelLabel('ghost-model-x'), maxOutputTokens: 64000 },
    ]);
  });
});

/*
 * The picker accessibility filter (gateway streaming-probe diagnostics). A model the gateway proved
 * it SUBSTITUTES (you ask for it, governance silently serves a different model) must never reach the
 * chat / white-paper dropdowns — selecting it would be a lie. Only 'substituted' is hidden: a probe
 * failure ('unavailable'/'timeout') is not proof the model is wrong, and an untested id stays visible.
 */
describe('accessibleGatewayModels', () => {
  const models: CatalogModel[] = [
    { id: 'available-model', label: 'Available', maxOutputTokens: 64000 },
    { id: 'substituted-model', label: 'Substituted', maxOutputTokens: 64000 },
    { id: 'unavailable-model', label: 'Unavailable', maxOutputTokens: 64000 },
    { id: 'timeout-model', label: 'Timeout', maxOutputTokens: 64000 },
    { id: 'untested-model', label: 'Untested', maxOutputTokens: 64000 },
  ];
  const verify = (
    id: string,
    status: GatewayModelVerification['status'],
  ): GatewayModelVerification => ({
    id,
    served: status === 'substituted' ? 'other-model' : id,
    ok: status === 'available' || status === 'substituted',
    status,
    testedAt: 1,
  });
  const verifications: Record<string, GatewayModelVerification> = {
    'available-model': verify('available-model', 'available'),
    'substituted-model': verify('substituted-model', 'substituted'),
    'unavailable-model': verify('unavailable-model', 'unavailable'),
    'timeout-model': verify('timeout-model', 'timeout'),
    // 'untested-model' deliberately has no verification entry.
  };

  it('hides ONLY substituted models; keeps available, unavailable, timeout, and untested', () => {
    expect(accessibleGatewayModels(models, verifications).map((model) => model.id)).toEqual([
      'available-model',
      'unavailable-model',
      'timeout-model',
      'untested-model',
    ]);
  });

  it('keeps every model when nothing has been verified', () => {
    expect(accessibleGatewayModels(models, {})).toEqual(models);
  });
});

describe('gateway model profiles', () => {
  it('normalizes equivalent gateway URLs to the same persistence key', () => {
    expect(normalizeGatewayProfileKey('HTTPS://Corp.Example:443/v1/')).toBe(
      'https://corp.example/v1',
    );
  });

  it('stores and reads a profile by normalized gateway URL', () => {
    const profile: GatewayModelProfile = {
      models: [{ id: 'corp-model', label: 'Corp Model', maxOutputTokens: 32000 }],
      curatedModelIds: ['corp-model'],
      verifications: {},
    };
    const patch = prefsWithGatewayModelProfile({}, 'https://corp.example/v1/', profile);

    expect(gatewayModelProfile(patch, 'https://CORP.example:443/v1')).toEqual(profile);
  });

  it('migrates the legacy global gatewayModels allowlist when no scoped profile exists', () => {
    expect(
      gatewayModelProfile({ gatewayModels: ['legacy-model'] }, 'https://corp.example')
        .curatedModelIds,
    ).toEqual(['legacy-model']);
  });
});
