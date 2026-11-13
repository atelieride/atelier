import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Sidebar rows dragged into your own order: pinned among the pinned, unpinned among the unpinned, sessions and
// terminals; a caret shows where the row lands and nothing else moves.

async function launch(): Promise<{ app: ElectronApplication; win: Page; home: string }> {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  return { app, win: await app.firstWindow(), home };
}

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

async function newSession(win: Page, name: string) {
  await win.locator('.btn-new').click();
  await win.getByRole('menuitem', { name: 'Claude Session' }).click();
  await win.getByPlaceholder('Session name (optional)').fill(name);
  await win.keyboard.press('Enter');
  await expect(win.locator('.session-row', { hasText: name })).toBeVisible({ timeout: 15000 });
}

async function newTerminal(win: Page, count: number) {
  await win.keyboard.press('F1');
  await win.locator('.palette-input').fill('>new terminal');
  await win.locator('.palette-item', { has: win.locator('.palette-label', { hasText: /^New terminal$/ }) }).click();
  await expect(win.locator('.term-row')).toHaveCount(count, { timeout: 10000 });
}

const titles = (win: Page) => win.locator('.session-row .session-title').allTextContents();
const termIds = (win: Page) => win.locator('.term-row').evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.termRow ?? ''));

/** Drops `from` on the upper edge of `onto` (it lands before it), with the system drag as a person does. */
async function dropAbove(from: Locator, onto: Locator) {
  await from.dragTo(onto, { targetPosition: { x: 40, y: 4 } });
}

async function pin(win: Page, row: Locator) {
  await row.click({ button: 'right' });
  await win.getByRole('menuitem', { name: 'Pin', exact: true }).click();
}

test('sessions: a row dropped above another stays there after a reload; a caret shows where it lands', async () => {
  const { app, win, home } = await launch();
  try {
    const row = (name: string) => win.locator('.session-row', { hasText: name });
    // The flat list: grouping by state is on by default.
    await win.getByRole('button', { name: 'Group by state' }).click();
    for (const name of ['Alfa', 'Beta', 'Gamma']) await newSession(win, name);
    expect(await titles(win)).toEqual(['Alfa', 'Beta', 'Gamma']);

    await dropAbove(row('Gamma'), row('Alfa'));
    await expect.poll(() => titles(win)).toEqual(['Gamma', 'Alfa', 'Beta']);
    await win.reload();
    await expect(win.locator('.session-row')).toHaveCount(3, { timeout: 15000 });
    await expect.poll(() => titles(win)).toEqual(['Gamma', 'Alfa', 'Beta']);

    // While dragging: the dragged row dims, a caret above the row it would land before; no row moves.
    const dt = await win.evaluateHandle(() => new DataTransfer());
    const boxes = async () => Promise.all(['Gamma', 'Alfa', 'Beta'].map(async (n) => (await row(n).boundingBox())!.y));
    // Measured once the rows' entrance after the reload is over (it slides them in).
    await win.locator('.sidebar').evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)).then(() => undefined));
    const before = await boxes();
    await row('Beta').dispatchEvent('dragstart', { dataTransfer: dt });
    const alfa = (await row('Alfa').boundingBox())!;
    await row('Alfa').dispatchEvent('dragover', { dataTransfer: dt, clientX: alfa.x + 40, clientY: alfa.y + 4 });
    await expect(row('Alfa')).toHaveClass(/\bis-caret-before\b/);
    await expect(row('Beta')).toHaveClass(/\bis-dragging\b/);
    // Dimmed for real, rows that entered with their entrance motion included (it holds the row's own opacity at 1).
    await expect(row('Beta').locator('.row-main')).toHaveCSS('opacity', '0.55');
    await expect(row('Alfa').locator('.row-main')).toHaveCSS('opacity', '1');
    expect(await boxes()).toEqual(before);
    await look(win.locator('.sidebar'), 'test-results/row-order-caret.png');
    // At the sidebar's narrowest the caret stays inside it, between the rows.
    const width = await win.locator('.body').evaluate((el) => (el as HTMLElement).style.getPropertyValue('--sidebar-w'));
    await win.locator('.body').evaluate((el) => (el as HTMLElement).style.setProperty('--sidebar-w', '200px'));
    await expect.poll(() => win.locator('.sidebar').evaluate((el) => el.getBoundingClientRect().width)).toBe(200);
    const caretBox = () => row('Alfa').evaluate((el) => {
      const r = el.getBoundingClientRect();
      const c = getComputedStyle(el, '::before');
      const s = el.closest('.sidebar')!.getBoundingClientRect();
      const left = r.left + parseFloat(c.left);
      return { inside: left >= s.left && left + parseFloat(c.width) <= s.right, top: c.top, height: c.height, animation: c.animationName };
    });
    // No entrance of its own: it is drawn anew on every row the pointer crosses, and a fade would shimmer.
    expect(await caretBox()).toEqual({ inside: true, top: '-2px', height: '2px', animation: 'none' });
    await look(win.locator('.sidebar'), 'test-results/row-order-caret-narrow.png');
    await win.locator('.body').evaluate((el, w) => (el as HTMLElement).style.setProperty('--sidebar-w', w), width);
    // Just above itself: it would stay put, no caret.
    const beta = (await row('Beta').boundingBox())!;
    await row('Beta').dispatchEvent('dragover', { dataTransfer: dt, clientX: beta.x + 40, clientY: beta.y + 4 });
    await expect(win.locator('.is-caret-before, .is-caret-after')).toHaveCount(0);
    await row('Beta').dispatchEvent('dragend', { dataTransfer: dt });
    await expect(win.locator('.is-caret-before, .is-caret-after, .is-dragging')).toHaveCount(0);
    expect(await titles(win)).toEqual(['Gamma', 'Alfa', 'Beta']);

    // The keyboard's way: Shift+F10 on a row, Move Up; the focus comes back to the row.
    await row('Alfa').locator('.row-main').focus();
    await win.keyboard.press('Shift+F10');
    await expect(win.getByRole('menuitem', { name: 'Move Down' })).toBeVisible();
    await win.getByRole('menuitem', { name: 'Move Up' }).click();
    await expect.poll(() => titles(win)).toEqual(['Alfa', 'Gamma', 'Beta']);
    await expect(row('Alfa').locator('.row-main')).toBeFocused();
    await win.keyboard.press('Shift+F10');
    await win.getByRole('menuitem', { name: 'Move Down' }).click();
    await expect.poll(() => titles(win)).toEqual(['Gamma', 'Alfa', 'Beta']);
    await expect(row('Alfa').locator('.row-main')).toBeFocused();
    // Dropped further down, the row keeps the keyboard focus too.
    const drag = await win.evaluateHandle(() => new DataTransfer());
    await row('Alfa').dispatchEvent('dragstart', { dataTransfer: drag });
    const below = (await row('Beta').boundingBox())!;
    const lower = { dataTransfer: drag, clientX: below.x + 40, clientY: below.y + below.height - 4 };
    await row('Beta').dispatchEvent('dragover', lower);
    await expect(row('Beta')).toHaveClass(/\bis-caret-after\b/);
    await row('Beta').dispatchEvent('drop', lower);
    await row('Alfa').dispatchEvent('dragend', { dataTransfer: drag });
    await expect.poll(() => titles(win)).toEqual(['Gamma', 'Beta', 'Alfa']);
    await expect(row('Alfa').locator('.row-main')).toBeFocused();
    await expect(win.locator('.is-caret-before, .is-caret-after, .is-dragging')).toHaveCount(0);
  } finally {
    await stop(app, home);
  }
});

test('pinned rows move only among the pinned, the others only among the others; terminals too', async () => {
  const { app, win, home } = await launch();
  try {
    const row = (name: string) => win.locator('.session-row', { hasText: name });
    await win.getByRole('button', { name: 'Group by state' }).click();
    for (const name of ['Alfa', 'Beta', 'Gamma']) await newSession(win, name);
    await pin(win, row('Beta'));
    await pin(win, row('Gamma'));
    await expect.poll(() => titles(win)).toEqual(['Beta', 'Gamma', 'Alfa']);
    // Unpinned onto a pinned row: nothing.
    await dropAbove(row('Alfa'), row('Beta'));
    expect(await titles(win)).toEqual(['Beta', 'Gamma', 'Alfa']);
    // Pinned among the pinned: the pin order changes.
    await dropAbove(row('Gamma'), row('Beta'));
    await expect.poll(() => titles(win)).toEqual(['Gamma', 'Beta', 'Alfa']);

    await newTerminal(win, 1);
    await newTerminal(win, 2);
    await newTerminal(win, 3);
    const [first, second, third] = await termIds(win);
    const term = (id: string) => win.locator(`.term-row[data-term-row="${id}"]`);
    await dropAbove(term(third!), term(first!));
    await expect.poll(() => termIds(win)).toEqual([third, first, second]);
  } finally {
    await stop(app, home);
  }
});

/** The grouped list: [section label, row titles] in order (one list, a head before each section's rows). */
const sections = (win: Page) => win.locator('.list.inbox').evaluateAll((lists) => {
  const out: [string, string[]][] = [];
  for (const el of lists[0]?.children ?? []) {
    if (el.classList.contains('inbox-head')) out.push([el.querySelector('.section-label')?.textContent ?? '', []]);
    else if (el.classList.contains('session-row')) out.at(-1)![1].push(el.querySelector('.session-title')?.textContent ?? '');
  }
  return out;
});

type Api = { terminals: { list(): Promise<{ id: string; title: string }[]>; input(id: string, data: string): void } };
/** Types into a session's prompt without selecting it (as if it answered while you look elsewhere). */
async function typeInto(win: Page, title: string, text: string) {
  await win.evaluate(async ({ title, text }) => {
    const api = (window as unknown as { atelier: Api }).atelier;
    const id = (await api.terminals.list()).find((x) => x.title === title)!.id;
    api.terminals.input(id, text);
  }, { title, text });
}

test('Idle: rows reorder there only; one that leaves Idle comes back to its place; a newcomer arrives on top', async () => {
  const { app, win, home } = await launch();
  try {
    const row = (name: string) => win.locator('.session-row', { hasText: name });
    const names = ['Alfa', 'Beta', 'Gamma', 'Delta'];
    for (const name of names) await newSession(win, name);
    // Each answers and finishes; looked at, it is idle (the order they arrived in is Idle's own). Looked at only once its
    // turn has ended: a Stop arriving after the look would make it unread again.
    for (const name of names) await typeInto(win, name, '\r');
    for (const name of names) await expect(row(name)).toHaveClass(/\bstate-done\b/, { timeout: 10000 });
    for (const name of names) await row(name).locator('.row-main').click();
    await expect.poll(async () => (await sections(win)).map(([s, rows]) => [s, rows.length]), { timeout: 10000 }).toEqual([['Idle', 4]]);
    const [s0, s1, s2, s3] = (await sections(win))[0]![1];
    await dropAbove(row(s3!), row(s0!));
    await expect.poll(() => sections(win)).toEqual([['Idle', [s3, s0, s1, s2]]]);

    // One works again (Working orders itself: no band there), finishes and is seen: back at its place in Idle.
    await typeInto(win, s1!, 'ev:work\r');
    await expect.poll(() => sections(win)).toEqual([['Working', [s1]], ['Idle', [s3, s0, s2]]]);
    await expect(row(s1!)).not.toHaveAttribute('data-band');
    await typeInto(win, s1!, 'ev:stop\r');
    await expect(row(s1!)).toHaveClass(/\bstate-done\b/, { timeout: 10000 });
    await row(s1!).locator('.row-main').click();
    await expect.poll(() => sections(win), { timeout: 10000 }).toEqual([['Idle', [s3, s0, s1, s2]]]);

    // A newcomer, never placed, arrives on top of Idle (the latest to enter first).
    await newSession(win, 'Echo');
    await typeInto(win, 'Echo', '\r');
    await expect(row('Echo')).toHaveClass(/\bstate-done\b/, { timeout: 10000 });
    await row('Echo').locator('.row-main').click();
    await expect.poll(() => sections(win), { timeout: 10000 }).toEqual([['Idle', ['Echo', s3, s0, s1, s2]]]);
  } finally {
    await stop(app, home);
  }
});

test('a row that leaves Idle mid-drag: the caret goes, the drop does nothing, and the drag still ends cleanly', async () => {
  const { app, win, home } = await launch();
  try {
    const row = (name: string) => win.locator('.session-row', { hasText: name });
    for (const name of ['Alfa', 'Beta']) await newSession(win, name);
    for (const name of ['Alfa', 'Beta']) await typeInto(win, name, '\r');
    for (const name of ['Alfa', 'Beta']) await expect(row(name)).toHaveClass(/\bstate-done\b/, { timeout: 10000 });
    for (const name of ['Alfa', 'Beta']) await row(name).locator('.row-main').click();
    await expect.poll(async () => (await sections(win)).map(([s, rows]) => [s, rows.length]), { timeout: 10000 }).toEqual([['Idle', 2]]);
    const before = (await sections(win))[0]![1];
    const [top, bottom] = before;
    const dt = await win.evaluateHandle(() => new DataTransfer());
    await row(bottom!).dispatchEvent('dragstart', { dataTransfer: dt });
    const box = (await row(top!).boundingBox())!;
    await row(top!).dispatchEvent('dragover', { dataTransfer: dt, clientX: box.x + 40, clientY: box.y + 4 });
    await expect(row(top!)).toHaveClass(/\bis-caret-before\b/);
    // It starts working: Working orders itself, so it has nothing to land among any more.
    await typeInto(win, bottom!, 'ev:work\r');
    await expect.poll(() => sections(win)).toEqual([['Working', [bottom]], ['Idle', [top]]]);
    const over = (await row(top!).boundingBox())!;
    await row(top!).dispatchEvent('dragover', { dataTransfer: dt, clientX: over.x + 40, clientY: over.y + 4 });
    await expect(win.locator('.is-caret-before, .is-caret-after')).toHaveCount(0);
    await row(top!).dispatchEvent('drop', { dataTransfer: dt, clientX: over.x + 40, clientY: over.y + 4 });
    await row(bottom!).dispatchEvent('dragend', { dataTransfer: dt });
    await expect(win.locator('.is-dragging, .is-caret-before, .is-caret-after')).toHaveCount(0);
    expect(await sections(win)).toEqual([['Working', [bottom]], ['Idle', [top]]]);
  } finally {
    await stop(app, home);
  }
});

test('a placed session whose Claude exits arrives among the terminals by age, not on top', async () => {
  const { app, win, home } = await launch();
  try {
    const row = (name: string) => win.locator('.session-row', { hasText: name });
    await win.getByRole('button', { name: 'Group by state' }).click();
    // A terminal first: by age it comes before the sessions started after it.
    await newTerminal(win, 1);
    const [shellId] = await termIds(win);
    for (const name of ['Alfa', 'Beta']) await newSession(win, name);
    await dropAbove(row('Beta'), row('Alfa'));
    await expect.poll(() => titles(win)).toEqual(['Beta', 'Alfa']);
    const betaId = await row('Beta').getAttribute('data-term-row');
    await typeInto(win, 'Beta', '\r');
    await typeInto(win, 'Beta', '/exit\r');
    await expect(win.locator('.term-row')).toHaveCount(2, { timeout: 15000 });
    await expect.poll(() => termIds(win)).toEqual([shellId, betaId]);
  } finally {
    await stop(app, home);
  }
});

/** Clicks an app menu item by its label, as the menu bar would. */
async function menu(app: ElectronApplication, label: string) {
  await app.evaluate(({ Menu, BrowserWindow }, l) => {
    const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const it of items) { if (it.label === l && it.visible) return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
      return undefined;
    };
    walk(Menu.getApplicationMenu()!.items)!.click(undefined, BrowserWindow.getAllWindows()[0]);
  }, label);
}
const menuEnabled = (app: ElectronApplication, label: string) => app.evaluate(({ Menu }, l) => {
  const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
    for (const it of items) { if (it.label === l) return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
    return undefined;
  };
  return walk(Menu.getApplicationMenu()!.items)?.enabled ?? false;
}, label);

test('inside an activity: its rows reorder there; another activity still takes a row dropped on it, with no caret', async () => {
  const { app, win, home } = await launch();
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));
    // A terminal of the workspace's own (workspaces start from what is open).
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(win.locator('.term-row')).toHaveCount(1, { timeout: 10000 });
    await menu(app, 'Toggle Workspaces for This Project');
    await expect(win.locator('.ws-group.is-active')).toContainText('Workspace 1');
    await expect.poll(() => menuEnabled(app, 'Activities Inside Workspaces')).toBe(true);
    await menu(app, 'Activities Inside Workspaces');
    const act = (name: string) => win.locator('.wsa-group', { has: win.locator('.wsa-name', { hasText: new RegExp(`^${name}$`) }) });
    for (const name of ['Reset', 'SSO']) {
      const head = win.locator('.ws-group.is-active .ws-head');
      await head.hover();
      await win.locator('.ws-group.is-active .ws-plus').click();
      await win.getByRole('menuitem', { name: 'New Activity…' }).click();
      const input = win.locator('.wsa-head .rename-input');
      await expect(input).toBeFocused();
      await input.fill(name);
      await input.press('Enter');
      await expect(act(name)).toHaveClass(/is-current/);
    }
    await act('SSO').locator('.wsa-chev').click();
    await act('Reset').locator('.wsa-chev').click();
    // Three terminals in SSO, the place in front (after the workspace's own one).
    for (const n of [2, 3, 4]) await newTerminal(win, n);
    const ssoIds = () => act('SSO').locator('.term-row').evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.termRow ?? ''));
    const [first, second, third] = await ssoIds();
    const term = (id: string) => win.locator(`.term-row[data-term-row="${id}"]`);
    await dropAbove(term(third!), term(first!));
    await expect.poll(ssoIds).toEqual([third, first, second]);

    // Over the other activity: its drop state, no caret anywhere; released there, the row moves into it.
    await term(second!).hover();
    await win.mouse.down();
    const box = (await act('Reset').locator('.wsa-head').boundingBox())!;
    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
    await expect(act('Reset')).toHaveClass(/is-drop/);
    await expect(win.locator('.is-caret-before, .is-caret-after')).toHaveCount(0);
    await win.mouse.up();
    await expect(act('Reset').locator(`.term-row[data-term-row="${second}"]`)).toBeVisible();
    // Moved, it is a row like any other there: nothing stays dimmed.
    await expect(win.locator('.is-dragging, .is-caret-before, .is-caret-after')).toHaveCount(0);
    await expect.poll(ssoIds).toEqual([third, first]);
  } finally {
    await stop(app, home);
  }
});
