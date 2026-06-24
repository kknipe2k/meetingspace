import type { GatewayModelDiagnosis } from '@shared/types';

export const GATEWAY_MODEL_TEST_TIMEOUT_MS = 15_000;
export const GATEWAY_MODEL_TEST_CONCURRENCY = 3;
export const GATEWAY_MODEL_TEST_LIMIT = 25;

export type GatewayModelProbe = (id: string, signal: AbortSignal) => Promise<string>;

export interface GatewayDiagnosticsOptions {
  readonly timeoutMs?: number;
  readonly concurrency?: number;
  readonly limit?: number;
  readonly now?: () => number;
}

function isTimeoutError(error: unknown): boolean {
  const candidate = error as { name?: string; message?: string } | null;
  const text = `${candidate?.name ?? ''} ${candidate?.message ?? ''}`.toLowerCase();
  return text.includes('abort') || text.includes('timeout') || text.includes('timed out');
}

function errorMessage(error: unknown): string {
  const candidate = error as { status?: number; message?: string } | null;
  const message = candidate?.message ?? String(error);
  return candidate?.status ? `HTTP ${candidate.status}: ${message}` : message;
}

function isSameModel(requested: string, served: string): boolean {
  return served === requested || served.startsWith(`${requested}-`);
}

export async function diagnoseGatewayModels(
  rawIds: readonly string[],
  probe: GatewayModelProbe,
  options: GatewayDiagnosticsOptions = {},
): Promise<GatewayModelDiagnosis[]> {
  const timeoutMs = options.timeoutMs ?? GATEWAY_MODEL_TEST_TIMEOUT_MS;
  const concurrency = Math.max(1, options.concurrency ?? GATEWAY_MODEL_TEST_CONCURRENCY);
  const limit = Math.max(1, options.limit ?? GATEWAY_MODEL_TEST_LIMIT);
  const now = options.now ?? Date.now;
  const ids = [...new Set(rawIds)].slice(0, limit);
  const results = new Array<GatewayModelDiagnosis>(ids.length);
  let cursor = 0;

  const runOne = async (id: string): Promise<GatewayModelDiagnosis> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const served = await probe(id, controller.signal);
      const status = isSameModel(id, served) ? 'available' : 'substituted';
      return { id, served, ok: true, status, testedAt: now() };
    } catch (error) {
      const timedOut = controller.signal.aborted || isTimeoutError(error);
      return {
        id,
        served: null,
        ok: false,
        status: timedOut ? 'timeout' : 'unavailable',
        testedAt: now(),
        error: timedOut
          ? `Timed out after ${Math.max(1, Math.ceil(timeoutMs / 1000))} seconds.`
          : errorMessage(error),
      };
    } finally {
      clearTimeout(timer);
    }
  };

  const worker = async (): Promise<void> => {
    while (cursor < ids.length) {
      const index = cursor;
      cursor += 1;
      const id = ids[index];
      if (id !== undefined) {
        results[index] = await runOne(id);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, ids.length) }, async () => worker()),
  );
  return results;
}
