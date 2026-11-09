// What in CHANGELOG.md the website's live demo bundle refuses: What's New imports the changelog, and
// tests/integration/demo-build.test.ts fails the release build on any of the site's banned strings. Found only after the
// tag, it spends the version (v0.2.0-beta.20 stopped on a "/c/Users/…" in its notes), so the release checks it first.
// Run on its own by scripts/release.mjs: the release scripts the CI's publish job loads import Node built-ins only.
// Exit 0: clean; 10: leaks, one per line on stdout.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SENSITIVE, SHOTS_ONLY, findBanned } from '../tests/support/banned-strings.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The banned strings found in `text`, as the demo build checks its bundle (empty: clean). */
export function changelogLeaks(text) {
  return findBanned(text, [...SENSITIVE, ...SHOTS_ONLY]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const leaks = changelogLeaks(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'));
  if (leaks.length) console.log(leaks.join('\n'));
  process.exit(leaks.length ? 10 : 0);
}
