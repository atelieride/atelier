import { expect, test } from 'vitest';
import { externalLoads } from '../support/external-loads';

const site = 'https://useatelier.dev';

test('every srcset candidate, script, image, iframe and link href counts', () => {
  const html = '<img srcset="/a.webp 1x, https://cdn.example.com/b.webp 2x" src="/a.webp"><script src="https://x.example/s.js"></script><link rel="stylesheet" href="https://fonts.example/c.css"><link rel="canonical" href="https://useatelier.dev/">';
  expect(externalLoads(html, site).sort()).toEqual(['https://cdn.example.com/b.webp', 'https://fonts.example/c.css', 'https://x.example/s.js']);
});

test('CSS url() and @import count, data: and relative URLs do not', () => {
  const css = "@import url('https://fonts.example/a.css');@import \"https://fonts.example/b.css\";.x{background:url(https://img.example/c.png)}.y{background:url(data:image/png;base64,AA==)}.z{src:url(/_astro/f.woff2)}";
  expect(externalLoads(css, site).sort()).toEqual(['https://fonts.example/a.css', 'https://fonts.example/b.css', 'https://img.example/c.png']);
});

test('links the visitor clicks are not loads', () => {
  expect(externalLoads('<a href="https://github.com/atelieride/atelier">x</a>', site)).toEqual([]);
});
