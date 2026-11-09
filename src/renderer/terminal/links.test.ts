import { describe, expect, test } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import type { Row } from '@shared/wrapped-paths';
import { HoveredLink, claimClick, linkActivate, linkTargets, outsideLink, type TargetDeps } from './links';
import { ModKey, trackModKey } from './mod-key';

describe('linkTargets', () => {
  const TMP = '/private/tmp/claude-501/-p/sess/scratchpad/shots/a.png';
  const cols = 40;
  // Claude cut the temp path where the row was full and went on after an indent.
  const rows: Row[] = [
    { text: `⏺ Read(${TMP.slice(0, cols - 7)}`, wrapped: false },
    { text: `      ${TMP.slice(cols - 7)})`, wrapped: false },
    { text: '  see src/a.ts:3 too', wrapped: false }
  ];
  const at = (y: number) => rows[y];
  function deps(over: Partial<TargetDeps> = {}): TargetDeps & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      resolve: async (c) => { calls.push(`resolve ${c}`); return c === 'src/a.ts' ? { path: '/proj/src/a.ts', rel: 'src/a.ts' } : null; },
      claudeResolve: async (p) => { calls.push(`claude ${p}`); return p === TMP ? { path: TMP, rel: 'scratchpad/shots/a.png' } : null; },
      ...over
    };
  }

  test('each row of a wrapped Claude temp image gets its own piece, aimed at the image', async () => {
    for (const y of [0, 1]) {
      const [t] = await linkTargets(at, y, cols, deps());
      expect(t!.target).toEqual({ path: TMP, rel: 'scratchpad/shots/a.png', line: null, claude: true });
      expect(t!.start).toBe(y === 0 ? 7 : 6);
      expect(t!.end).toBe(rows[y]!.text.length - (y === 0 ? 0 : 1));
    }
  });

  test('the project resolver is asked first; a project file never reaches the temp-folder check', async () => {
    const d = deps();
    const [t] = await linkTargets(at, 2, cols, d);
    expect(t).toMatchObject({ start: 6, end: 16, target: { path: '/proj/src/a.ts', rel: 'src/a.ts', line: 3, claude: false } });
    expect(d.calls).toEqual(['resolve src/a.ts']);
  });

  test('any absolute path the project lacks goes to the temp-folder check; a relative one never does', async () => {
    const d = deps();
    const one = (text: string) => linkTargets(() => ({ text, wrapped: false }), 0, 80, d);
    // Not the temp folder's: an outside target, unchecked.
    expect((await one('cat /private/tmp/claude-501/x/notes.md')).map((x) => x.target.outside)).toEqual([true]);
    expect(await one('open shots/a.png')).toEqual([]);
    expect(d.calls.filter((c) => c.startsWith('claude'))).toEqual(['claude /private/tmp/claude-501/x/notes.md']);
  });

  test('a temp-folder file at a line keeps its line', async () => {
    const LOG = '/private/tmp/claude-501/-p/sess/tasks/b1.output';
    const d = deps({ claudeResolve: async (p) => (p === LOG ? { path: LOG, rel: 'tasks/b1.output' } : null) });
    const [t] = await linkTargets(() => ({ text: `  see ${LOG}:120 for the error`, wrapped: false }), 0, 120, d);
    expect(t).toEqual({ start: 6, end: 6 + LOG.length + 4, target: { path: LOG, rel: 'tasks/b1.output', line: 120, claude: true } });
  });

  test('a draft Claude wrote in its scratchpad, named at the end of a sentence, is a link to the temp-folder file', async () => {
    // From a screenshot: the path alone on its row, after Claude's prose, with the sentence's period.
    const MD = '/private/tmp/claude-501/-Users-ada-Developer-store/de43b06a-b603/scratchpad/message-for-the-review.md';
    const prose: Row[] = [
      { text: '⏺ Il messaggio per Simona è negli appunti. È anche in', wrapped: false },
      { text: `  ${MD}.`, wrapped: false }
    ];
    const d = deps({ claudeResolve: async (p) => (p === MD ? { path: MD, rel: 'scratchpad/message-for-the-review.md' } : null) });
    const [t, ...more] = await linkTargets((y) => prose[y], 1, 160, d);
    expect(more).toEqual([]);
    expect(t).toEqual({ start: 2, end: 2 + MD.length, target: { path: MD, rel: 'scratchpad/message-for-the-review.md', line: null, claude: true } });
  });

  test('a joined path that resolves nowhere falls back to the row\'s own candidates', async () => {
    const full = `${'x'.repeat(cols - 10)} docs/a.md`;
    const glued: Row[] = [{ text: full, wrapped: false }, { text: '  and/then.txt', wrapped: false }];
    expect(full.length).toBe(cols);
    const d = deps({ resolve: async (c) => (c === 'docs/a.md' ? { path: '/proj/docs/a.md', rel: 'docs/a.md' } : null) });
    const [t] = await linkTargets((y) => glued[y], 0, cols, d);
    expect(t).toMatchObject({ start: cols - 9, end: cols, target: { path: '/proj/docs/a.md', line: null, claude: false } });
  });

  describe('outside paths', () => {
    const none = (calls: string[] = []): TargetDeps => ({
      resolve: async (c) => { calls.push(`resolve ${c}`); return null; },
      claudeResolve: async (p) => { calls.push(`claude ${p}`); return null; }
    });
    const one = (text: string, d: TargetDeps = none()) => linkTargets(() => ({ text, wrapped: false }), 0, 120, d);

    test('an absolute path neither the project nor the temp folder holds: an outside target, as written, with its line', async () => {
      const calls: string[] = [];
      expect(await one('wrote /tmp/report.md:12 just now', none(calls))).toEqual([
        { start: 6, end: 23, target: { path: '/tmp/report.md', rel: '', line: 12, claude: false, outside: true } }
      ]);
      // Nothing more asked: main checks it only while ⌘ is held.
      expect(calls).toEqual(['resolve /tmp/report.md', 'claude /tmp/report.md']);
    });

    test('a home path too, as written (main expands ~), never sent to the temp-folder check', async () => {
      const calls: string[] = [];
      expect(await one('  Plan saved to ~/.claude/plans/fuzzy-otter.md', none(calls))).toEqual([
        { start: 16, end: 46, target: { path: '~/.claude/plans/fuzzy-otter.md', rel: '', line: null, claude: false, outside: true } }
      ]);
      expect(calls).toEqual(['resolve ~/.claude/plans/fuzzy-otter.md']);
    });

    test('a file:// URL outside the project: an outside target by the path it names, decoded as written (main refuses a `..`)', async () => {
      expect((await one('open file:///tmp/My%20Plan.md now')).map((x) => x.target)).toEqual([
        { path: '/tmp/My Plan.md', rel: '', line: null, claude: false, outside: true }
      ]);
      expect((await one('see file:///tmp/a/%2E%2E/etc/x.md')).map((x) => x.target.path)).toEqual(['/tmp/a/../etc/x.md']);
    });

    test('a relative path never is one; a project file stays the project\'s', async () => {
      expect(await one('see docs/a.md and ./b.ts')).toEqual([]);
      const d = { ...none(), resolve: async (c: string) => (c === '/proj/src/a.ts' ? { path: '/proj/src/a.ts', rel: 'src/a.ts' } : null) };
      expect((await one('at /proj/src/a.ts:3', d)).map((x) => x.target)).toEqual([{ path: '/proj/src/a.ts', rel: 'src/a.ts', line: 3, claude: false }]);
    });

    test('a bare name under a folder written above is never an outside target (the folder decides, not a guess)', async () => {
      const rows: Row[] = [{ text: 'In /Users/me/notes/:', wrapped: false }, { text: '  - todo.md', wrapped: false }];
      expect(await linkTargets((y) => rows[y], 1, 120, none())).toEqual([]);
    });

    test('a joined path that is only an outside target gives way to a row candidate the project holds', async () => {
      const head = `${'x'.repeat(cols - 16)} /proj/docs/a.md`;
      const glued: Row[] = [{ text: head, wrapped: false }, { text: '  and/then.txt', wrapped: false }];
      expect(head.length).toBe(cols);
      const d = { ...none(), resolve: async (c: string) => (c === '/proj/docs/a.md' ? { path: '/proj/docs/a.md', rel: 'docs/a.md' } : null) };
      const found = await linkTargets((y) => glued[y], 0, cols, d);
      expect(found.map((x) => x.target)).toEqual([{ path: '/proj/docs/a.md', rel: 'docs/a.md', line: null, claude: false }]);
      // Nothing better on the row: the joined path stays an outside target.
      const far = `${'x'.repeat(cols - 13)} /var/log/sys`;
      const farRows: Row[] = [{ text: far, wrapped: false }, { text: '  tem.log', wrapped: false }];
      expect((await linkTargets((y) => farRows[y], 0, cols, none())).map((x) => x.target.path)).toEqual(['/var/log/system.log']);
    });
  });

  describe('more wrapped paths', () => {
    const DIR = '/private/tmp/claude-501/-p/sess/scratchpad/shots/';
    const listed: Row[] = [
      { text: 'Sono tutti nella cartella:', wrapped: false },
      { text: `  ${DIR}`, wrapped: false },
      { text: '', wrapped: false },
      { text: '  - a.png: la prima;', wrapped: false },
      { text: '  - notes.txt: testo', wrapped: false }
    ];
    const tmpDeps = (calls: string[] = []): TargetDeps => ({
      resolve: async (c) => { calls.push(`resolve ${c}`); return null; },
      claudeResolve: async (p) => {
        calls.push(`claude ${p}`);
        if (p === DIR) return { path: DIR.slice(0, -1), rel: 'scratchpad/shots', folder: true };
        if (p === `${DIR}notes.txt`) return { path: p, rel: 'scratchpad/shots/notes.txt' };
        return p === `${DIR}a.png` ? { path: `${DIR}a.png`, rel: 'scratchpad/shots/a.png' } : null;
      }
    });

    test('a folder inside the temp folder is a folder link', async () => {
      const [t] = await linkTargets((y) => listed[y], 1, 120, tmpDeps());
      expect(t).toMatchObject({ start: 2, end: 2 + DIR.length, target: { path: DIR.slice(0, -1), folder: true, claude: true } });
    });

    test('a bare image name opens from the folder written above it; the project is asked first', async () => {
      const calls: string[] = [];
      const [t] = await linkTargets((y) => listed[y], 3, 120, tmpDeps(calls));
      expect(t).toMatchObject({ start: 4, end: 9, target: { path: `${DIR}a.png`, rel: 'scratchpad/shots/a.png', claude: true } });
      expect(calls).toEqual(['resolve a.png', `resolve ${DIR}a.png`, `claude ${DIR}a.png`]);
    });

    test('a bare name of any kind opens from the folder written above it too', async () => {
      const calls: string[] = [];
      const [t] = await linkTargets((y) => listed[y], 4, 120, tmpDeps(calls));
      expect(t).toMatchObject({ start: 4, end: 13, target: { path: `${DIR}notes.txt`, rel: 'scratchpad/shots/notes.txt', claude: true } });
      expect(calls).toEqual(['resolve notes.txt', `resolve ${DIR}notes.txt`, `claude ${DIR}notes.txt`]);
    });

    test('a bare name climbing out with .. is sent as written under the folder, never normalised', async () => {
      const calls: string[] = [];
      const rows: Row[] = [...listed.slice(0, 3), { text: '  - ../../../../etc/x.png', wrapped: false }];
      expect(await linkTargets((y) => rows[y], 3, 120, tmpDeps(calls))).toEqual([]);
      expect(calls).toContain(`claude ${DIR}../../../../etc/x.png`);
    });

    test('a folder outside the temp folder is no link', async () => {
      const rows: Row[] = [{ text: '  /Users/me/somewhere/', wrapped: false }];
      expect(await linkTargets((y) => rows[y], 0, 120, tmpDeps())).toEqual([]);
    });
  });
});

const term = { modes: { mouseTrackingMode: 'none' } } as unknown as Terminal;

test('a link opens on a plain click with the mouse free, unless click-to-move took that click', () => {
  let opened = 0;
  const activate = linkActivate(term, () => { opened++; });
  activate(({ metaKey: false } as MouseEvent));
  expect(opened).toBe(1);
  const moved = ({ metaKey: false } as MouseEvent);
  claimClick(moved);
  activate(moved);
  expect(opened).toBe(1);
});

describe('an outside link', () => {
  const ev = (mod: boolean) => ({ metaKey: mod, ctrlKey: mod } as MouseEvent);
  function setup() {
    const mod = new ModKey();
    const hovered = new HoveredLink();
    let opened = 0;
    let answer: (ok: boolean) => void = () => {};
    let checks = 0;
    const active = new Set<() => void>();
    const link = outsideLink({ range: { start: { x: 1, y: 1 }, end: { x: 9, y: 1 } }, text: '/tmp/r.md' }, {
      mod, hovered, active,
      check: () => { checks++; return new Promise<boolean>((done) => { answer = done; }); },
      open: () => { opened++; }
    });
    const shown = () => ({ ...link.decorations });
    return { mod, hovered, link, active, shown, opened: () => opened, checks: () => checks, answer: (ok: boolean) => answer(ok) };
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));

  test('hovered without ⌘: nothing shows and the disk is never asked; a click, plain or ⌘, is not taken from xterm', () => {
    const t = setup();
    t.link.hover!(ev(false), t.link.text);
    expect(t.shown()).toEqual({ pointerCursor: false, underline: false });
    expect(t.checks()).toBe(0);
    t.link.activate(ev(false), t.link.text);
    expect(t.opened()).toBe(0);
    // Not the hovered link a ⌘-click takes (interceptLinkClicks) until main said it is a file; xterm's own
    // activation with ⌘ (the release on it) still opens it.
    expect(t.hovered.current).toBeNull();
    t.link.activate(ev(true), t.link.text);
    expect(t.opened()).toBe(1);
  });

  test('⌘ pressed while over it: checked, underlined and ⌘-clickable once main says it is a file; ⌘ released: gone', async () => {
    const t = setup();
    t.link.hover!(ev(false), t.link.text);
    t.mod.set(true);
    expect(t.checks()).toBe(1);
    expect(t.shown().underline).toBe(false);
    t.answer(true);
    await settle();
    expect(t.shown()).toEqual({ pointerCursor: true, underline: true });
    t.hovered.current!();
    expect(t.opened()).toBe(1);
    t.mod.set(false);
    expect(t.shown()).toEqual({ pointerCursor: false, underline: false });
    expect(t.hovered.current).toBeNull();
  });

  test('hovered with ⌘ held: checked at once; not a file: never underlined, its ⌘-click left to the program', async () => {
    const t = setup();
    t.mod.set(true);
    t.link.hover!(ev(true), t.link.text);
    expect(t.checks()).toBe(1);
    t.answer(false);
    await settle();
    expect(t.shown().underline).toBe(false);
    expect(t.hovered.current).toBeNull();
  });

  test('its terminal closed while it is hovered (no leave from xterm): ⌘ is no longer followed', async () => {
    const t = setup();
    t.link.hover!(ev(false), t.link.text);
    expect(t.active.size).toBe(1);
    for (const stop of [...t.active]) stop();
    expect(t.active.size).toBe(0);
    t.mod.set(true);
    expect(t.checks()).toBe(0);
    // A leave afterwards changes nothing.
    t.link.leave!(ev(true), t.link.text);
    expect(t.active.size).toBe(0);
  });

  test('left before main answers, or after: decorations reset for the next hover, ⌘ no longer followed', async () => {
    const t = setup();
    t.mod.set(true);
    t.link.hover!(ev(true), t.link.text);
    t.link.leave!(ev(true), t.link.text);
    t.answer(true);
    await settle();
    expect(t.shown().underline).toBe(false);
    expect(t.hovered.current).toBeNull();
    t.mod.set(false);
    t.mod.set(true);
    expect(t.checks()).toBe(1);
  });
});

describe('ModKey', () => {
  function target() {
    const on = new Map<string, (e: unknown) => void>();
    return { on, addEventListener: (type: string, fn: EventListenerOrEventListenerObject | null) => { on.set(type, fn as unknown as (e: unknown) => void); } };
  }

  test('follows ⌘ (Ctrl on Windows) from keys and the mouse; a blur lets go; listeners hear each change once', () => {
    const t = target();
    const mod = new ModKey();
    const heard: boolean[] = [];
    const off = mod.on((h) => heard.push(h));
    trackModKey(t, mod);
    const key = (type: string, held: boolean) => t.on.get(type)!({ metaKey: held, ctrlKey: held });
    key('keydown', true);
    key('keydown', true);
    expect(mod.held).toBe(true);
    key('keyup', false);
    expect(mod.held).toBe(false);
    // Held while another app was in front: the first move over the window says so.
    t.on.get('mousemove')!({ metaKey: true, ctrlKey: true });
    expect(mod.held).toBe(true);
    t.on.get('blur')!({});
    expect(mod.held).toBe(false);
    expect(heard).toEqual([true, false, true, false]);
    off();
    key('keydown', true);
    expect(heard).toHaveLength(4);
  });
});
