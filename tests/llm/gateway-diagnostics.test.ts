import { describe, expect, it } from 'vitest';

import {
  diagnoseGatewayModels,
  GATEWAY_MODEL_TEST_LIMIT,
} from '../../electron/llm/gateway-diagnostics';

describe('gateway model diagnostics', () => {
  it('records available, substituted, and unavailable models independently', async () => {
    const results = await diagnoseGatewayModels(
      ['exact', 'alias', 'dead'],
      async (id) => {
        if (id === 'dead') {
          throw Object.assign(new Error('not allowed'), { status: 403 });
        }
        return id === 'alias' ? 'actual-model' : id;
      },
      { now: () => 1234 },
    );

    expect(results).toEqual([
      {
        id: 'exact',
        served: 'exact',
        ok: true,
        status: 'available',
        testedAt: 1234,
      },
      {
        id: 'alias',
        served: 'actual-model',
        ok: true,
        status: 'substituted',
        testedAt: 1234,
      },
      {
        id: 'dead',
        served: null,
        ok: false,
        status: 'unavailable',
        testedAt: 1234,
        error: 'HTTP 403: not allowed',
      },
    ]);
  });

  it('settles a hung probe as a timeout', async () => {
    const [result] = await diagnoseGatewayModels(
      ['hung'],
      (_id, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      { timeoutMs: 5, now: () => 5678 },
    );

    expect(result).toEqual({
      id: 'hung',
      served: null,
      ok: false,
      status: 'timeout',
      testedAt: 5678,
      error: 'Timed out after 1 seconds.',
    });
  });

  it('caps the number of probed ids at GATEWAY_MODEL_TEST_LIMIT (raised to 200 for full Bedrock lists)', async () => {
    expect(GATEWAY_MODEL_TEST_LIMIT).toBe(200);
    const ids = Array.from({ length: GATEWAY_MODEL_TEST_LIMIT + 25 }, (_, i) => `model-${i}`);
    let probed = 0;
    const results = await diagnoseGatewayModels(
      ids,
      async (id) => {
        probed += 1;
        return id;
      },
      { now: () => 1 },
    );

    expect(results).toHaveLength(GATEWAY_MODEL_TEST_LIMIT);
    expect(probed).toBe(GATEWAY_MODEL_TEST_LIMIT);
  });

  it('bounds concurrent probes and preserves input order', async () => {
    let active = 0;
    let maxActive = 0;
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const results = await diagnoseGatewayModels(
      ids,
      async (id) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return id;
      },
      { concurrency: 2 },
    );

    expect(maxActive).toBe(2);
    expect(results.map((result) => result.id)).toEqual(ids);
  });
});
