// The Claude Code 2.1.332 fixtures are a recording of a real session, rewritten so that nothing personal stays and
// every screen row keeps its length. These tests pin the rewriting rules and guard the committed files.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
// @ts-expect-error: .mjs script without types
import { check, fictional, rewindOf, sanitize } from '../../scripts/claude-capture-fixtures.mjs';

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
    for (const n of ['trust', 'bash', 'bash-second', 'edit', 'plan', 'question', 'several', 'model', 'queued', 'idle', 'working', ...pastes]) {
      expect(statSync(join(dir, 'screens', `${n}.txt`)).isFile(), n).toBe(true);
      expect(statSync(join(dir, 'screens', `${n}.ans`)).isFile(), n).toBe(true);
    }
    expect(readFileSync(join(dir, 'transcript.jsonl'), 'utf8').trim().split('\n')).toHaveLength(119);
  });

  test('rewind.jsonl is derived from the transcript: its first 23 lines, then a prompt that goes back after the first reply, and its reply', () => {
    const transcript = readFileSync(join(dir, 'transcript.jsonl'), 'utf8');
    const rewind = readFileSync(join(dir, 'rewind.jsonl'), 'utf8');
    expect(rewind).toBe(rewindOf(transcript));
    const lines = rewind.trim().split('\n');
    expect(lines).toHaveLength(25);
    expect(lines.slice(0, 23)).toEqual(transcript.split('\n').slice(0, 23));
    const [back, prompt, reply] = [8, 23, 24].map((i) => JSON.parse(lines[i]!) as { uuid: string; parentUuid: string; message: { content: unknown } });
    expect(prompt).toMatchObject({ type: 'user', parentUuid: back!.uuid, message: { content: 'Only list the files.' } });
    expect(reply).toMatchObject({ type: 'assistant', parentUuid: prompt!.uuid, message: { content: [{ type: 'text', text: 'hello.txt' }] } });
    // Ids of their own: no line's uuid repeated.
    const ids = lines.map((l) => (JSON.parse(l) as { uuid?: string }).uuid).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
