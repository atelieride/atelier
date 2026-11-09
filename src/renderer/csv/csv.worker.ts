/// <reference lib="webworker" />
// CSV viewer: detects the options, parses and profiles the columns for the table, off the main
// thread.
import { detect, resolve } from './detect';
import { parseCsv } from './parse';
import { profile } from './profile';
import type { CsvRequest } from './csv-client';

self.onmessage = (e: MessageEvent<CsvRequest & { id: number }>) => {
  const { id, text, options, hint, rows } = e.data;
  const t0 = performance.now();
  const detected = detect(text, hint);
  const resolved = resolve(options, detected);
  const data = parseCsv(text, resolved);
  const profiles = profile(data, resolved.decimal, resolved.delimiter);
  // The rows are most of what is cloned back to the page: only when the table shows.
  const sent = rows ? data : { ...data, rows: [], lines: [], endLines: [] };
  self.postMessage({ id, result: { data: sent, profiles, resolved, detected, partial: !rows }, ms: Math.round(performance.now() - t0) });
};
