import { describe, expect, test } from 'vitest';
import { findFileLinks, isSafeUrl, linkClickAction } from './links';

const one = (s: string) => findFileLinks(s).map(({ path, line, col }) => ({ path, line, col }));

describe('findFileLinks', () => {
  test.each([
    ['vedi src/components/App.tsx:14 per i dettagli', [{ path: 'src/components/App.tsx', line: 14, col: null }]],
    ['(app-ui/src/a.ts:12:5)', [{ path: 'app-ui/src/a.ts', line: 12, col: 5 }]],
    ['Ho letto SpeakerPanel.tsx:14.', [{ path: 'SpeakerPanel.tsx', line: 14, col: null }]],
    ['/Users/x/repo/serve.json', [{ path: '/Users/x/repo/serve.json', line: null, col: null }]],
    ['./scripts/dev.sh e ../shared/x.ts:3', [{ path: './scripts/dev.sh', line: null, col: null }, { path: '../shared/x.ts', line: 3, col: null }]],
    ['⏺ Update(app-ui/serve.json)', [{ path: 'app-ui/serve.json', line: null, col: null }]],
    ['file `docs/README.md` aggiornato', [{ path: 'docs/README.md', line: null, col: null }]],
    ['.env.local e Dockerfile.dev', [{ path: '.env.local', line: null, col: null }, { path: 'Dockerfile.dev', line: null, col: null }]]
  ])('%s', (input, expected) => expect(one(input)).toEqual(expected));

  test('no URLs, versions, numbers or words with a trailing dot', () => {
    expect(one('https://example.com/a.js e v1.2.3 e 3.14 e fine.')).toEqual([]);
  });
  test('a leading @ (Claude mention) is not part of the path, nor of the link range', () => {
    expect(one('read @src/foo.ts:3 now')).toEqual([{ path: 'src/foo.ts', line: 3, col: null }]);
    expect(findFileLinks('read @src/foo.ts:3 now')[0]).toMatchObject({ start: 6, end: 18 });
    // An @ inside the path stays (scoped packages).
    expect(one('node_modules/@types/node/index.d.ts')).toEqual([{ path: 'node_modules/@types/node/index.d.ts', line: null, col: null }]);
  });
  test('home paths (~/…) are recognized', () => {
    expect(one('wrote ~/x/a.ts:7')).toEqual([{ path: '~/x/a.ts', line: 7, col: null }]);
    expect(findFileLinks('wrote ~/x/a.ts')[0]).toMatchObject({ start: 6, end: 14 });
  });
  test('indici corretti', () => {
    const [l] = findFileLinks('xx src/a.ts:3 yy');
    expect(l).toMatchObject({ start: 3, end: 13 });
  });
});

test('isSafeUrl', () => {
  expect(isSafeUrl('https://claude.ai/x')).toBe(true);
  expect(isSafeUrl('http://localhost:3000/')).toBe(true);
  for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'vscode://x', 'data:text/html,x', 'notaurl', '']) expect(isSafeUrl(u)).toBe(false);
});

describe('linkClickAction: ⌘-click always opens (and is not forwarded), a plain click only when the mouse is free', () => {
  test.each([
    [{ metaKey: true, mouseTracking: true }, 'intercept'],
    [{ metaKey: true, mouseTracking: false }, 'intercept'],
    [{ metaKey: false, mouseTracking: false }, 'default'],
    [{ metaKey: false, mouseTracking: true }, 'ignore']
  ] as const)('%j → %s', (input, expected) => expect(linkClickAction(input)).toBe(expected));
});
