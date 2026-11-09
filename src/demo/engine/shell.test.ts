import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createDemo } from '../bridge/index';
import { compileWorld } from '../compile/index';
import { HINT, words } from './shell';

// The demo's shell: a new terminal, the visitor's keys in, the screen's text out.

const compiled = compileWorld();
const ESC = '\u001b';
const plain = (s: string) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(compiled.t0); });
afterEach(() => { vi.useRealTimers(); });

async function shell() {
  const d = createDemo(compiled, { version: '9.9.9', now: () => Date.now() });
  const t = await d.api.terminals.create({ cols: 100, rows: 30 });
  let out = '';
  d.api.on.snapshot((_id, s) => { out = s; });
  d.api.on.data((_id, s) => { out += s; });
  await d.api.terminals.attach(t.id);
  const run = (line: string) => { const from = out.length; d.api.terminals.input(t.id, `${line}\r`); return plain(out.slice(from)); };
  return { d, t, run, raw: () => out, text: () => plain(out), key: (s: string) => d.api.terminals.input(t.id, s) };
}

describe('commands', () => {
  test('the prompt: the project folder and the branch', async () => {
    const s = await shell();
    expect(s.raw()).toContain(`${ESC}[?2004h`);
    expect(s.text()).toBe('~/code/acme-store main › ');
  });

  test('help lists the commands and says where the real shell is', async () => {
    const out = (await shell()).run('help');
    for (const c of ['ls', 'cd', 'cat', 'git status', 'git log', 'git diff', 'npm test', 'claude']) expect(out).toContain(c);
    expect(out).toContain('your own zsh');
  });

  test('ls, ls -la, ls of a folder and of a missing path', async () => {
    const s = await shell();
    expect(s.run('ls')).toContain('compose.yml  package.json  prisma  README.md  src  tests');
    const long = s.run('ls -la');
    expect(long).toMatch(/drwxr-xr-x {2}4 ada {2}staff +128 Oct 15 09:41 \.git/);
    expect(long).toMatch(/-rw-r--r-- {2}1 ada {2}staff +\d+ Oct 15 09:41 package\.json/);
    expect(s.run('ls src/auth')).toContain('session.ts  tokens.ts');
    expect(s.run('ls nope')).toContain('ls: nope: No such file or directory');
  });

  test('cd and pwd; cd .., cd -, cd ~; errors', async () => {
    const s = await shell();
    s.run('cd src/auth');
    expect(s.run('pwd')).toContain(`${compiled.project.root}/src/auth`);
    expect(s.text()).toContain('~/code/acme-store/src/auth main › ');
    s.run('cd ..');
    expect(s.run('pwd')).toContain(`${compiled.project.root}/src\n`);
    s.run('cd -');
    expect(s.run('pwd')).toContain('/src/auth\n');
    s.run('cd');
    expect(s.run('pwd')).toContain(`${compiled.project.root}\n`);
    expect(s.run('cd README.md')).toContain('cd: not a directory: README.md');
    expect(s.run('cd nowhere')).toContain('cd: no such file or directory: nowhere');
    expect(s.run('cd ..')).toContain("outside the demo's project");
  });

  test('cat prints the working tree (the sessions’ edits included)', async () => {
    const s = await shell();
    expect(s.run('cat src/auth/session.ts')).toContain('const SKEW_MS = 30_000;');
    expect(s.run('cat src')).toContain('cat: src: Is a directory');
    expect(s.run('cat x.ts')).toContain('cat: x.ts: No such file or directory');
  });

  test('git status: the sessions’ modified files, relative to the folder', async () => {
    const s = await shell();
    const out = s.run('git status');
    expect(out).toContain('On branch main');
    expect(out).toContain('Changes not staged for commit:');
    for (const f of ['README.md', 'src/auth/session.ts', 'src/pages/welcome.tsx', 'tests/billing.test.ts']) expect(out).toContain(`modified:   ${f}`);
    s.run('cd src');
    expect(s.run('git status')).toContain('modified:   ../README.md');
  });

  test('git log, full and --oneline, HEAD on top', async () => {
    const s = await shell();
    const head = compiled.commits.at(-1)!;
    expect(s.run('git log --oneline').split('\n').filter((l) => /^[0-9a-f]{7} /.test(l))).toEqual([
      `${head.oid.slice(0, 7)} (HEAD -> main) Test invoice totals`,
      `${compiled.commits[1]!.oid.slice(0, 7)} Add sessions, invoices and the welcome page`,
      `${compiled.commits[0]!.oid.slice(0, 7)} Start the Acme store`
    ]);
    const full = s.run('git log');
    expect(full).toContain(`commit ${head.oid} (HEAD -> main)`);
    expect(full).toContain('Author: Ada Lovelace <ada@example.com>');
    expect(full).toMatch(/Date: {3}\w{3} \w{3} \d+ \d\d:\d\d:\d\d 2026 \+0000/);
  });

  test('git diff of a file: the hunk against HEAD, coloured', async () => {
    const s = await shell();
    const from = s.raw().length;
    const out = s.run('git diff src/auth/session.ts');
    expect(out).toContain('diff --git a/src/auth/session.ts b/src/auth/session.ts');
    expect(out).toContain('+const SKEW_MS = 30_000;');
    expect(out).toContain('-  if (!entry || entry.expiresAt < Date.now()) return null;');
    expect(s.raw().slice(from)).toContain(`${ESC}[32m+const SKEW_MS`);
    expect(out).not.toContain('README.md');
  });

  test('npm test: streams, fails where the sessions left bugs, passes once they are fixed', async () => {
    const s = await shell();
    s.run('npm test');
    expect(s.d.context.state.terminals.find((t) => t.id === s.t.id)!.foreground).toBe('node');
    vi.advanceTimersByTime(5000);
    expect(s.text()).toContain('× accepts a token inside the clock skew');
    expect(s.text()).toContain('× rounds half up on x.xx5');
    expect(s.text()).toContain('Tests  2 failed | 21 passed (23)');
    expect(s.text().endsWith('~/code/acme-store main › ')).toBe(true);
    expect(s.d.context.state.terminals.find((t) => t.id === s.t.id)!.foreground).toBe('zsh');
    s.d.context.worktree.write('src/auth/session.ts', s.d.context.state.files['src/auth/session.ts']!.replace('- SKEW_MS', '+ SKEW_MS'));
    s.d.context.worktree.write('src/billing/invoice.ts', s.d.context.state.files['src/billing/invoice.ts']!.replace('* 100) / 100', '+ Number.EPSILON) * 100) / 100'));
    const from = s.text().length;
    s.run('npm test');
    vi.advanceTimersByTime(5000);
    expect(s.text().slice(from)).toContain('Tests  23 passed (23)');
  });

  test('Ctrl+C stops npm test and gives the prompt back', async () => {
    const s = await shell();
    s.run('npm test');
    vi.advanceTimersByTime(600);
    s.key('\x03');
    const at = s.text().length;
    vi.advanceTimersByTime(5000);
    expect(s.text().slice(at)).toBe('');
    expect(s.text().endsWith('^C\n~/code/acme-store main › ')).toBe(true);
  });

  test('claude, echo, whoami, date, clear', async () => {
    const s = await shell();
    expect(s.run('echo hello "big world"')).toContain('hello big world');
    expect(s.run('whoami')).toContain('ada');
    expect(s.run('date')).toMatch(/\w{3} \w{3} \d+ \d\d:\d\d:\d\d 2026/);
    s.run('clear');
    expect(s.raw()).toContain(`${ESC}[2J`);
    expect(s.run('claude')).toContain('new session tab');
    expect(s.d.context.state.terminals.at(-1)!.foreground).toBe('claude');
  });

  test('an unknown command: zsh says so, then the hint', async () => {
    const out = (await shell()).run('vim README.md');
    expect(out).toContain('zsh: command not found: vim');
    expect(out).toContain(plain(HINT));
  });

  test('exit closes the terminal', async () => {
    const s = await shell();
    s.run('exit');
    expect(s.d.context.state.terminals.some((t) => t.id === s.t.id)).toBe(false);
  });
});

describe('line editing', () => {
  test('←/→ move the cursor, typing inserts there, Backspace deletes before it', async () => {
    const s = await shell();
    s.key('eho hi');
    s.key(`${ESC}[D${ESC}[D${ESC}[D${ESC}[D${ESC}[D`);
    s.key('c');
    expect(s.run('')).toContain('hi');
    s.key('pwdd\x7f');
    expect(s.run('')).toContain(compiled.project.root);
  });

  test('↑/↓ walk the history', async () => {
    const s = await shell();
    s.run('echo one');
    s.run('echo two');
    s.key(`${ESC}[A${ESC}[A`);
    expect(s.run('')).toContain('one');
    s.key(`${ESC}[A${ESC}[B${ESC}[B`);
    expect(s.text().endsWith('› ')).toBe(true);
  });

  test('Ctrl+C drops the line, Ctrl+U clears it, Ctrl+L clears the screen', async () => {
    const s = await shell();
    s.key('echo nope\x03');
    expect(s.text()).toContain('echo nope^C');
    s.key('echo nope\x15');
    expect(s.run('')).not.toContain('nope\n');
    const from = s.raw().length;
    s.key('ls\x0c');
    expect(plain(s.raw().slice(from).split(`${ESC}[H${ESC}[2J`).at(-1)!)).toBe('~/code/acme-store main › ls');
  });

  test('Tab completes a command and a path, lists the choices when several', async () => {
    const s = await shell();
    s.key('ec\t');
    s.key('hi\r');
    expect(s.text()).toContain('echo hi');
    s.key('cat src/au\t');
    s.key('to\t');
    expect(s.text()).toContain('cat src/auth/tokens.ts ');
    s.key('\x03ls src/\t');
    expect(s.text()).toMatch(/auth\/ {2}billing\/ {2}pages\//);
  });

  test('a resize redraws the prompt line, the cursor where it was (zsh on SIGWINCH); a running command is left alone', async () => {
    const s = await shell();
    s.key(`git st${ESC}[D${ESC}[D`);
    let from = s.raw().length;
    s.d.api.terminals.resize(s.t.id, 60, 20);
    expect(s.raw().slice(from)).toBe(`\r${ESC}[K${ESC}[1m${ESC}[36m~/code/acme-store${ESC}[0m ${ESC}[35mmain${ESC}[0m ${ESC}[2m›${ESC}[0m git st${ESC}[2D`);
    s.key('\x03npm test\r');
    from = s.raw().length;
    s.d.api.terminals.resize(s.t.id, 80, 24);
    expect(s.raw().slice(from)).toBe('');
  });

  test('a paste goes into the line', async () => {
    const s = await shell();
    s.key('\x1b[200~echo pasted\x1b[201~');
    expect(s.run('')).toContain('pasted');
  });
});

test('words: quotes keep spaces', () => {
  expect(words(`git commit -m "a b" 'c d' e`)).toEqual(['git', 'commit', '-m', 'a b', 'c d', 'e']);
});
