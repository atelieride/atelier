// The app's own error log (ATELIER_HOME/logs/app.log, next to atelierd.log): renderer errors (uncaught, unhandled
// rejections, error boundaries) and main-process events (renderer gone, unresponsive, preload error). Only messages and
// stacks, with token-like runs redacted and terminal escapes dropped; bounded (one rotated backup) and rate-limited, and
// it never throws: logging must not take the app down.
import { appendFileSync, existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensureDir, renameWithRetry } from '../daemon/fsutil';
import { redactSecrets } from '@shared/session';

export interface AppLogEntry {
  /** Where it comes from: 'renderer:error', 'renderer:rejection', 'renderer:boundary', 'main:render-process-gone'… */
  source: string;
  message: string;
  stack?: string;
  /** The panel whose error boundary caught it. */
  panel?: string;
}

export interface AppLogOptions {
  /** Size past which app.log becomes app.log.1 (the one backup). */
  maxBytes?: number;
  /** Entries per minute; the rest are counted and the count is logged with the next entry. */
  maxPerMinute?: number;
  now?: () => number;
}

export const MAX_MESSAGE = 2000;
export const MAX_STACK = 8000;

// Control characters (ESC included) out; newlines are handled by the caller.
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;
const clean = (s: string, max: number) => redactSecrets(redactCredentials(s.replace(CONTROL, '').slice(0, max)));

// Connector credentials, whatever their shape: redactSecrets only catches long, mixed-case runs, while an
// OAuth code or a verifier can be short and plain. The scheme or key stays, the value becomes "…".
const BEARER = /\b(Bearer)\s+[^\s"',;)]+/gi;
const CREDENTIAL_KEY = /\b(access_token|refresh_token|id_token|token|code_verifier|client_secret)("?\s*[:=]\s*"?)[^\s"'&,;}]+/gi;
const OAUTH_CODE = /(^|[?&\s])(code=)[^&\s"'#]+/g;

/** Replaces the values of Bearer tokens, access/refresh tokens, PKCE verifiers and OAuth `code=` parameters with "…". */
export function redactCredentials(text: string): string {
  return text.replace(BEARER, '$1 …').replace(CREDENTIAL_KEY, '$1$2…').replace(OAUTH_CODE, '$1$2…');
}

export class AppLog {
  private readonly maxBytes: number;
  private readonly maxPerMinute: number;
  private readonly now: () => number;
  private windowStart = -Infinity;
  private inWindow = 0;
  private dropped = 0;

  constructor(private readonly file: string, o: AppLogOptions = {}) {
    this.maxBytes = o.maxBytes ?? 256 * 1024;
    this.maxPerMinute = o.maxPerMinute ?? 30;
    this.now = o.now ?? (() => Date.now());
  }

  /** True if the entry was written. */
  write(e: AppLogEntry): boolean {
    const now = this.now();
    if (now - this.windowStart >= 60_000) { this.windowStart = now; this.inWindow = 0; }
    if (this.inWindow >= this.maxPerMinute) { this.dropped++; return false; }
    this.inWindow++;
    const time = new Date(now).toISOString();
    let text = '';
    if (this.dropped > 0) { text += `${time} [app-log] ${this.dropped} entries dropped (too many in a minute)\n`; }
    const panel = e.panel ? ` (${clean(e.panel.replace(/\s+/g, ' '), 80)})` : '';
    text += `${time} [${clean(e.source.replace(/\s+/g, ' '), 80)}]${panel} ${clean(e.message.replace(/\s+/g, ' '), MAX_MESSAGE)}\n`;
    if (e.stack) {
      for (const line of clean(e.stack.replace(/\r/g, ''), MAX_STACK).split('\n')) if (line.trim()) text += `    ${line}\n`;
    }
    try {
      ensureDir(dirname(this.file), 0o700);
      if (existsSync(this.file) && statSync(this.file).size + Buffer.byteLength(text) > this.maxBytes) renameWithRetry(this.file, `${this.file}.1`);
      appendFileSync(this.file, text.length > this.maxBytes ? text.slice(0, this.maxBytes) : text, { mode: 0o600 });
      this.dropped = 0;
      return true;
    } catch {
      return false;
    }
  }
}
