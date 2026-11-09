import { describe, expect, test } from 'vitest';
// The palette's own source, for the guard below (Vite's raw import).
import source from './Palette.tsx?raw';

// The palette's memos: a list built in one memo from another memo's result must list it in its deps, or it shows
// stale rows while the palette is open (Redis's commands and queues did: the view shown, a queue found, nothing new).

interface Memo { name: string; body: string; deps: string[] }

/** Every `const name = useMemo…(() => …, [deps]);` of a component: its body and its deps (closed at its own indent). */
function memosOf(src: string): Memo[] {
  const out: Memo[] = [];
  const start = /^( *)const (\w+)(?::[^=]+)? = useMemo\b/gm;
  for (let m = start.exec(src); m; m = start.exec(src)) {
    const indent = m[1]!;
    const close = new RegExp(`^${indent}\\}\\)?, \\[([^\\]]*)\\]\\);$`, 'm');
    const one = /, \[([^\]]*)\]\);$/;
    const rest = src.slice(m.index);
    const firstLine = rest.slice(0, rest.indexOf('\n'));
    const single = one.exec(firstLine);
    const end = single ? { index: single.index, deps: single[1]! } : (() => {
      const c = close.exec(rest);
      return c ? { index: c.index, deps: c[1]! } : null;
    })();
    if (!end) continue;
    // Its code only: whole-line comments and JSX comments say names without reading them.
    const body = rest.slice(firstLine.length, single ? firstLine.length : end.index).replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    out.push({ name: m[2]!, body: single ? firstLine.slice(firstLine.indexOf('useMemo')) : body, deps: end.deps.split(',').map((d) => d.trim()).filter(Boolean) });
  }
  return out;
}

describe('the palette\'s memos list the memos they read', () => {
  test('the guard reads memos as written (one-liners and blocks), and catches a missing dep', () => {
    const src = [
      'function P() {',
      '  const a = useMemo(() => [1], [x]);',
      '  const b = useMemo<Item[]>(() => {',
      '    // a is named here only in a comment',
      '    return [...a];',
      '  }, [y]);',
      '  const c = useMemo(() => {',
      '    const a = 2;',
      '    return a + b.length;',
      '  }, [b]);',
      '}'
    ].join('\n');
    const memos = memosOf(src);
    expect(memos.map((x) => [x.name, x.deps])).toEqual([['a', ['x']], ['b', ['y']], ['c', ['b']]]);
    expect(missing(memos)).toEqual(['b reads a']);
    expect(missing(memosOf(src.replace('  }, [y]);', '  }, [y, a]);')))).toEqual([]);
  });

  test('Palette.tsx: every memo that reads another memo lists it (redisCmds in the commands, redisItems in the sections)', () => {
    const memos = memosOf(source);
    // The ones this guard was written for are read as memos at all.
    expect(memos.map((x) => x.name)).toEqual(expect.arrayContaining(['commands', 'sections', 'redisCmds', 'redisItems', 'dockerCmds', 'dockerItems', 'dbCmds']));
    expect(missing(memos)).toEqual([]);
  });
});

function missing(memos: Memo[]): string[] {
  const out: string[] = [];
  for (const m of memos) {
    for (const other of memos) {
      if (other === m || !new RegExp(`\\b${other.name}\\b`).test(m.body)) continue;
      // A local of the same name (taskGroups' own `sections`) isn't the memo.
      if (new RegExp(`\\b(?:const|let|var) ${other.name}\\b`).test(m.body)) continue;
      if (!m.deps.some((d) => d === other.name || d.startsWith(`${other.name}?.`) || d.startsWith(`${other.name}.`))) out.push(`${m.name} reads ${other.name}`);
    }
  }
  return out;
}
