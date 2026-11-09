import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { posixRel } from '../support/platform';

// Windows: a console program (git, gh, claude, whisper, netstat) started by a GUI app opens a console
// window of its own unless the spawn says `windowsHide` — a flash on every git status. Every execFile/spawn in main
// passes it (directly or through proc-tree's childOptions), except in modules that only run on macOS.
const MAC_ONLY = new Set([
  'src/main/updates-ipc.ts', // the in-app updater: codesign, ditto, the swap script (Windows updates through the Store)
  'src/main/shell-command-exec.ts', // osascript for the `atelier` symlink (hidden on Windows)
  'src/main/tmux/exec.ts', // the Services view (hidden on Windows)
  'src/main/app-icon-exec.ts' // osascript for the installed bundle's icon (eligibleBundle is null on Windows)
]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.ts$/.test(n) && !/\.test\.ts$/.test(n) ? [p] : [];
  });
}

/** The text of each call `name(...)`, parentheses balanced. */
function calls(src: string, name: RegExp): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(name)) {
    let depth = 0;
    let i = m.index! + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')' && --depth === 0) break;
    }
    out.push(src.slice(m.index!, i + 1));
  }
  return out;
}

test('every child main starts hides its console window on Windows', () => {
  const missing = walk('src/main').map((f) => posixRel('.', f)).filter((f) => !MAC_ONLY.has(f)).flatMap((f) =>
    calls(readFileSync(f, 'utf8'), /(?<![\w.]|private )(?:execFile|spawn)\(/g)
      .filter((c) => !/windowsHide|childOptions\(\)/.test(c))
      .map((c) => `${f}: ${c.slice(0, 80)}`));
  expect(missing).toEqual([]);
});
