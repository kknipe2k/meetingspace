import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createFileSink,
  createLogger,
  formatLogLine,
  installConsoleTee,
  redactSecrets,
  type LogSink,
} from '../../electron/logger';

/*
 * The main-process logger (M06.E). It tees main-process console output to a findable on-disk
 * log (<logs>/main.log, opened from the Help menu). Because that log PERSISTS TO DISK, it is
 * a Hard-Rule §10 surface: a key-shaped token must NEVER be written. redactSecrets is the
 * load-bearing guard; the file sink + console tee are testable here (added to the coverage
 * allowlist). The only excluded bit is the one-line wiring in main.ts (app.getPath('logs')).
 */
const FIXED = new Date('2026-06-16T12:00:00.000Z');
const now = (): Date => FIXED;

describe('redactSecrets (Hard Rule §10 — no key ever written to disk)', () => {
  it('redacts an Anthropic key (sk-ant-…)', () => {
    const out = redactSecrets('boom with sk-ant-api03-AbCdEf0123456789ZyXw');
    expect(out).not.toContain('AbCdEf0123456789ZyXw');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts a generic bearer-style key (sk-…)', () => {
    const out = redactSecrets('Authorization used sk-9f8e7d6c5b4a3210ffee');
    expect(out).not.toContain('9f8e7d6c5b4a3210ffee');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts a Bearer token regardless of case', () => {
    const out = redactSecrets('header: bearer eyJ0eXAiOiJKV1QzZ290c2VjcmV0');
    expect(out).not.toContain('eyJ0eXAiOiJKV1QzZ290c2VjcmV0');
    expect(out).toMatch(/\[REDACTED\]/);
  });

  it('leaves ordinary text untouched', () => {
    expect(redactSecrets('opened database; 3 sessions loaded')).toBe(
      'opened database; 3 sessions loaded',
    );
  });
});

describe('formatLogLine', () => {
  it('stamps level + ISO time and joins the args, redacted', () => {
    const line = formatLogLine('error', ['failed for', 'sk-ant-api03-SeCrEtToKeN012345'], FIXED);
    expect(line).toContain('2026-06-16T12:00:00.000Z');
    expect(line).toMatch(/ERROR/);
    expect(line).toContain('failed for');
    expect(line).not.toContain('SeCrEtToKeN012345');
  });
});

describe('formatLogLine — non-string args', () => {
  it('renders an Error with its message', () => {
    const line = formatLogLine('error', [new Error('db locked')], FIXED);
    expect(line).toMatch(/db locked/);
  });

  it('JSON-stringifies a plain object arg', () => {
    const line = formatLogLine('info', [{ sessions: 3 }], FIXED);
    expect(line).toContain('"sessions":3');
  });

  it('falls back to String() for a non-serializable (circular) arg without throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => formatLogLine('log', [circular], FIXED)).not.toThrow();
  });
});

describe('createLogger', () => {
  it('never throws into the caller even when the sink fails (a full disk can’t crash the app)', () => {
    const logger = createLogger(
      {
        append: () => {
          throw new Error('ENOSPC');
        },
      },
      now,
    );
    expect(() => logger.error('boom')).not.toThrow();
  });

  it('routes each level to the sink with redaction applied', () => {
    const lines: string[] = [];
    const sink: LogSink = { append: (l) => lines.push(l) };
    const logger = createLogger(sink, now);

    logger.log('plain');
    logger.error('crash with key', 'sk-ant-api03-Zzz9999988887777');

    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).not.toContain('Zzz9999988887777');
    expect(lines.join('\n')).toContain('[REDACTED]');
  });
});

describe('createFileSink → main.log (the §10 disk round-trip)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ms-log-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a key-shaped string passed through the logger NEVER lands in main.log', () => {
    const logFile = join(dir, 'main.log');
    const logger = createLogger(createFileSink(logFile), now);
    const KEY = 'sk-ant-api03-AbCdEf0123456789-the-real-secret';

    logger.error('Anthropic call failed with', KEY);
    logger.log('gateway auth', 'Bearer eyJhbGciOiJIUzI1NiUbErEsErEt');

    const written = readFileSync(logFile, 'utf8');
    expect(written).not.toContain('AbCdEf0123456789-the-real-secret');
    expect(written).not.toContain('eyJhbGciOiJIUzI1NiUbErEsErEt');
    expect(written).toMatch(/\[REDACTED\]/);
  });

  it('appends successive lines (does not truncate prior log)', () => {
    const logFile = join(dir, 'main.log');
    const sink = createFileSink(logFile);
    sink.append('first');
    sink.append('second');
    const written = readFileSync(logFile, 'utf8');
    expect(written).toContain('first');
    expect(written).toContain('second');
  });
});

describe('installConsoleTee', () => {
  it('tees a console call to the logger (redacted) AND still calls the original', () => {
    const lines: string[] = [];
    const logger = createLogger({ append: (l) => lines.push(l) }, now);
    const original = vi.fn();
    const target = { log: original, info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    installConsoleTee(logger, target);
    target.log('startup', 'sk-ant-api03-TeEeEdSecret99887766');

    expect(original).toHaveBeenCalledWith('startup', 'sk-ant-api03-TeEeEdSecret99887766');
    expect(lines.join('\n')).not.toContain('TeEeEdSecret99887766');
    expect(lines.join('\n')).toContain('[REDACTED]');
  });
});
