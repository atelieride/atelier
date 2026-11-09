/// <reference lib="webworker" />
// JSON navigation: parses JSON for the tree and the error marks, off the main thread.
import { parseJson, slimTree } from './parse';

self.onmessage = (e: MessageEvent<{ id: number; text: string; jsonc: boolean }>) => {
  const { id, text, jsonc } = e.data;
  const t0 = performance.now();
  const result = parseJson(text, { jsonc });
  // Strings' decoded values are derivable from raw: a smaller tree to clone to the page.
  if (result.ok) slimTree(result.root);
  self.postMessage({ id, result, ms: Math.round(performance.now() - t0) });
};
