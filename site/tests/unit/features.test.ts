import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { DEMO_SOURCE, DEMO_VIEWS, isPageToDemo } from '../../../src/demo/protocol';
import { bento, rows } from '../../src/content/features';
import { ACCOUNTS } from '../../../src/demo/world/accounts';

// Feature rows the live demo can show: "Try it" opens the demo on the row's
// view, a command the native menu sends (the demo's shell forwards it to the renderer as the menu would), or one of the
// demo's own views (DEMO_VIEWS, src/demo/shell/open-view.ts) when no command shows what the row promises.
const app = readFileSync(fileURLToPath(new URL('../../../src/renderer/App.tsx', import.meta.url)), 'utf8');

test('every row\'s demo view is a command the page may send and the app acts on', () => {
  const withDemo = rows.filter((r) => r.demo);
  expect(withDemo.length).toBeGreaterThan(0);
  for (const r of withDemo) {
    const view = r.demo!.view;
    expect(isPageToDemo({ source: DEMO_SOURCE, type: 'open', view }), r.id).toBe(true);
    if (view.startsWith('demo:')) expect(DEMO_VIEWS, r.id).toContain(view);
    else {
      // A command with an argument (`new-session-account:work`) is handled by its prefix.
      const prefix = view.includes(':') ? view.slice(0, view.indexOf(':') + 1) : null;
      const handled = prefix ? app.includes(`cmd.startsWith('${prefix}')`) : app.includes(`case '${view}':`);
      expect(handled, `${r.id}: App.tsx handles ${view}`).toBe(true);
    }
  }
});

test('views show what the row is about, and never toggle (opening twice must not hide it)', () => {
  const views = Object.fromEntries(rows.flatMap((r) => (r.demo ? [[r.id, r.demo.view]] : [])));
  expect(views).toEqual({
    sessions: 'view-sessions', ask: 'demo:ask', workspace: 'split-right', background: 'show-background', docker: 'view-docker',
    redis: 'view-redis', databases: 'view-databases', changes: 'review-all', automations: 'view-automations', editor: 'demo:editor',
    accounts: 'new-session-account:work'
  });
  for (const v of Object.values(views)) expect(v, v).not.toMatch(/^toggle-|^md-toggle/);
});

test('always alive: closing a session to free memory can leave it under Resume (app setting)', () => {
  const row = rows.find((r) => r.id === 'alive')!;
  expect(row.bullets).toHaveLength(3);
  expect(row.bullets.join(' ')).toMatch(/close to free memory/i);
  expect(row.bullets.join(' ')).toMatch(/one click/i);
});

test('rows the demo cannot show have no "Try it": dictation (not in the demo), always alive (nothing to play)', () => {
  for (const id of ['dictation', 'alive']) expect(rows.find((r) => r.id === id)!.demo, id).toBeUndefined();
});

test('the Claude accounts row: its shot, Try it opens New Session on Work (an account of the demo\'s world)', () => {
  const row = rows.find((r) => r.id === 'accounts')!;
  expect(row.shot).toBe('accounts');
  expect(rows.map((r) => r.id).slice(-2)).toEqual(['accounts', 'alive']);
  expect(ACCOUNTS.map((a) => a.id)).toContain(row.demo!.view.slice('new-session-account:'.length));
});

test('the Workspace row says lines of work go in workspaces and the activities inside them', () => {
  const row = rows.find((r) => r.id === 'workspace')!;
  expect(row.text).toMatch(/workspaces/);
  expect(row.text).toMatch(/activities inside them/);
  expect(row.bullets).toHaveLength(3);
});

test('the Ask row: right after Sessions, its shot, Try it opens Ask on a session at work; its copy claims only what Ask does', () => {
  const ids = rows.map((r) => r.id);
  expect(ids.indexOf('ask')).toBe(ids.indexOf('sessions') + 1);
  const row = rows.find((r) => r.id === 'ask')!;
  expect(row.shot).toBe('ask');
  expect(row.demo).toEqual({ view: 'demo:ask' });
  const copy = [row.title, row.text, ...row.bullets].join(' ');
  // Read-only by construction (three read tools, restricted, dontAsk); it runs on the user's own Claude account.
  expect(copy).toMatch(/read-only/i);
  expect(copy).toMatch(/never edits files, runs commands or interrupts the session/);
  expect(copy).toMatch(/your Claude account/);
  // Only answers about where a session is carry a verdict (rules.ts): the copy never says every answer does.
  expect(copy).not.toMatch(/answers with a verdict/i);
  expect(copy).toMatch(/a verdict on how far it got/);
  // Ask runs on macOS and Windows (Ctrl+Shift+I there): like the other rows, this one names no platform.
  expect(copy).not.toMatch(/\b(windows|mac|macos|every platform)\b/i);
  expect(row.shortcut).toBe('⌘I  Ask About This Session');
});

test('the Databases row: after Redis, its shot, Try it opens the view; its copy says read-only', () => {
  const ids = rows.map((r) => r.id);
  expect(ids.indexOf('databases')).toBe(ids.indexOf('redis') + 1);
  const row = rows.find((r) => r.id === 'databases')!;
  expect([row.eyebrow, row.title]).toEqual(['Databases', 'Your Postgres, read-only and readable.']);
  expect(row.shot).toBe('databases');
  expect(row.demo).toEqual({ view: 'view-databases' });
  expect(row.text).toMatch(/Every query runs in a read-only transaction\.$/);
  expect(row.shortcut).toBe('⌃⇧B  Databases');
  // The view never writes: no bullet promises an edit, an insert or SQL typed by the user (v2).
  expect([row.text, ...row.bullets].join(' ')).not.toMatch(/\b(edit|insert|delete|run your SQL|write)\b/i);
});

test('the Automations row: after Changes, its shot, Try it opens the view on the world\'s rules', () => {
  const ids = rows.map((r) => r.id);
  expect(ids.indexOf('automations')).toBe(ids.indexOf('changes') + 1);
  const row = rows.find((r) => r.id === 'automations')!;
  expect(row.shot).toBe('automations');
  expect(row.demo).toEqual({ view: 'view-automations' });
  // Its copy says what the guard promises, and nothing more.
  expect(row.bullets.join(' ')).toMatch(/never merges or pushes/i);
});

test('optional views say where they are turned on: Services and Automations start off in the app (2026-11-02)', () => {
  const services = bento.find((b) => b.title === 'Service logs')!;
  expect(services.text).toMatch(/turn (it|them) on in Settings/i);
  const automations = rows.find((r) => r.id === 'automations')!;
  expect(automations.text).toMatch(/turn (it|them) on in Settings/i);
});

// The six-block home: tiles, the "your Mac" strip and the questions are data
// here, like the rows, so the home, /features, the search and llms.txt never drift apart.
test('tiles: the eight of the home, in order, each a row with a focus point on its shot', async () => {
  const { tiles } = await import('../../src/content/features');
  expect(tiles.map((t) => t.id)).toEqual(['editor', 'changes', 'workspace', 'docker', 'redis', 'databases', 'automations', 'dictation']);
  expect(tiles.map((t) => t.title)).toEqual(['Editor', 'Changes and review', 'Split view', 'Docker', 'Redis', 'Databases', 'Automations', 'Dictation']);
  for (const t of tiles) {
    expect(rows.map((r) => r.id), t.id).toContain(t.id);
    expect(t.focus, t.id).toMatch(/^\d{1,3}% \d{1,3}%$/);
    expect(t.text, t.id).toMatch(/\.$/);
  }
  expect(tiles.find((t) => t.id === 'docker')!.text).toBe('Logs and why a container stopped. Read-only.');
  expect(tiles.find((t) => t.id === 'dictation')!.text).toBe('Hold ⌥Space and talk. Transcribed on your computer.');
});

test('your Mac: four cells, the accounts one never counting them', async () => {
  const { yourMac } = await import('../../src/content/features');
  expect(yourMac.map((c) => [c.title, c.mono])).toEqual([
    ['The real CLI', 'claude'],
    ['All your Claude accounts', 'personal · work · …'],
    ['Sessions stay alive', 'atelierd'],
    ['Nothing about your work', 'no account']
  ]);
  expect(yourMac[1]!.text).toBe('Add as many as you have. Pick one for each session, its limits in view.');
  // Update checks do reach useatelier.dev (privacy page): the cell says what they carry, never "nothing is sent".
  expect(yourMac[3]!.text).toBe('No account, no tracking. Update checks carry the app version, never your projects.');
});

test('questions: five, links as data (GitHub, support, privacy); the first says it is open source', async () => {
  const { faq } = await import('../../src/content/features');
  expect(faq.map((f) => f.q)).toEqual(['Is it free?', 'Does it use my Claude subscription?', 'What happens when I quit or update?', 'Does my code leave my computer?', 'Which systems does it run on?']);
  const links = (i: number) => faq[i]!.a.flatMap((p) => (typeof p === 'string' ? [] : [p]));
  expect(links(0)).toEqual([{ text: 'on GitHub', href: 'https://github.com/atelieride/atelier' }, { text: 'support it', href: '/support' }]);
  expect(faq[0]!.a[0]).toMatch(/^Yes, and open source under the MIT license/);
  expect(links(3)).toEqual([{ text: 'privacy page', href: '/privacy' }]);
  for (const f of faq) for (const p of f.a) expect(typeof p === 'string' ? p : p.text).not.toMatch(/</);
});

test('every row\'s shortcut is the label beside its title (the callouts\' brand text): the key, two spaces, what it does', () => {
  expect(Object.fromEntries(rows.map((r) => [r.id, r.shortcut]))).toEqual({
    sessions: '⌘J  next waiting', ask: '⌘I  Ask About This Session', workspace: '⌘\\  split', background: '⌘⌥B  Background',
    scheduled: '⌘⌥⏎  Schedule Prompt', docker: '⌥↵  send to the session', redis: '⌃⇧R  Redis', databases: '⌃⇧B  Databases',
    changes: '⌥⌘M  message by Claude', automations: '⌘⇧A  Automations', editor: '⌘L  @session.ts#L11-17',
    dictation: '⌥Space  hold to talk', accounts: '⇥  switch account', alive: undefined
  });
  for (const r of rows) if (r.shortcut !== undefined) expect(r.shortcut, r.id).toMatch(/^\S+ {2}\S/);
});

test('Claude accounts are never counted: Atelier has no limit (the accounts row is "All your Claude accounts")', async () => {
  const content = await import('../../src/content/features');
  expect(rows.find((r) => r.id === 'accounts')!.title).toBe('All your Claude accounts, side by side.');
  // Alts describe the picture, and the accounts shot does show two of them: only the copy is checked.
  const copy = JSON.stringify([content.rows.map(({ alt: _, ...r }) => r), content.bento, content.keys, content.tiles, content.yourMac, content.faq]);
  expect(copy).not.toMatch(/\b(2|two) (Claude )?accounts\b/i);
  expect(copy).not.toMatch(/\bpersonal and work\b/i);
});
