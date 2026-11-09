// Words only a developer's own copy knows: their names, user names, home paths, accounts, the people and places of
// their work. They live in the git common dir, at info/public-tree-words (one regular expression per line, `#` for
// comments), never in the repository; the public-tree guard (scripts/public-tree.mjs) and the website's and
// screenshots' banned strings (tests/support/banned-strings.ts) look for them too. No file: only the generic checks.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The file's patterns, in order; [] when there is no file (a fresh clone, CI). */
export function localWords(root) {
  let common;
  try {
    common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return [];
  }
  let text;
  try { text = readFileSync(join(common, 'info', 'public-tree-words'), 'utf8'); } catch { return []; }
  return parseWords(text);
}

/** One pattern per line; blank lines and `#` comments skipped; a line that isn't a valid expression is an error. */
export function parseWords(text) {
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => {
    new RegExp(l); // throws on a typo, so a broken word never silently checks nothing
    return l;
  });
}
