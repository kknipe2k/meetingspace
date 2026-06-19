import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/*
 * The main-process logger (M06.E). It tees main-process console output to a findable on-disk log
 * (<logs>/main.log, opened from Help ▸ Open Logs Folder) so a packaged user can hand over a log
 * when something breaks. Because that file PERSISTS TO DISK, it is a Hard-Rule §10 surface: a
 * key-shaped token must NEVER be written. `redactSecrets` is the load-bearing guard and runs on
 * every line before it reaches any sink.
 *
 * The pure logic (redact / format / route / file-append / console-tee) lives here and is fully
 * unit-tested; the only excluded bit is the one-line wiring in main.ts that resolves
 * app.getPath('logs') and installs the tee onto the real `console`.
 */
export type LogLevel = 'log' | 'info' | 'warn' | 'error';

export interface LogSink {
  append(line: string): void;
}

export interface Logger {
  log(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface ConsoleLike {
  log(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

const REDACTED = '[REDACTED]';
const LEVELS: readonly LogLevel[] = ['log', 'info', 'warn', 'error'];

/*
 * Strip credential-shaped substrings before anything is written to disk (Hard Rule §10 — the key
 * is never logged). Order matters: the more specific Anthropic key (sk-ant-…) is handled before
 * the generic bearer-style key (sk-…) so the generic pass can't re-mangle the placeholder. The
 * length floors keep ordinary words (e.g. "sk-" with nothing after, "task-…") from matching.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]{6,}/g, `sk-ant-${REDACTED}`)
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, `sk-${REDACTED}`)
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, `Bearer ${REDACTED}`);
}

function stringifyArg(arg: unknown): string {
  if (typeof arg === 'string') {
    return arg;
  }
  if (arg instanceof Error) {
    return arg.stack ?? `${arg.name}: ${arg.message}`;
  }
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}

export function formatLogLine(level: LogLevel, args: unknown[], now: Date): string {
  const body = redactSecrets(args.map(stringifyArg).join(' '));
  return `[${now.toISOString()}] ${level.toUpperCase()} ${body}`;
}

export function createLogger(sink: LogSink, now: () => Date): Logger {
  const emit =
    (level: LogLevel) =>
    (...args: unknown[]): void => {
      try {
        sink.append(formatLogLine(level, args, now()));
      } catch {
        // Logging must never throw into the caller (a full disk can't crash the app).
      }
    };
  return { log: emit('log'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

export function createFileSink(filePath: string): LogSink {
  let dirReady = false;
  return {
    append(line: string): void {
      if (!dirReady) {
        mkdirSync(dirname(filePath), { recursive: true });
        dirReady = true;
      }
      appendFileSync(filePath, `${line}\n`, 'utf8');
    },
  };
}

/*
 * Tee a console object onto the logger: each level still calls the original (so dev stdout is
 * unchanged) AND appends a redacted line to the sink. Idempotent enough for one install at boot.
 */
export function installConsoleTee(logger: Logger, target: ConsoleLike): void {
  for (const level of LEVELS) {
    const original = target[level].bind(target);
    target[level] = (...args: unknown[]): void => {
      original(...args);
      logger[level](...args);
    };
  }
}
