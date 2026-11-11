import { describe, expect, test } from 'vitest';
import { CHANGES_CAP, capShown, sessionRoots, buildRows, unreadableRepos, changeTimes, chipOf, clashChipLabels, clashChipsShown, clashSessionTip, runningAt, clashNames, cleanRepos, dotProps, fileList, groupByRepo, groupBySession, inSessionOrder, locationRows, originTip, overlapGroups, overlaps, sameMoment, sessionOrderKey, touchedBy, unsureOf, whereRan, type ChangeBy, type ChangeRow } from './changes';
import type { RepoStatus } from '@shared/git';
import type { Attribution } from '@shared/attribution';
import { t } from './i18n/en';

const repo = (name: string, changes: Partial<RepoStatus['changes'][number]>[]): RepoStatus => ({
  root: `/p/${name}`, name, branch: 'dev', detached: false, ahead: 0, behind: 0, oid: 'abc', checkedAt: 0, truncated: 0,
  changes: changes.map((c) => ({ path: `/p/${name}/${c.rel}`, rel: c.rel!, kind: c.kind ?? 'M', stage: 'none' as const, added: 1, removed: 0 }))
});
const at = (path: string, terminalId: string, title = terminalId): Attribution => ({ path, terminalId, sessionId: 's', color: '#' + terminalId, title, at: 1 });

const repos = [repo('app-ui', [{ rel: 'src/App.tsx' }, { rel: 'serve.json' }, { rel: 'package-lock.json' }]), repo('storage', []), repo('email-worker', [{ rel: 'job.ts', kind: '?' }])];
const attrs = [at('/p/app-ui/src/App.tsx', 't1', 'Interlocutori'), at('/p/app-ui/src/App.tsx', 't2', 'Cache'), at('/p/app-ui/serve.json', 't2', 'Cache'), at('/p/email-worker/job.ts', 't3', 'Solleciti'), at('/p/app-ui/pulito.ts', 't1')];

test('lines with who touched them; attributions of clean files ignored', () => {
  const rows = buildRows(repos, attrs);
  expect(rows.map((r) => [r.rel, r.by.map((b) => b.terminalId)])).toEqual([
    ['src/App.tsx', ['t1', 't2']], ['serve.json', ['t2']], ['package-lock.json', []], ['job.ts', ['t3']]
  ]);
});
test('by repo: only dirty ones; clean repos kept apart', () => {
  expect(groupByRepo(buildRows(repos, attrs), repos).map((g) => [g.repo.name, g.rows.length])).toEqual([['app-ui', 3], ['email-worker', 1]]);
  expect(cleanRepos(repos).map((r) => r.name)).toEqual(['storage']);
});
test('by session: a file touched by two sessions appears in both; unknown origin last', () => {
  const g = groupBySession(buildRows(repos, attrs));
  expect(g.map((x) => [x.title, x.rows.map((r) => r.rel)])).toEqual([
    ['Interlocutori', ['src/App.tsx']], ['Cache', ['src/App.tsx', 'serve.json']], ['Solleciti', ['job.ts']], ['Unknown origin', ['package-lock.json']]
  ]);
});
test('overlap warnings: one per group of sessions, every file of that group, every name', () => {
  const r = [repo('ui', [{ rel: 'a.ts' }, { rel: 'b.ts' }, { rel: 'c.ts' }, { rel: 'd.ts' }])];
  const a = [at('/p/ui/a.ts', 't1', 'Alfa'), at('/p/ui/a.ts', 't2', 'Beta'), at('/p/ui/b.ts', 't2', 'Beta'), at('/p/ui/b.ts', 't1', 'Alfa'),
    at('/p/ui/c.ts', 't1', 'Alfa'), at('/p/ui/c.ts', 't2', 'Beta'), at('/p/ui/c.ts', 't3', 'Gamma'), at('/p/ui/d.ts', 't1', 'Alfa')];
  const groups = overlapGroups(buildRows(r, a), ['t1', 't2', 't3']);
  expect(groups.map((g) => [g.by.map((b) => b.title), g.rows.map((x) => x.rel)])).toEqual([
    [['Alfa', 'Beta'], ['a.ts', 'b.ts']],
    [['Alfa', 'Beta', 'Gamma'], ['c.ts']]
  ]);
  expect(touchedBy(['Alfa', 'Beta'])).toBe('Alfa and Beta both touched');
  expect(touchedBy(['Alfa', 'Beta', 'Gamma'])).toBe('Alfa, Beta and Gamma all touched');
  expect(fileList(['x/a.ts', 'x/b.ts', 'x/c.ts', 'x/d.ts', 'x/e.ts'])).toBe('x/a.ts, x/b.ts, x/c.ts and 2 more');
  expect(fileList(['x/a.ts'])).toBe('x/a.ts');
});
test('same-file chips: the file name alone, with as much of its folder as tells two of the same name apart', () => {
  expect(clashChipLabels(['report-worker/CLAUDE.md', 'report-worker/src/flows/chat.flow.ts', 'report-worker/src/services/chat/agent/prompt.ts']))
    .toEqual(['CLAUDE.md', 'chat.flow.ts', 'prompt.ts']);
  expect(clashChipLabels(['src/agent/index.ts', 'src/flows/index.ts', 'a.ts'])).toEqual(['agent/index.ts', 'flows/index.ts', 'a.ts']);
  // Equal up to a deeper folder: that folder too.
  expect(clashChipLabels(['x/lib/index.ts', 'y/lib/index.ts', 'lib/main.ts'])).toEqual(['x/lib/index.ts', 'y/lib/index.ts', 'main.ts']);
  // The same path in two repos: the whole path (the tooltip names the repo).
  expect(clashChipLabels(['src/a.ts', 'src/a.ts'])).toEqual(['src/a.ts', 'src/a.ts']);
});
test('same-file chips: up to five files all show, more show four and "+N more"', () => {
  expect([1, 4, 5, 6, 9].map(clashChipsShown)).toEqual([1, 4, 5, 4, 4]);
  expect(t.clash.more(2)).toBe('+2 more');
  expect(t.clash.title(1)).toBe('on the same file');
  expect(t.clash.title(6)).toBe('on the same 6 files');
  expect(t.clash.fileTip('report-worker/src/prompt.ts')).toBe('report-worker/src/prompt.ts\nClick to open the diff');
});
test('a same-file avatar\'s tooltip: the title, then its state and where it works, then what a click does', () => {
  expect(clashSessionTip('Alfa', 'waiting', 'app-backend · dev')).toBe('Alfa\nwaiting for you · app-backend · dev\nClick to go to this session');
  expect(clashSessionTip('Alfa', 'running', null)).toBe('Alfa\nworking\nClick to go to this session');
  expect(clashSessionTip('Alfa', 'starting', null)).toBe('Alfa\nStarting…\nClick to go to this session');
  // Paused at a usage limit: never "error".
  expect(clashSessionTip('Alfa', 'paused', null)).toBe('Alfa\nUsage limit\nClick to go to this session');
  // No longer open: nothing to go to.
  expect(clashSessionTip('Alfa', null, null)).toBe('Alfa\nClosed');
});
test('overlap warnings name the sessions in the order they were opened, not in the order of their last edit', () => {
  const r = [repo('ui', [{ rel: 'a.ts' }, { rel: 'b.ts' }])];
  // Beta's edit landed first (or in the same millisecond, ahead of Alfa's): the warning still reads "Alfa and Beta".
  const a = [{ ...at('/p/ui/a.ts', 't2', 'Beta'), at: 5 }, { ...at('/p/ui/a.ts', 't1', 'Alfa'), at: 5 },
    { ...at('/p/ui/b.ts', 't2', 'Beta'), at: 1 }, { ...at('/p/ui/b.ts', 't1', 'Alfa'), at: 9 }];
  const names = (order: string[]) => overlapGroups(buildRows(r, a), order).map((g) => g.by.map((b) => b.title));
  expect(names(['t1', 't2'])).toEqual([['Alfa', 'Beta']]);
  // It follows the given order (not the alphabet), and a later edit never reshuffles it.
  expect(names(['t2', 't1'])).toEqual([['Beta', 'Alfa']]);
  expect(overlapGroups(buildRows(r, [...a, { ...at('/p/ui/a.ts', 't1', 'Alfa'), at: 99 }]), ['t2', 't1']).map((g) => g.by.map((b) => b.title))).toEqual([['Beta', 'Alfa']]);
  // A session no longer open goes after the open ones, by name, then id: never by arrival order.
  const closed = [at('/p/ui/a.ts', 't9', 'Zeta'), at('/p/ui/a.ts', 't8', 'Gamma'), at('/p/ui/a.ts', 't1', 'Alfa')];
  expect(overlapGroups(buildRows(r, closed), ['t1']).map((g) => g.by.map((b) => b.title))).toEqual([['Alfa', 'Gamma', 'Zeta']]);
});
test('session order: the open sessions by creation time, then id; equal lists give the same key', () => {
  const terms = [{ id: 'b', createdAt: 2 }, { id: 'c', createdAt: 1 }, { id: 'a', createdAt: 2 }];
  expect(sessionOrderKey(terms).split('\n')).toEqual(['c', 'a', 'b']);
  expect(sessionOrderKey([...terms].reverse())).toBe(sessionOrderKey(terms));
  expect(inSessionOrder([{ terminalId: 'b', color: '', title: 'B' }, { terminalId: 'c', color: '', title: 'C' }, { terminalId: 'b', color: '', title: 'B' }], ['c', 'a', 'b']).map((b) => b.title)).toEqual(['C', 'B']);
});
test('sovrapposizioni', () => {
  expect(overlaps(buildRows(repos, attrs)).map((r) => r.rel)).toEqual(['src/App.tsx']);
});

test('a Bash attribution keeps its marker in the row, for the "(via Bash)" tooltip', () => {
  const rows = buildRows(repos, [{ ...at('/p/app-ui/serve.json', 't2', 'Cache'), via: 'bash' }, at('/p/app-ui/src/App.tsx', 't1', 'Interlocutori')]);
  expect(rows.find((r) => r.rel === 'serve.json')!.by).toEqual([{ terminalId: 't2', color: '#t2', title: 'Cache', via: 'bash' }]);
  expect(rows.find((r) => r.rel === 'src/App.tsx')!.by).toEqual([{ terminalId: 't1', color: '#t1', title: 'Interlocutori' }]);
  expect(originTip(rows.find((r) => r.rel === 'serve.json')!.by[0]!)).toBe('Cache (via Bash)');
  expect(originTip(rows.find((r) => r.rel === 'src/App.tsx')!.by[0]!)).toBe('Interlocutori');
});

const atx = (path: string, terminalId: string, title: string, over: Partial<Attribution> = {}): Attribution =>
  ({ path, terminalId, sessionId: `s-${terminalId}`, color: `#${terminalId}`, title, at: 1, ...over });
const rp = (paths: string[]) => ({ root: '/p', changes: paths.map((path) => ({ path, rel: path.slice(3), kind: 'M' as const, stage: 'none' as const, added: 1, removed: 0 })) });

describe('unclear attributions', () => {
  const list = [
    atx('/p/a.ts', 'tB', 'Beta', { via: 'bash', unclear: ['tA', 'tB'] }),
    atx('/p/a.ts', 'tA', 'Alfa', { via: 'bash', unclear: ['tA', 'tB'] }),
    atx('/p/b.ts', 'tA', 'Alfa', { via: 'tool', tool: 'mcp__fs__write_file' })
  ];
  test('rows carry the candidates\' names, sorted; dots are dashed; tooltips say who and why', () => {
    const rows = buildRows([rp(['/p/a.ts', '/p/b.ts'])], list);
    const a = rows.find((r) => r.path === '/p/a.ts')!;
    expect(a.by.map((b) => b.unclear)).toEqual([['Alfa', 'Beta'], ['Alfa', 'Beta']]);
    expect(dotProps(a.by[0]!)).toEqual({ className: 'dot unclear id-ink', style: { '--id': '#tB' } });
    expect(originTip(a.by[0]!)).toBe('Alfa or Beta: both had a command or tool running when it changed');
    const b = rows.find((r) => r.path === '/p/b.ts')!;
    expect(originTip(b.by[0]!)).toBe('Alfa (via fs · write_file)');
    expect(dotProps(b.by[0]!).className).toBe('dot via-bash id-ink');
    // a tool attribution without a tool name falls back to the plain name
    expect(originTip({ terminalId: 'x', color: '#x', title: 'Alfa', via: 'tool' })).toBe('Alfa');
  });
  test('three candidates, and a candidate whose entry is gone', () => {
    expect(t.unclearTip(['Alfa', 'Beta', 'Gamma'])).toBe('Alfa, Beta or Gamma: all had a command or tool running when it changed');
    expect(t.unclearTip(['Alfa'])).toBe('Alfa or another session: both had a command or tool running when it changed');
  });
  test('listed under every candidate in By session, in its Maybe sub-group; never an overlap warning', () => {
    const rows = buildRows([rp(['/p/a.ts'])], list);
    expect(groupBySession(rows).map((g) => [g.title, g.rows.map((r) => r.path), g.maybe.map((r) => r.path)])).toEqual([['Beta', [], ['/p/a.ts']], ['Alfa', [], ['/p/a.ts']]]);
    expect(overlaps(rows)).toEqual([]);
    expect(overlapGroups(rows, ['tA', 'tB'])).toEqual([]);
  });
  test('an exact attribution next to an unclear one warns only when two sessions really touched the file', () => {
    const rows = buildRows([rp(['/p/a.ts'])], [atx('/p/a.ts', 'tA', 'Alfa'), atx('/p/a.ts', 'tB', 'Beta', { unclear: ['tB', 'tC'] })]);
    expect(overlaps(rows)).toEqual([]);
  });
  test('the Review chip names only sessions that surely touched the file, in session order', () => {
    const row = (over: Attribution[]) => buildRows([rp(['/p/a.ts'])], over)[0]!;
    expect(clashNames(row([atx('/p/a.ts', 'tA', 'Alfa', { unclear: ['tA', 'tB'] }), atx('/p/a.ts', 'tB', 'Beta', { unclear: ['tA', 'tB'] })]), ['tA', 'tB'])).toEqual([]);
    expect(clashNames(row([atx('/p/a.ts', 'tA', 'Alfa'), atx('/p/a.ts', 'tB', 'Beta')]), ['tB', 'tA'])).toEqual(['Beta', 'Alfa']);
    expect(clashNames(row([atx('/p/a.ts', 'tA', 'Alfa'), atx('/p/a.ts', 'tB', 'Beta', { unclear: ['tB', 'tC'] })]), ['tA', 'tB'])).toEqual([]);
  });
});

describe('maybe attributions (a background command alone)', () => {
  const maybe = atx('/p/a.ts', 'tB', 'Beta', { via: 'bash', maybe: true });
  test('the row keeps the marker; the dot is dashed; the tooltip says it may be outside Claude', () => {
    const row = buildRows([rp(['/p/a.ts'])], [maybe])[0]!;
    expect(row.by).toEqual([{ terminalId: 'tB', color: '#tB', title: 'Beta', via: 'bash', maybe: true, ids: ['tB'], at: 1 }]);
    expect(dotProps(row.by[0]!)).toEqual({ className: 'dot unclear id-ink', style: { '--id': '#tB' } });
    expect(originTip(row.by[0]!)).toBe('Beta\'s background command, or a change made outside Claude');
    expect(t.maybeTip('Alfa')).toBe('Alfa\'s background command, or a change made outside Claude');
  });
  test('listed under its session in By session (in Maybe); never an overlap warning or a Review clash', () => {
    const rows = buildRows([rp(['/p/a.ts'])], [atx('/p/a.ts', 'tA', 'Alfa'), maybe]);
    expect(groupBySession(rows).map((g) => [g.title, g.rows.map((r) => r.path), g.maybe.map((r) => r.path)])).toEqual([['Alfa', ['/p/a.ts'], []], ['Beta', [], ['/p/a.ts']]]);
    expect(overlaps(rows)).toEqual([]);
    expect(overlapGroups(rows, ['tA', 'tB'])).toEqual([]);
    expect(clashNames(rows[0]!, ['tA', 'tB'])).toEqual([]);
  });
});

describe('unsure files: the chip, the details, resolving (spec unsure attribution UX)', () => {
  const call = { changedAt: 1_002_000, command: 'npm test', callStart: 1_001_000 };
  const list = [
    atx('/p/a.ts', 'tB', 'Beta', { via: 'bash', unclear: ['tA', 'tB'], at: 7, ...call }),
    atx('/p/a.ts', 'tA', 'Alfa', { via: 'bash', unclear: ['tA', 'tB'], at: 7, changedAt: 1_002_000, command: 'git merge wt', callStart: 1_001_500, callEnd: 1_002_500 }),
    atx('/p/b.ts', 'tA', 'Alfa', { via: 'bash', unclear: ['tA', 'tB'], at: 7 }),
    atx('/p/b.ts', 'tB', 'Beta', { via: 'bash', unclear: ['tA', 'tB'], at: 7 }),
    atx('/p/c.ts', 'tA', 'Alfa', { via: 'bash', unclear: ['tA', 'tB'], at: 9 }),
    atx('/p/c.ts', 'tB', 'Beta', { via: 'bash', unclear: ['tA', 'tB'], at: 9 }),
    atx('/p/d.ts', 'tA', 'Alfa', { via: 'bash', unclear: ['tA', 'tC'], at: 7 }),
    atx('/p/d.ts', 'tC', 'Gamma', { via: 'bash', unclear: ['tA', 'tC'], at: 7 }),
    atx('/p/e.ts', 'tA', 'Alfa', { via: 'bash', resolved: true }),
    atx('/p/f.ts', 'tB', 'Beta', { via: 'bash', maybe: true, at: 7 })
  ];
  const rows = buildRows([rp(['/p/a.ts', '/p/b.ts', '/p/c.ts', '/p/d.ts', '/p/e.ts', '/p/f.ts'])], list);
  const row = (p: string) => rows.find((r) => r.path === p)!;

  test('unsure entries carry what "Why unsure" shows: candidates\' ids, the status time and the call', () => {
    expect(row('/p/a.ts').by).toEqual([
      { terminalId: 'tB', color: '#tB', title: 'Beta', via: 'bash', unclear: ['Alfa', 'Beta'], ids: ['tA', 'tB'], at: 7, ...call },
      { terminalId: 'tA', color: '#tA', title: 'Alfa', via: 'bash', unclear: ['Alfa', 'Beta'], ids: ['tA', 'tB'], at: 7, changedAt: 1_002_000, command: 'git merge wt', callStart: 1_001_500, callEnd: 1_002_500 }
    ]);
    expect(unsureOf(row('/p/a.ts')).map((b) => b.title)).toEqual(['Beta', 'Alfa']);
    expect(unsureOf(row('/p/e.ts'))).toEqual([]);
  });

  test('the chip: the candidates in session order, the tooltip says why and that a click explains', () => {
    expect(chipOf(row('/p/a.ts'), ['tA', 'tB'])).toEqual({ colors: ['#tA', '#tB'], tip: 'Alfa or Beta: both had a command or tool running when it changed. Click to see why.' });
    expect(chipOf(row('/p/f.ts'), [])).toEqual({ colors: ['#tB'], tip: 'Beta\'s background command, or a change made outside Claude. Click to see why.' });
    expect(chipOf(row('/p/e.ts'), [])).toBeNull();
  });

  test('a resolved entry is sure: a ring with the person mark, "you said so", in the session\'s own files', () => {
    const e = row('/p/e.ts').by[0]!;
    expect(e.resolved).toBe(true);
    expect(dotProps(e).className).toBe('dot via-bash is-resolved id-ink');
    expect(originTip(e)).toBe('Alfa (you said so)');
    const alfa = groupBySession(rows).find((g) => g.title === 'Alfa')!;
    expect(alfa.rows.map((r) => r.path)).toEqual(['/p/e.ts']);
    expect(alfa.maybe.map((r) => r.path)).toEqual(['/p/a.ts', '/p/b.ts', '/p/c.ts', '/p/d.ts']);
  });

  test('same moment: same candidates and same status read', () => {
    expect(sameMoment(rows, row('/p/a.ts')).map((r) => r.path)).toEqual(['/p/b.ts']);
    expect(sameMoment(rows, row('/p/c.ts'))).toEqual([]);
    expect(sameMoment(rows, row('/p/d.ts'))).toEqual([]);
    expect(sameMoment(rows, row('/p/e.ts'))).toEqual([]);
  });

  test('strings', () => {
    expect(t.unsure.given(4, 'Beta')).toBe('4 files given to Beta');
    expect(t.unsure.given(1, 'Beta')).toBe('1 file given to Beta');
    expect(t.unsure.outside(2)).toBe('2 files marked as changed outside Claude');
    expect(t.unsure.changedAt(['13:52:07'], 2, false)).toBe('It changed at 13:52:07 while 2 sessions were running a command.');
    expect(t.unsure.changedAt(['13:01:02', '13:05:10'], 3, false)).toBe('It changed 2 times (13:01:02, 13:05:10) while 3 sessions were running a command.');
    expect(t.unsure.changedAt([], 1, true)).toBe('It changed while only a background command was running.');
  });

  test('the folder each candidate ran from carries through to the row', () => {
    const r = buildRows([rp(['/p/a.ts'])], [atx('/p/a.ts', 'tA', 'Alfa', { via: 'bash', unclear: ['tA', 'tB'], cwd: '/p/wt' }), atx('/p/a.ts', 'tB', 'Beta', { via: 'bash', unclear: ['tA', 'tB'] })])[0]!;
    expect(r.by.map((b) => b.cwd)).toEqual(['/p/wt', undefined]);
  });
});

describe('Why unsure: where a call ran, the change times, a session\'s location rows', () => {
  const tree = (root: string) => ({ root }) as RepoStatus;
  const repos = [tree('/p'), tree('/p/.claude/worktrees/website')];
  test('the call\'s folder: in the file\'s own checkout, or where it was (relative to the project when inside it)', () => {
    expect(whereRan('/p/src', '/p', repos, '/p')).toEqual({ same: true, label: 'in this checkout' });
    expect(whereRan('/p/.claude/worktrees/website', '/p', repos, '/p')).toEqual({ same: false, label: 'from .claude/worktrees/website' });
    expect(whereRan('/p/.claude/worktrees/website/src', '/p/.claude/worktrees/website', repos, '/p')).toEqual({ same: true, label: 'in this checkout' });
    expect(whereRan('/elsewhere/x', '/p', repos, '/p')).toEqual({ same: false, label: 'from /elsewhere/x' });
    expect(whereRan(undefined, '/p', repos, '/p')).toBeNull();
    // The project folder itself, holding the repo in a subfolder.
    expect(whereRan('/p', '/p/app', [tree('/p/app')], '/p')).toEqual({ same: false, label: 'from the project folder' });
    // No project root known: the absolute path, never one cut at the first character.
    expect(whereRan('/x/y', '/p', repos, '')).toEqual({ same: false, label: 'from /x/y' });
  });
  test('who was running: every candidate of every moment, background only when all entries are maybes', () => {
    const by = (over: Partial<ChangeBy>): ChangeBy => ({ terminalId: 'x', color: '', title: '', ...over });
    // Alfa's leftover unclear entry (Beta's became sure later): two sessions were running, not a background command.
    expect(runningAt([by({ terminalId: 'tA', unclear: ['Alfa', 'Beta'], ids: ['tA', 'tB'] })])).toEqual({ sessions: 2, background: false });
    expect(runningAt([by({ terminalId: 'tA', maybe: true, ids: ['tA'] }), by({ terminalId: 'tB', maybe: true, ids: ['tB'] })])).toEqual({ sessions: 2, background: true });
    expect(runningAt([by({ terminalId: 'tA', maybe: true, ids: ['tA'] })])).toEqual({ sessions: 1, background: true });
    expect(t.unsure.changedAt(['13:00:00'], 2, true)).toBe('It changed at 13:00:00 while only background commands were running.');
    expect(t.unsure.changedAt(['13:00:00'], 1, true)).toBe('It changed at 13:00:00 while only a background command was running.');
    expect(t.unsure.changedAt(['13:00:00'], 2, false)).toBe('It changed at 13:00:00 while 2 sessions were running a command.');
  });
  test('change times: distinct, in order, unknown ones left out', () => {
    const b = (changedAt?: number): ChangeBy => ({ terminalId: 'x', color: '', title: '', ...(changedAt !== undefined ? { changedAt } : {}) });
    expect(changeTimes([b(5), b(5)])).toEqual([5]);
    expect(changeTimes([b(9), b(5), b()])).toEqual([5, 9]);
    expect(changeTimes([b()])).toEqual([]);
  });
  test('where a session works is read from its sure files, else from its unsure ones', () => {
    const r = (path: string) => ({ path }) as ChangeRow;
    expect(locationRows({ rows: [r('/a')], maybe: [r('/b')] }).map((x) => x.path)).toEqual(['/a']);
    expect(locationRows({ rows: [], maybe: [r('/b')] }).map((x) => x.path)).toEqual(['/b']);
  });
});

// A repository git refuses (another user's: safe.directory) read as "1 repo clean", branch "—": it gets its own row
// saying why, and the clean state counts only the ones git could read.
test('a repository git can’t read is never clean: listed apart, left out of the clean ones', () => {
  const bad: RepoStatus = { ...repo('shop', []), branch: null, oid: null, error: "git status: fatal: detected dubious ownership in repository at '/p/shop'" };
  const all = [repo('storage', []), bad];
  expect(unreadableRepos(all).map((r) => r.name)).toEqual(['shop']);
  expect(cleanRepos(all).map((r) => r.name)).toEqual(['storage']);
  expect(unreadableRepos([repo('storage', [])])).toEqual([]);
  // Any other read failure (a timeout under load, a repo mid-gc) passes with the next read: no alarm row in Changes for
  // it (Source Control shows the error), and it is not counted as clean either.
  const slow: RepoStatus = { ...repo('api', []), branch: null, oid: null, error: 'git status: timed out' };
  expect(unreadableRepos([slow, bad]).map((r) => r.name)).toEqual(['shop']);
  expect(cleanRepos([slow])).toEqual([]);
});

describe('capShown: a dozen repositories, then a count', () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  test('the first ones in their order, the rest counted', () => {
    expect(CHANGES_CAP).toBe(12);
    expect(capShown(items, 12, () => false)).toEqual({ shown: items.slice(0, 12), more: 8 });
  });
  test('one past the cap that must show (a live session in it) shows too, in its place', () => {
    expect(capShown(items, 12, (x) => x === 17)).toEqual({ shown: [...items.slice(0, 12), 17], more: 7 });
  });
  test('a dozen or fewer: all of them, nothing counted', () => {
    expect(capShown(items.slice(0, 12), 12, () => false)).toEqual({ shown: items.slice(0, 12), more: 0 });
    expect(capShown([], 12, () => false)).toEqual({ shown: [], more: 0 });
  });
});

describe('sessionRoots', () => {
  test('the deepest repository each session works in; terminals without a session count for nothing', () => {
    const roots = ['/p/hub', '/p/hub/guides', '/p/api'];
    const terminals = [
      { cwd: '/p/hub/guides/src', session: {} },
      { cwd: '/p/api', session: {} },
      { cwd: '/p/hub', session: null },
      { cwd: '/elsewhere', session: {} }
    ];
    expect(sessionRoots(roots, terminals as never)).toEqual(new Set(['/p/hub/guides', '/p/api']));
  });
});
