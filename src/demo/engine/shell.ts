// The demo's shell: a new terminal runs it in place of zsh. A handful of commands
// over the in-memory project — ls, cd, pwd, cat, clear, git status/log/diff from the world's HEAD and the working tree,
// a scripted `npm test` whose results follow the files (the sessions' fixes turn it green), `claude` for a new session
// — with zsh's line editing: cursor keys, history, Ctrl+C/L/U/W, Tab completion. Anything else says it is the demo's.
import { structuredPatch } from 'diff';
import type { DemoContext } from '../bridge/context';
import type { Cancel } from './clock';
import type { Program, TermHost } from './claude';
import { createKeyReader, type Key } from './keys';

const ESC = '\u001b';
const RST = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const RED = `${ESC}[31m`;
const GREEN = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;
const BLUE = `${ESC}[1;34m`;
const MAGENTA = `${ESC}[35m`;
const CYAN = `${ESC}[36m`;
const PASTE_MODE = `${ESC}[?2004h`;
/** What a snapshot replays at most: the screen since the last clear, bounded. */
const BUFFER_MAX = 200_000;

export interface ShellOptions {
  /** `claude`: a new Claude session tab, as ⌘N opens one. */
  claude(): void;
  /** `exit`: the terminal closes. */
  exit(): void;
}

/** The hint every unknown command gets. */
export const HINT = `${DIM}demo shell: try \`help\` — in Atelier this is your own zsh${RST}`;

const HELP = [
  `${BOLD}The demo's shell${RST}: a few commands over the acme-store project.`,
  '',
  `  ${CYAN}ls${RST} [-la] [dir]    ${CYAN}cd${RST} <dir>    ${CYAN}pwd${RST}    ${CYAN}cat${RST} <file>    ${CYAN}clear${RST}`,
  `  ${CYAN}git status${RST}    ${CYAN}git log${RST} [--oneline]    ${CYAN}git diff${RST} [file]`,
  `  ${CYAN}npm test${RST}      ${CYAN}claude${RST} (a new Claude session)`,
  `  ${CYAN}echo${RST}  ${CYAN}whoami${RST}  ${CYAN}date${RST}  ${CYAN}exit${RST}`,
  '',
  `${DIM}In Atelier this terminal is your own zsh, with your own config.${RST}`
];

/** Splits a command line into words ('…' and "…" keep spaces). */
export function words(line: string): string[] {
  const out: string[] = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  for (const m of line.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

/** git's short path from `cwd` to `rel` (both relative to the root). */
function fromCwd(cwd: string, rel: string): string {
  if (!cwd) return rel;
  const a = cwd.split('/');
  const b = rel.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...Array(a.length - i).fill('..'), ...b.slice(i)].join('/');
}

/** A short stable hash (git's index line wants one; the demo has no object store). */
const shortHash = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 7);
};

const bytes = (s: string) => new TextEncoder().encode(s).length;

export function createShell(ctx: DemoContext, host: TermHost, o: ShellOptions): Program {
  const root = ctx.world.project.root;
  const home = root.replace(/^\/home\/[^/]+/, '~');
  const read = createKeyReader();
  let cwd = '';
  let prev = '';
  let line = '';
  let cursor = 0;
  const history: string[] = [];
  let hIndex = 0;
  let draft = '';
  let running: Cancel | null = null;
  let buffer = '';

  const out = (s: string) => {
    buffer += s;
    if (buffer.length > BUFFER_MAX) buffer = buffer.slice(-BUFFER_MAX);
    host.write(s);
  };
  const println = (s = '') => out(`${s.replace(/\r?\n/g, '\r\n')}\r\n`);
  const prompt = () => `${BOLD}${CYAN}${home}${cwd ? `/${cwd}` : ''}${RST} ${MAGENTA}main${RST} ${DIM}›${RST} `;
  const renderLine = () => {
    const back = [...line].length - cursor;
    out(`\r${ESC}[K${prompt()}${line}${back > 0 ? `${ESC}[${back}D` : ''}`);
  };

  // The project as a tree: files and the folders they imply.
  const files = () => ctx.state.files;
  const dirs = () => {
    const set = new Set<string>(['']);
    for (const f of Object.keys(files())) {
      const parts = f.split('/');
      for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join('/'));
    }
    return set;
  };
  /** A path the visitor typed, relative to the root: null outside the project. */
  const resolve = (arg: string): string | null => {
    let p = arg;
    if (p === '~' || p.startsWith('~/')) p = `${home}${p.slice(1)}`;
    if (p.startsWith(home)) p = root + p.slice(home.length);
    const parts = p.startsWith('/') ? (p === root || p.startsWith(`${root}/`) ? p.slice(root.length).split('/') : null) : [...cwd.split('/'), ...p.split('/')];
    if (!parts) return null;
    const stack: string[] = [];
    for (const x of parts) {
      if (!x || x === '.') continue;
      if (x === '..') { if (!stack.length) return null; stack.pop(); } else stack.push(x);
    }
    return stack.join('/');
  };
  const entries = (dir: string) => {
    const prefix = dir ? `${dir}/` : '';
    const names = new Map<string, boolean>();
    for (const f of Object.keys(files())) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      const slash = rest.indexOf('/');
      names.set(slash < 0 ? rest : rest.slice(0, slash), slash >= 0);
    }
    return [...names].sort(([a], [b]) => a.localeCompare(b)).map(([name, isDir]) => ({ name, isDir }));
  };

  const ls = (args: string[]) => {
    const flags = args.filter((a) => a.startsWith('-')).join('');
    const long = flags.includes('l');
    const all = flags.includes('a');
    const targets = args.filter((a) => !a.startsWith('-'));
    for (const [n, t] of (targets.length ? targets : ['.']).entries()) {
      const rel = resolve(t);
      if (rel === null || (!dirs().has(rel) && files()[rel] === undefined)) { println(`ls: ${t}: No such file or directory`); continue; }
      if (files()[rel] !== undefined) { println(long ? `-rw-r--r--  1 ada  staff  ${String(bytes(files()[rel]!)).padStart(5)} Oct 15 09:41 ${t}` : t); continue; }
      if (targets.length > 1) println(`${n ? '\n' : ''}${t}:`);
      const list = [...(all ? [{ name: '.', isDir: true }, { name: '..', isDir: true }, ...(rel ? [] : [{ name: '.git', isDir: true }])] : []), ...entries(rel)];
      const colored = (e: { name: string; isDir: boolean }) => (e.isDir ? `${BLUE}${e.name}${RST}` : e.name);
      if (long) {
        println(`total ${list.length * 8}`);
        for (const e of list) {
          const size = e.isDir ? 128 : bytes(files()[rel ? `${rel}/${e.name}` : e.name] ?? '');
          println(`${e.isDir ? 'drwxr-xr-x' : '-rw-r--r--'}  ${e.isDir ? 4 : 1} ada  staff  ${String(size).padStart(5)} Oct 15 09:41 ${colored(e)}`);
        }
      } else if (list.length) println(list.map(colored).join('  '));
    }
  };

  const cd = (arg = '~') => {
    const target = arg === '-' ? prev : arg;
    const rel = arg === '-' ? prev : resolve(target);
    if (rel === null) { println(`cd: outside the demo's project: ${arg}`); return; }
    if (files()[rel] !== undefined) { println(`cd: not a directory: ${arg}`); return; }
    if (!dirs().has(rel)) { println(`cd: no such file or directory: ${arg}`); return; }
    prev = cwd;
    cwd = rel;
  };

  const cat = (args: string[]) => {
    if (!args.length) { println(`cat: reading the keyboard is not in the demo`); return; }
    for (const a of args) {
      const rel = resolve(a);
      if (rel !== null && dirs().has(rel)) println(`cat: ${a}: Is a directory`);
      else if (rel === null || files()[rel] === undefined) println(`cat: ${a}: No such file or directory`);
      else out(files()[rel]!.replace(/\n/g, '\r\n'));
    }
  };

  /** The working tree against HEAD: modified, deleted and untracked paths. */
  const changes = () => {
    const head = ctx.world.head;
    const cur = files();
    const all = [...new Set([...Object.keys(head), ...Object.keys(cur)])].sort();
    return all.flatMap((rel) => {
      if (head[rel] === cur[rel]) return [];
      return [{ rel, kind: head[rel] === undefined ? '?' as const : cur[rel] === undefined ? 'D' as const : 'M' as const }];
    });
  };

  const gitStatus = () => {
    const list = changes();
    println('On branch main');
    if (!list.length) { println('nothing to commit, working tree clean'); return; }
    const tracked = list.filter((c) => c.kind !== '?');
    const untracked = list.filter((c) => c.kind === '?');
    if (tracked.length) {
      println('Changes not staged for commit:');
      println('  (use "git add <file>..." to update what will be committed)');
      println('  (use "git restore <file>..." to discard changes in working directory)');
      for (const c of tracked) println(`\t${RED}${c.kind === 'M' ? 'modified:   ' : 'deleted:    '}${fromCwd(cwd, c.rel)}${RST}`);
      println();
    }
    if (untracked.length) {
      println('Untracked files:');
      println('  (use "git add <file>..." to include in what will be committed)');
      for (const c of untracked) println(`\t${RED}${fromCwd(cwd, c.rel)}${RST}`);
      println();
    }
    println('no changes added to commit (use "git add" and/or "git commit -a")');
  };

  const gitLog = (args: string[]) => {
    const oneline = args.includes('--oneline');
    const commits = [...ctx.world.commits].reverse();
    const dated = new Map((ctx.world.scm?.commits ?? []).map((c) => [c.oid, c.authorAt]));
    commits.forEach((c, i) => {
      const deco = i === 0 ? ` ${YELLOW}(${BOLD}${CYAN}HEAD -> ${BOLD}${GREEN}main${RST}${YELLOW})${RST}` : '';
      const subject = c.message.split('\n')[0]!;
      if (oneline) { println(`${YELLOW}${c.oid.slice(0, 7)}${RST}${deco} ${subject}`); return; }
      println(`${YELLOW}commit ${c.oid}${RST}${deco}`);
      println('Author: Ada Lovelace <ada@example.com>');
      const at = dated.get(c.oid);
      if (at !== undefined) {
        const d = new Date(at * 1000).toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) ([\d:]+) GMT$/, '$1 $3 $2 $5 $4 +0000');
        println(`Date:   ${d}`);
      }
      println();
      for (const l of c.message.split('\n')) println(`    ${l}`);
      if (i < commits.length - 1) println();
    });
  };

  const gitDiff = (args: string[]) => {
    const only = args.filter((a) => !a.startsWith('-')).map((a) => resolve(a));
    for (const c of changes()) {
      if (c.kind === '?') continue;
      if (only.length && !only.some((p) => p !== null && (c.rel === p || c.rel.startsWith(`${p}/`) || p === ''))) continue;
      const before = ctx.world.head[c.rel] ?? '';
      const after = files()[c.rel] ?? '';
      println(`${BOLD}diff --git a/${c.rel} b/${c.rel}${RST}`);
      if (c.kind === 'D') println(`${BOLD}deleted file mode 100644${RST}`);
      println(`${BOLD}index ${shortHash(before)}..${c.kind === 'D' ? '0000000' : shortHash(after)}${c.kind === 'D' ? '' : ' 100644'}${RST}`);
      println(`${BOLD}--- a/${c.rel}${RST}`);
      println(`${BOLD}+++ ${c.kind === 'D' ? '/dev/null' : `b/${c.rel}`}${RST}`);
      for (const h of structuredPatch(c.rel, c.rel, before, after, '', '', { context: 3 }).hunks) {
        println(`${CYAN}@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${RST}`);
        for (const l of h.lines) {
          if (l.startsWith('\\')) continue;
          println(l[0] === '+' ? `${GREEN}${l}${RST}` : l[0] === '-' ? `${RED}${l}${RST}` : l);
        }
      }
    }
  };

  const git = (args: string[]) => {
    const [sub, ...rest] = args;
    if (sub === 'status') gitStatus();
    else if (sub === 'log') gitLog(rest);
    else if (sub === 'diff') gitDiff(rest);
    else println(`${DIM}demo shell: git status, git log and git diff work here — in Atelier this is your own git${RST}`);
  };

  /** `npm test`: vitest over the project, the results following the files (the sessions' fixes make it pass). */
  const npmTest = (done: () => void) => {
    const f = files();
    const authBroken = (f['src/auth/session.ts'] ?? '').includes('expiresAt - SKEW_MS');
    const roundingBroken = !(f['src/billing/invoice.ts'] ?? '').includes('Number.EPSILON');
    const billingTests = ((f['tests/billing.test.ts'] ?? '').match(/\btest\(/g) ?? []).length;
    const ok = (file: string, n: number, ms: number) => ` ${GREEN}✓${RST} ${file} ${DIM}(${n} tests) ${ms}ms${RST}`;
    const bad = (file: string, n: number, ms: number, test: string, why: string) => [
      ` ${YELLOW}❯${RST} ${file} ${DIM}(${n} tests | ${RST}${RED}1 failed${RST}${DIM}) ${ms}ms${RST}`,
      `   ${RED}× ${test}${RST}`,
      `     ${RED}→ ${why}${RST}`
    ];
    const suites: string[][] = [
      [ok('tests/auth/tokens.test.ts', 3, 4)],
      authBroken ? bad('tests/auth/session.test.ts', 4, 9, 'accepts a token inside the clock skew', "expected null to deeply equal { userId: 'u1' }") : [ok('tests/auth/session.test.ts', 4, 6)],
      [ok('tests/billing.test.ts', billingTests, 3)],
      [ok('tests/billing/currency.test.ts', 4, 5)],
      roundingBroken ? bad('tests/billing/rounding.test.ts', 4, 7, 'rounds half up on x.xx5', 'expected 10.01 to be 10.02') : [ok('tests/billing/rounding.test.ts', 4, 5)],
      [ok('tests/billing/discounts.test.ts', 3, 4)],
      [ok('tests/billing/tax.test.ts', 3, 3)]
    ];
    const failed = Number(authBroken) + Number(roundingBroken);
    const total = 3 + 4 + billingTests + 4 + 4 + 3 + 3;
    const files_ = `${failed ? `${RED}${failed} failed${RST} | ` : ''}${GREEN}${suites.length - failed} passed${RST} (${suites.length})`;
    const tests = `${failed ? `${RED}${failed} failed${RST} | ` : ''}${GREEN}${total - failed} passed${RST} (${total})`;
    const time = new Date(ctx.now()).toTimeString().slice(0, 8);
    const lines = [
      '', '> acme-store@0.1.0 test', '> vitest run', '',
      ` ${BOLD}${CYAN}RUN${RST} ${CYAN}v3.2.4${RST} ${DIM}${root}${RST}`, '',
      ...suites.flat(), '',
      ` ${DIM}Test Files${RST}  ${files_}`,
      `      ${DIM}Tests${RST}  ${tests}`,
      `   ${DIM}Start at${RST}  ${time}`,
      `   ${DIM}Duration${RST}  1.21s ${DIM}(transform 88ms, setup 0ms, collect 301ms, tests 41ms)${RST}`, ''
    ];
    host.update((t) => ({ ...t, foreground: 'node' }));
    let i = 0;
    const step = () => {
      if (i >= lines.length) { running = null; host.update((t) => ({ ...t, foreground: 'zsh' })); done(); return; }
      println(lines[i++]!);
      // The run itself takes a moment; the header and the summary come at once.
      running = ctx.clock.after(i > 6 && i < 6 + suites.flat().length ? 140 : 40, step);
    };
    running = ctx.clock.after(250, step);
  };

  const date = () => {
    const d = new Date(ctx.now());
    const [w, m, day, y, time] = d.toString().split(' ');
    return `${w} ${m} ${day} ${time} ${y}`;
  };

  /** Runs a line; `done` shows the prompt again (later, for a command that streams). */
  const exec = (text: string, done: () => void) => {
    const [cmd, ...args] = words(text);
    if (!cmd) return done();
    switch (cmd) {
      case 'help': HELP.forEach((l) => println(l)); break;
      case 'ls': ls(args); break;
      case 'cd': cd(args[0]); break;
      case 'pwd': println(`${root}${cwd ? `/${cwd}` : ''}`); break;
      case 'cat': cat(args); break;
      case 'clear': buffer = ''; out(`${ESC}[H${ESC}[2J${ESC}[3J`); break;
      case 'git': git(args); break;
      case 'npm':
        if (args[0] === 'test' || args[0] === 't' || (args[0] === 'run' && args[1] === 'test')) return npmTest(done);
        println(`${DIM}demo shell: only \`npm test\` runs here — in Atelier this is your own npm${RST}`);
        break;
      case 'claude': println(`${DIM}Claude starts in a new session tab.${RST}`); o.claude(); break;
      case 'echo': println(args.join(' ')); break;
      case 'whoami': println('ada'); break;
      case 'date': println(date()); break;
      case 'exit': o.exit(); return;
      default:
        println(`zsh: command not found: ${cmd}`);
        println(HINT);
    }
    done();
  };

  // Tab: completes the word under the cursor (a command first, then files and folders), lists the choices when several.
  const COMMANDS = ['cat', 'cd', 'claude', 'clear', 'date', 'echo', 'exit', 'git', 'help', 'ls', 'npm', 'pwd', 'whoami'];
  const complete = () => {
    const before = [...line].slice(0, cursor).join('');
    const word = /(\S*)$/.exec(before)![1]!;
    const first = !before.slice(0, before.length - word.length).trim();
    let options: string[];
    let stem = word;
    let base = '';
    if (first) options = COMMANDS.filter((c) => c.startsWith(word));
    else {
      const slash = word.lastIndexOf('/');
      base = slash >= 0 ? word.slice(0, slash + 1) : '';
      stem = word.slice(slash + 1);
      const dir = resolve(base || '.');
      options = dir === null || !dirs().has(dir) ? [] : entries(dir).filter((e) => e.name.startsWith(stem)).map((e) => (e.isDir ? `${e.name}/` : e.name));
    }
    if (!options.length) return;
    let common = options[0]!;
    for (const x of options) while (!x.startsWith(common)) common = common.slice(0, -1);
    const add = (options.length === 1 && first ? `${common} ` : options.length === 1 && !common.endsWith('/') ? `${common} ` : common).slice(stem.length);
    if (add) {
      const chars = [...line];
      chars.splice(cursor, 0, ...add);
      line = chars.join('');
      cursor += [...add].length;
      renderLine();
    } else if (options.length > 1) {
      out('\r\n');
      println(options.map((x) => (x.endsWith('/') ? `${BLUE}${x}${RST}` : x)).join('  '));
      renderLine();
    }
  };

  const insert = (text: string) => {
    const chars = [...line];
    const add = [...text.replace(/[\r\n]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '')];
    chars.splice(cursor, 0, ...add);
    line = chars.join('');
    cursor += add.length;
    renderLine();
  };

  const key = (k: Key) => {
    if (running) {
      if (k.t === 'ctrl' && k.key === 'c') {
        running();
        running = null;
        host.update((t) => ({ ...t, foreground: 'zsh' }));
        out('^C\r\n');
        line = '';
        cursor = 0;
        out(prompt());
      }
      return;
    }
    const chars = [...line];
    switch (k.t) {
      case 'text': case 'paste': insert(k.text); return;
      case 'backspace': if (cursor > 0) { chars.splice(cursor - 1, 1); line = chars.join(''); cursor--; renderLine(); } return;
      case 'delete': if (cursor < chars.length) { chars.splice(cursor, 1); line = chars.join(''); renderLine(); } return;
      case 'left': if (cursor > 0) { cursor--; out(`${ESC}[D`); } return;
      case 'right': if (cursor < chars.length) { cursor++; out(`${ESC}[C`); } return;
      case 'home': cursor = 0; renderLine(); return;
      case 'end': cursor = chars.length; renderLine(); return;
      case 'up': case 'down': {
        if (!history.length) return;
        if (hIndex === history.length) draft = line;
        hIndex = k.t === 'up' ? Math.max(0, hIndex - 1) : Math.min(history.length, hIndex + 1);
        line = hIndex === history.length ? draft : history[hIndex]!;
        cursor = [...line].length;
        renderLine();
        return;
      }
      case 'tab': complete(); return;
      case 'ctrl':
        switch (k.key) {
          case 'c': out('^C\r\n'); line = ''; cursor = 0; hIndex = history.length; out(prompt()); return;
          case 'l': out(`${ESC}[H${ESC}[2J`); buffer = ''; renderLine(); return;
          case 'u': line = chars.slice(cursor).join(''); cursor = 0; renderLine(); return;
          case 'w': {
            const head = chars.slice(0, cursor).join('').replace(/\S+\s*$/, '');
            line = head + chars.slice(cursor).join('');
            cursor = [...head].length;
            renderLine();
            return;
          }
          case 'a': cursor = 0; renderLine(); return;
          case 'e': cursor = chars.length; renderLine(); return;
          case 'd': if (!line) { o.exit(); } return;
          default: return;
        }
      case 'enter': {
        const text = line;
        out('\r\n');
        line = '';
        cursor = 0;
        if (text.trim() && history.at(-1) !== text) history.push(text);
        hIndex = history.length;
        draft = '';
        exec(text.trim(), () => out(prompt()));
        return;
      }
      default: return;
    }
  };

  out(prompt());

  return {
    snapshot: () => PASTE_MODE + buffer,
    input(data) { for (const k of read(data)) key(k); },
    // zsh on SIGWINCH: the prompt line again (xterm reflowed it), unless a command has the screen.
    resize() { if (!running) renderLine(); },
    dispose() { running?.(); running = null; }
  };
}
