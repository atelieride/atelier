import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// The Seti file icons are two JSON files kept in the repo: the seti-icons package (unmaintained since 0.0.4) brought
// svgo 1.x and its vulnerable dependencies along for data Atelier never processes.
const root = join(__dirname, '../..');

test('the Seti icon data is vendored, not a dependency', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
  expect(pkg.dependencies?.['seti-icons']).toBeUndefined();
  expect(pkg.devDependencies?.['seti-icons']).toBeUndefined();
  expect(readFileSync(join(root, 'src/renderer/icons/seti.ts'), 'utf8')).not.toMatch(/from 'seti-icons/);
  for (const f of ['definitions.json', 'icons.json']) expect(existsSync(join(root, 'src/renderer/icons/seti', f))).toBe(true);
  // MIT: the notice still ships with the app.
  expect(readFileSync(join(root, 'assets/licenses/MIT-seti-icons.txt'), 'utf8')).toMatch(/MIT|Permission is hereby granted/);
});
