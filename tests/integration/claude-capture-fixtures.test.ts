// The Claude Code 2.1.332 fixtures are a recording of a real session, rewritten so that nothing personal stays and
// every screen row keeps its length. These tests pin the rewriting rules and guard the committed files.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
// @ts-expect-error: .mjs script without types
import { check, fictional, generate, sanitize, SCREENS, TRANSCRIPTS } from '../../scripts/claude-capture-fixtures.mjs';

const root = resolve(__dirname, '../..');
const dir = join(root, 'tests/fixtures/claude-2.1.332');

function filesUnder(d: string): string[] {
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

describe('sanitising a recording', () => {
  test('a recorded path keeps its length, in one piece or wrapped across two rows', () => {
    const p = '/private/tmp/claude-777/-Users-someone-Dev/aaaa1111-bbbb-2222/scratchpad/caps/project';
    const screen = `   2. Yes, and always allow access to ${p.slice(0, 50)}\n      ${p.slice(50)} from this project`;
    const out: string = sanitize(screen, { project: p });
    expect(out.split('\n').map((l) => l.length)).toEqual(screen.split('\n').map((l) => l.length));
    expect(out).not.toMatch(/private|someone|claude-777/);
    expect(out.replace(/\n {6}/, '')).toContain(fictional(p));
  });

  test('the fictional path has the length of the real one, a nested folder and ends in /project', () => {
    const p = '/private/tmp/claude-777/-Users-someone-Dev/aaaa1111-bbbb-2222/scratchpad/caps/project';
    const f: string = fictional(p);
    expect(f).toHaveLength(p.length);
    expect(f.startsWith('/work/hello/nested')).toBe(true);
    expect(f.endsWith('/project')).toBe(true);
  });

  test('home folders, account config dirs and e-mails are rewritten at the same length; nothing left is refused', () => {
    const s = '"file_path":"/Users/someone/.claude-abc/plans/x.md" mail a.b@example.org';
    expect(sanitize(s, { project: '/nowhere' })).toBe(
      '"file_path":"/home/uuuuuuuu/.claude-xxx/plans/x.md" mail xxxxxxxxxxxxxxx',
    );
    expect(() => check('"cwd":"/Users/someone/app"', root)).toThrow();
    expect(() => check('/private/tmp/x', root)).toThrow();
    expect(() => check('a.b@example.org', root)).toThrow();
    expect(() => check('"cwd":"/work/hello/project"', root)).not.toThrow();
  });
});

describe('generating', () => {
  test('only the screens named: from scenarios recorded in a folder of their own, sanitised; nothing else written', () => {
    const base = mkdtempSync(join(tmpdir(), 'atl-capture-'));
    const recording = join(base, 'recording');
    const target = join(base, 'fixtures');
    const [name, source] = Object.entries(SCREENS as Record<string, string>).find(([n]) => n === 'image-pasted')!;
    const project = '/private/tmp/claude-777/-Users-someone-Dev/aaaa1111-bbbb-2222/scratchpad/rec/work';
    mkdirSync(join(recording, source.split('/')[0]!), { recursive: true });
    writeFileSync(join(recording, source.split('/')[0]!, 'project.txt'), `${project}\n`);
    writeFileSync(join(recording, `${source}.lines.txt`), ` ▝▝   ▝▝   /…${project.slice(20)}\n❯ [Image #1]\n`);
    writeFileSync(join(recording, `${source}.snapshot.ans`), `\x1b[?1049h /…${project.slice(20)}`);
    generate(recording, target, root, [name]);
    expect(filesUnder(target).map((f) => f.slice(target.length + 1)).sort()).toEqual([`screens/${name}.ans`, `screens/${name}.txt`]);
    const txt = readFileSync(join(target, 'screens', `${name}.txt`), 'utf8');
    expect(txt).not.toMatch(/private|someone|claude-777/);
    expect(txt).toContain('❯ [Image #1]');
    // A name the script doesn't know is refused.
    expect(() => generate(recording, target, root, ['nope'])).toThrow();
  });
});

describe('the committed fixtures', () => {
  test('hold nothing personal', () => {
    const files = filesUnder(dir);
    expect(files.length).toBeGreaterThan(30);
    for (const f of files) expect(() => check(readFileSync(f, 'utf8'), root), f).not.toThrow();
  });

  test('name no folder but the fictional one: whole, cut where a row wraps, after `~` or shortened with `/…`', () => {
    const screens = filesUnder(join(dir, 'screens')).filter((f) => f.endsWith('.txt'));
    for (const f of screens) {
      for (const [path] of readFileSync(f, 'utf8').matchAll(/\S*\/project\b/g)) {
        expect(path, f).toMatch(/^~?[a-z]*(?:\/(?:work|hello|nested|…))*-*\/project$/);
      }
    }
  });

  test('include the transcript and the named screens', () => {
    const pastes = ['paste-three-lines', 'paste-three-lines-typed', 'paste-four-lines', 'paste-forty-lines', 'paste-forty-lines-typed',
      'paste-two-long-lines', 'paste-three-long-lines', 'paste-line-500', 'paste-line-800', 'paste-line-801', 'paste-line-1000', 'paste-line-2000'];
    const images = ['image-pasted', 'image-text'];
    for (const n of ['trust', 'bash', 'bash-second', 'edit', 'plan', 'question', 'several', 'model', 'queued', 'idle', 'working', ...pastes, ...images]) {
      expect(statSync(join(dir, 'screens', `${n}.txt`)).isFile(), n).toBe(true);
      expect(statSync(join(dir, 'screens', `${n}.ans`)).isFile(), n).toBe(true);
    }
    expect(readFileSync(join(dir, 'transcript.jsonl'), 'utf8').trim().split('\n')).toHaveLength(119);
  });

  test('include the recorded branches: two rewinds, the turns that never branch, Esc before the reply', () => {
    const lengths = Object.fromEntries(Object.keys(TRANSCRIPTS).map((n) => [n, readFileSync(join(dir, n), 'utf8').trim().split('\n').length]));
    expect(lengths).toEqual({ 'rewind.jsonl': 20, 'commands.jsonl': 41, 'esc-before-reply.jsonl': 10 });
    // Each from a folder of its own, rewritten to the fictional one.
    for (const n of Object.keys(TRANSCRIPTS)) {
      const cwd = (JSON.parse(readFileSync(join(dir, n), 'utf8').split('\n')[1]!) as { cwd: string }).cwd;
      expect(cwd, n).toMatch(/^\/work\/hello(?:\/nested)*-*\/project$/);
    }
  });
});
