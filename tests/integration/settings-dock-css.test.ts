import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// Settings › Terminal and Editor: the docked preview's band frosts over the first pixels of scroll with a scroll-driven
// animation. Where `animation-timeline` is unknown (Firefox, in the
// live demo) the fallback is a choice, not the side effect of a 0 s animation holding its end state.
const css = readFileSync(join(__dirname, '../../src/renderer/layout.css'), 'utf8');

/** The body of the first `@supports <condition> { … }` block, nested braces included. */
function supportsBlock(condition: string): string {
  const start = css.indexOf(`@supports ${condition} {`);
  if (start < 0) return '';
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1);
  }
  return '';
}

test('the band frosts with the scroll only where scroll-driven animations exist', () => {
  const on = supportsBlock('(animation-timeline: scroll())');
  expect(on).toMatch(/\.set-preview-dock\.is-docked::before \{[^}]*animation-timeline: scroll\(nearest block\)/);
  const outside = css.replace(on, '');
  expect(outside).not.toMatch(/animation-timeline: scroll\(nearest block\)/);
  expect(outside).not.toMatch(/animation: set-dock-frost/);
});

test('elsewhere a docked band is frosted all the time, so rows never show through it', () => {
  expect(supportsBlock('not (animation-timeline: scroll())')).toMatch(/\.set-preview-dock\.is-docked::before \{[^}]*opacity: 1/);
});
