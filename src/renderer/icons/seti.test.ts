import { expect, test } from 'vitest';
import { iconFor, spriteMarkup } from './seti';

test.each([
  ['App.tsx', 'react', 'var(--seti-blue)'],
  ['x.test.ts', 'typescript', 'var(--seti-yellow)'],
  ['README.md', 'info', 'var(--seti-blue)'],
  ['package.json', 'json', 'var(--seti-yellow)'],
  ['.env', 'config', 'var(--seti-grey-light)'],
  ['.env.local', 'config', 'var(--seti-grey-light)'],
  ['.gitignore', 'git', 'var(--seti-ignore)'],
  ['Dockerfile', 'docker', 'var(--seti-blue)'],
  ['LICENSE', 'license', 'var(--seti-yellow)'],
  ['eslint.config.js', 'eslint', 'var(--seti-purple)'],
  ['yarn.lock', 'yarn', 'var(--seti-blue)'],
  ['Cargo.lock', 'lock', 'var(--seti-green)'],
  ['FOTO.PNG', 'image', 'var(--seti-purple)'],
  ['noextension', 'default', 'var(--seti-white)'],
  ['', 'default', 'var(--seti-white)']
])('%s → %s', (name, id, color) => {
  expect(iconFor(name)).toEqual({ id, color });
});

test('every icon has a symbol in the sprite, with no script', () => {
  const s = spriteMarkup();
  expect(s).toContain('<symbol id="seti-react" viewBox=');
  expect(s).not.toMatch(/<script|on[a-z]+=/i);
  for (const n of ['App.tsx', 'x.test.ts', '.gitignore', 'Cargo.lock', 'yarn.lock', 'noext']) expect(s).toContain(`id="seti-${iconFor(n).id}"`);
});

test.each(['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty', 'x.constructor'])('name like an Object key (%s) → default icon, never an error', (n) => {
  expect(iconFor(n)).toEqual({ id: 'default', color: 'var(--seti-white)' });
});

test.each([['CMakeLists.txt', 'makefile'], ['README', 'info'], ['readme', 'info'], ['go.mod', 'go2'], ['go.sum', 'go2']])('%s → %s', (n, id) => {
  expect(iconFor(n).id).toBe(id);
});
