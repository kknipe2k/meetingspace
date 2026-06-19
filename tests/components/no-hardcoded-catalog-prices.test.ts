import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/*
 * M06.D guard (ADR-0021; gates "Dynamic catalog + no hardcoded models" and "Config-driven
 * pricing"). The model list and pricing must flow from the dynamic catalog + the pricing config,
 * NOT from the hardcoded shared/models.ts tables. Mechanical guard: no renderer component or hook
 * may reference `CHAT_MODELS` (the hardcoded model list) or `PRICING_AS_OF` (the hardcoded
 * price-snapshot date) — the hardcoded sources. Reading a config-driven `PricingEntry.inputPerMTok`
 * field is fine (it came over the usage IPC), so the field names themselves are NOT banned.
 *
 * `modelLabel` / `DEFAULT_CHAT_MODEL` / `STATIC_CATALOG` remain allowed — id helpers / the offline
 * catalog shape, not the hardcoded price table.
 */
const COMPONENTS_ROOT = resolve(__dirname, '../../src/components');
const HOOKS_ROOT = resolve(__dirname, '../../src/hooks');
const BANNED = ['CHAT_MODELS', 'PRICING_AS_OF'];

function walk(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (/\.(t|j)sx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('no hardcoded model catalog or prices in renderer components/hooks', () => {
  it('no component or hook references CHAT_MODELS or hardcoded per-token prices', () => {
    const offenders: string[] = [];
    for (const file of [...walk(COMPONENTS_ROOT), ...walk(HOOKS_ROOT)]) {
      const text = readFileSync(file, 'utf8');
      for (const token of BANNED) {
        if (text.includes(token)) {
          offenders.push(`${relative(resolve(__dirname, '../..'), file)} → ${token}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
