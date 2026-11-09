import { appendFileSync, renameSync, statSync } from 'node:fs';

const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** File log with a single rotation (.1): the service runs for days. */
export function createLogger(file: string | null): (msg: string) => void {
  return (msg) => {
    if (!file) return;
    try {
      try { if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, file + '.1'); } catch { /* file not created yet */ }
      appendFileSync(file, `${new Date().toISOString()} ${msg}\n`, { mode: 0o600 });
    } catch { /* logging must never bring the service down */ }
  };
}
