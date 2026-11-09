import { describe, expect, it } from 'vitest';
import { DENY_RULES, SECRET_PATTERNS, companionArgs, companionRoot } from './args';
import type { CompanionModel } from './types';

const U = '11111111-2222-4333-8444-555555555555';
const base = { model: 'sonnet' as CompanionModel, projectRoot: '/p/app', threadDir: '/h/companion/S', claudeUuid: U, resume: false, platform: 'darwin' as const };
const RULES = [
  'Read(//**/.env*)', 'Read(//**/*.pem)', 'Read(//**/*.key)', 'Read(//**/id_rsa*)', 'Read(//**/id_ed25519*)',
  'Read(//**/id_ecdsa*)', 'Read(//**/*.p12)', 'Read(//**/*.pfx)', 'Read(//**/credentials*)', 'Read(//**/.netrc)', 'Read(//**/.npmrc)',
];
const head = ['-p', '--model', 'sonnet', '--restricted', '--tools', 'Read,Grep,Glob', '--allowedTools', 'Read,Grep,Glob',
  '--permission-mode', 'dontAsk', '--disallowedTools', ...RULES,
  '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--add-dir', '/p/app',
  '--append-system-prompt-file', '/h/companion/S/rules.md'];
const tail = ['--output-format', 'stream-json', '--verbose', '--include-partial-messages'];

describe('DENY_RULES', () => {
  it('are root-free and cover every secret pattern', () => {
    expect([...DENY_RULES]).toEqual(RULES);
    expect(SECRET_PATTERNS).toHaveLength(RULES.length);
  });
});

describe('companionArgs', () => {
  it('first run: exactly the read-only argv', () => {
    expect(companionArgs(base)).toEqual([...head, '--session-id', U, ...tail]);
  });
  it('resume: exactly the argv with --resume', () => {
    expect(companionArgs({ ...base, resume: true })).toEqual([...head, '--resume', U, ...tail]);
  });
  it('catch-up: schema appended last', () => {
    const schema = { type: 'object' };
    expect(companionArgs({ ...base, schema })).toEqual([...head, '--session-id', U, ...tail, '--json-schema', JSON.stringify(schema)]);
  });
  it('a root with glob characters and spaces gives the same deny rules and reaches --add-dir intact', () => {
    const root = '/p/proj [v2] (1)/a*b?';
    const a = companionArgs({ ...base, projectRoot: root });
    expect(a[a.indexOf('--add-dir') + 1]).toBe(root);
    const d = a.slice(a.indexOf('--disallowedTools') + 1, a.indexOf('--setting-sources'));
    expect(d).toEqual(RULES);
  });
  it('never contains a write tool or a permission bypass, in any combination', () => {
    const banned = ['Bash', 'Edit', 'Write', 'NotebookEdit', '--settings', '--mcp-config', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions'];
    const win = { platform: 'win32' as const, projectRoot: 'C:\\dev\\app', threadDir: 'C:\\h\\companion\\S' };
    for (const where of [{}, win])
      for (const model of ['haiku', 'sonnet', 'opus'] as const)
        for (const resume of [false, true])
          for (const schema of [undefined, { type: 'object' }]) {
            const a = companionArgs({ ...base, ...where, model, resume, schema });
            for (const b of banned) expect(a.filter((x) => x === b || x.split(',').includes(b))).toEqual([]);
          }
  });
  it('throws for roots that are relative, root, or not normalized', () => {
    for (const r of ['p/app', './app', '', '/', '//', '/p/../app', '/p/./app', '/p//app', '/p/app/..'])
      expect(() => companionArgs({ ...base, projectRoot: r })).toThrow();
  });
  it('accepts a trailing slash', () => {
    expect(companionArgs({ ...base, projectRoot: '/p/app/' })).toEqual(companionArgs(base));
  });
  it('macOS: a Windows root is refused', () => {
    for (const r of ['C:\\dev\\app', 'C:/dev/app', '\\\\server\\share\\app'])
      expect(() => companionArgs({ ...base, projectRoot: r })).toThrow();
  });
  it('throws unless the session id is a uuid (it could be parsed as a flag)', () => {
    for (const resume of [true, false])
      for (const id of ['--tools=Bash', '--mcp-config=x', '', 'abc', U + 'x'])
        expect(() => companionArgs({ ...base, resume, claudeUuid: id })).toThrow();
  });
  it('throws for a model outside the enum', () => {
    expect(() => companionArgs({ ...base, model: 'gpt' as CompanionModel })).toThrow();
    expect(() => companionArgs({ ...base, model: '--tools=Bash' as CompanionModel })).toThrow();
  });
});

// Windows: folders as seen on a test PC. Main hands the project root in
// the canonical form (C:/…), the thread folder as node:path made it (C:\…); Claude gets both native.
describe('companionArgs on Windows', () => {
  const ROOT = 'C:\\dev\\spike-ask\\proj [v2] (1)';
  const THREAD = 'C:\\dev\\spike-ask\\home\\companion\\t1';
  const win = { ...base, platform: 'win32' as const, projectRoot: ROOT, threadDir: THREAD };
  const at = (a: string[], flag: string) => a[a.indexOf(flag) + 1];

  it('a real Windows argv: the root and the rules file native, the deny rules unchanged', () => {
    const a = companionArgs(win);
    expect(at(a, '--add-dir')).toBe(ROOT);
    expect(at(a, '--append-system-prompt-file')).toBe(`${THREAD}\\rules.md`);
    expect(a.slice(a.indexOf('--disallowedTools') + 1, a.indexOf('--setting-sources'))).toEqual(RULES);
    // Everything else as on macOS.
    const paths = (x: string[]) => x.map((v) => (v === at(x, '--add-dir') ? 'ROOT' : v === at(x, '--append-system-prompt-file') ? 'RULES' : v));
    expect(paths(a)).toEqual(paths(companionArgs(base)));
  });
  it('main\'s canonical root (C:/…, forward slashes) and a lower-case drive reach Claude native', () => {
    for (const r of ['C:/dev/spike-ask/proj [v2] (1)', 'c:\\dev\\spike-ask\\proj [v2] (1)', 'C:/dev\\spike-ask/proj [v2] (1)'])
      expect(at(companionArgs({ ...win, projectRoot: r }), '--add-dir'), r).toBe(ROOT);
    expect(at(companionArgs({ ...win, threadDir: 'C:/dev/spike-ask/home/companion/t1' }), '--append-system-prompt-file')).toBe(`${THREAD}\\rules.md`);
  });
  it('accepts a trailing separator', () => {
    for (const r of [`${ROOT}\\`, 'C:/dev/spike-ask/proj [v2] (1)/']) expect(companionArgs({ ...win, projectRoot: r })).toEqual(companionArgs(win));
  });
  it('refuses a drive root (the whole disk), UNC and device paths, relative, drive-relative and posix roots', () => {
    for (const r of ['C:\\', 'C:/', 'C:', 'C:\\\\', '\\\\server\\share\\proj', '//server/share/proj', '\\\\?\\C:\\dev\\proj', '\\\\.\\C:\\dev',
      'dev\\proj', '\\dev\\proj', 'C:dev\\proj', '/p/app', ''])
      expect(() => companionArgs({ ...win, projectRoot: r }), r).toThrow();
  });
  it('refuses a root that is not normalized or holds a name Windows can\'t have', () => {
    for (const r of ['C:\\dev\\..\\proj', 'C:\\dev\\.\\proj', 'C:\\dev\\\\proj', 'C:\\dev\\proj\\..', 'C:\\dev\\a<b', 'C:\\dev\\aux', 'C:\\dev\\proj.\\x', 'C:\\dev\\a\u0007b'])
      expect(() => companionArgs({ ...win, projectRoot: r }), r).toThrow();
  });
});

describe('companionRoot (what --add-dir gets and rules.md names)', () => {
  it('macOS: the root without its trailing slash', () => {
    expect(companionRoot('/p/app/', 'darwin')).toBe('/p/app');
    expect(() => companionRoot('/', 'darwin')).toThrow();
  });
  it('Windows: native, the drive upper-case', () => {
    expect(companionRoot('c:/dev/proj [v2] (1)/', 'win32')).toBe('C:\\dev\\proj [v2] (1)');
    expect(() => companionRoot('C:\\', 'win32')).toThrow();
  });
});
