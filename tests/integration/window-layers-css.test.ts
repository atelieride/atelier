import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// A layer that covers the whole window (a modal's dim, a menu's catcher) lies over the header, which is the window's
// drag region: without its own -webkit-app-region a click on the strip under it drags the window instead of reaching
// the layer (the Redis modal, 2026-10-22). The palette's and the menu's layers set no-drag; every such layer must say.
const dir = join(__dirname, '../../src/renderer');
const rules = readdirSync(dir).filter((f) => f.endsWith('.css')).flatMap((f) =>
  [...readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ file: f, sel: m[1]!.trim(), body: m[2]! })));

test('every full-window layer sets its own -webkit-app-region', () => {
  const layers = rules.filter((r) => /position:\s*fixed/.test(r.body) && /inset:\s*0\s*[;}]?/.test(r.body) && !/pointer-events:\s*none/.test(r.body));
  expect(layers.map((r) => r.sel)).toContain('.rd-modal-layer');
  const missing = layers.filter((l) => !rules.some((r) => r.sel.split(',').map((s) => s.trim()).includes(l.sel) && /-webkit-app-region:/.test(r.body)));
  expect(missing.map((l) => `${l.file}: ${l.sel}`)).toEqual([]);
});
