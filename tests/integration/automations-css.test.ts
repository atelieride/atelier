// automations.css styles the Automations feature only: it never redefines a selector another stylesheet owns (its
// `.icon-btn.is-on`, meant for Pause All, once turned every pressed icon button amber, the sessions' group toggle too).
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, test } from 'vitest';

const RENDERER = join(__dirname, '..', '..', 'src', 'renderer');
const OWN = join(RENDERER, 'automations', 'automations.css');

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? cssFiles(join(dir, e.name)) : e.name.endsWith('.css') ? [join(dir, e.name)] : []));
}

/** Every selector of a stylesheet's rules (comments and at-rule preludes dropped), whitespace normalized. */
function selectors(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...text.matchAll(/([^{}]+)\{/g)].map((m) => m[1]!.trim()).filter((s) => s && !s.startsWith('@'))
    .flatMap((s) => s.split(',')).map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
}

test('automations.css redefines no selector of another stylesheet', () => {
  const others = new Map<string, string>();
  for (const f of cssFiles(RENDERER)) if (f !== OWN) for (const s of selectors(readFileSync(f, 'utf8'))) others.set(s, relative(RENDERER, f));
  const clashes = selectors(readFileSync(OWN, 'utf8')).filter((s) => others.has(s)).map((s) => `${s} (${others.get(s)})`);
  expect(clashes).toEqual([]);
});
