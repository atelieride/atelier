// Narrow layouts: a sidebar crowded on purpose — sessions with every chip,
// terminals with many ports — staged by sending the window the lists main would send (ev:terminals, ev:ports), so a
// test can look at every width without real servers, background work or accounts. Nothing here talks to atelierd: the
// rows are only drawn (selecting one attaches to nothing), which is all a layout test needs.
import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import type { TerminalInfo } from '../../src/shared/protocol';
import type { BackgroundWork } from '../../src/shared/background';
import type { PortsMap } from '../../src/shared/ports';
import type { SessionInfo } from '../../src/shared/session';

const MIN = 60_000;

function work(items: { kind: 'agent' | 'shell' | 'monitor' | 'other'; label: string }[], crons: BackgroundWork['crons'] = []): BackgroundWork {
  const n = (k: string) => items.filter((i) => i.kind === k).length;
  return {
    counting: items.length > 0, agents: n('agent'), shells: n('shell'), monitors: n('monitor'), other: n('other'), idle: 0,
    items: items.map((i) => ({ ...i, counted: true })), crons,
    entries: items.map((i, k) => ({ id: `e${k}`, kind: i.kind, label: i.label, since: Date.now() - 5 * MIN, counted: true })),
    nextChange: null
  };
}

function session(o: Partial<SessionInfo> & Pick<SessionInfo, 'state'>, cwd: string): SessionInfo {
  return { sessionId: `s-${Math.random().toString(36).slice(2)}`, title: null, activity: null, contextPct: 42, unread: false, updatedAt: Date.now(), lastMessageAt: Date.now() - 28 * MIN, cwd, model: 'claude-opus-5-5', permissionMode: 'default', ...o };
}

export interface Crowd { list: TerminalInfo[]; ports: PortsMap }

/**
 * The crowded sidebar: five sessions (working with background work and six ports, waiting in plan mode with agents and
 * a wake-up, done in a worktree as another account, failed, a short one) and three terminals (six ports, a profile
 * and a folder, a plain shell). Every title is long enough to need its room.
 */
export function crowd(project: string): Crowd {
  const base = { projectRoot: project, cwd: project, name: null, createdAt: Date.now() - 60 * MIN, profile: 'atelier' as const };
  const list: TerminalInfo[] = [
    { ...base, id: 'n-email', title: 'Email campaign builder', color: '#F472B6', foreground: 'claude', cwd: `${project}/apps/web`,
      session: session({ state: 'running', activity: 'Running the onboarding tests' }, `${project}/apps/web`),
      work: work([{ kind: 'monitor', label: 'tail -f logs/api.log' }, { kind: 'shell', label: 'npm run dev' }]) },
    { ...base, id: 'n-auth', title: 'Auth refactor for the session tokens', color: '#60A5FA', foreground: 'claude',
      session: session({ state: 'waiting', waitingFor: 'permission', activity: 'Needs permission: Bash(npm run migrate)', permissionMode: 'plan' }, project),
      work: work([{ kind: 'agent', label: 'Explore the token store' }, { kind: 'agent', label: 'Review the middleware' }, { kind: 'shell', label: 'npm test -- --watch' }],
        [{ id: 'c1', label: 'check the deploy', schedule: '*/10 * * * *', recurring: true, next: Date.now() + 25 * MIN }]) },
    { ...base, id: 'n-docs', title: 'Docs for the public API', color: '#34D399', foreground: 'claude', cwd: `${project}/packages/docs/site`, configDir: '/Users/someone/.claude-work',
      profile: 'user', session: session({ state: 'done' }, `${project}/packages/docs/site`) },
    { ...base, id: 'n-flaky', title: 'Fix the flaky services e2e', color: '#FBBF24', foreground: 'claude',
      session: session({ state: 'error', errorReason: 'overloaded', activity: null }, project) },
    // A short name: its folder chip has the room to stay whole.
    { ...base, id: 'n-ci', title: 'CI', color: '#A78BFA', foreground: 'claude', cwd: `${project}/apps/web`, session: session({ state: 'idle', lastMessageAt: Date.now() - 3 * MIN }, `${project}/apps/web`) },
    { ...base, id: 'n-term-ports', title: 'Terminal 1', color: '#94A3B8', foreground: 'node', session: null },
    { ...base, id: 'n-term-dev', title: 'storybook and the docs server', color: '#94A3B8', foreground: 'npm', cwd: `${project}/apps/web`, profile: 'user', session: null },
    { ...base, id: 'n-term-plain', title: 'Terminal 3', color: '#94A3B8', foreground: 'zsh', session: null }
  ];
  const six = [3000, 3081, 5173, 6006, 8080, 9229].map((port) => ({ port, name: 'node' }));
  return { list, ports: { 'n-email': six, 'n-term-ports': six, 'n-term-dev': [{ port: 6006, name: 'node' }, { port: 4000, name: 'node' }] } };
}

/**
 * The window gets the crowd instead of main's lists, now and from then on: every `ev:terminals`/`ev:ports`/
 * `ev:resumables` main sends carries the staged payload (main's own lists, empty here, would otherwise replace it as
 * atelierd connects), and term:list / ports:list answer it. Test-only, in this test's main process.
 */
export async function stage(app: ElectronApplication, c: Crowd, project?: string): Promise<void> {
  const ended = Date.now() - 60 * MIN;
  // Kept sessions under Resume, with names long enough to need their room.
  const resumables = project ? [1, 2, 3].map((i) => ({ id: `r${i}`, projectRoot: project, cwd: project, title: `Kept session number ${i}`, color: '#60A5FA', sessionId: `rs${i}`, endedAt: ended, lastMessageAt: ended })) : null;
  const staged: Record<string, unknown> = { 'ev:terminals': c.list, 'ev:ports': c.ports, ...(resumables ? { 'ev:resumables': resumables } : {}) };
  await app.evaluate(({ BrowserWindow, ipcMain }, staged) => {
    type Wc = { send: (ch: string, ...a: unknown[]) => void; atlStaged?: Record<string, unknown> };
    const wc = BrowserWindow.getAllWindows()[0]!.webContents as unknown as Wc;
    const first = !wc.atlStaged;
    wc.atlStaged = { ...(wc.atlStaged ?? {}), ...staged };
    if (first) {
      const send = wc.send.bind(wc);
      wc.send = (ch, ...a) => (wc.atlStaged && ch in wc.atlStaged ? send(ch, wc.atlStaged[ch]) : send(ch, ...a));
      ipcMain.removeHandler('term:list');
      ipcMain.handle('term:list', () => wc.atlStaged!['ev:terminals']);
      ipcMain.removeHandler('ports:list');
      ipcMain.handle('ports:list', () => wc.atlStaged!['ev:ports']);
    }
    for (const [ch, v] of Object.entries(staged)) wc.send(ch, v);
  }, staged);
}

/** The sidebar at `w` px from the keyboard (16 px a key from the default 264; w - 264 must be a multiple of 16). */
export async function sidebarByKeys(win: Page, w: number): Promise<void> {
  const edge = win.getByRole('separator', { name: 'Resize sessions bar' });
  await edge.dispatchEvent('dblclick');
  await edge.focus();
  const steps = (w - 264) / 16;
  for (let i = 0; i < Math.abs(steps); i++) await win.keyboard.press(steps > 0 ? 'ArrowRight' : 'ArrowLeft');
  await frames(win);
}

/** Two frames: rows measure a frame after they change size (row-fit.ts). */
export const frames = (win: Page): Promise<void> => win.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

/** The sidebar at `w` px: its edge dragged (the width the user would get). */
export async function sidebarTo(win: Page, w: number): Promise<void> {
  const edge = win.getByRole('separator', { name: 'Resize sessions bar' });
  const now = Number(await edge.getAttribute('aria-valuenow'));
  if (now === w) return;
  const box = (await edge.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await win.mouse.move(x, y);
  await win.mouse.down();
  await win.mouse.move(x + (w - now) / 2, y, { steps: 2 });
  await win.mouse.move(x + (w - now), y, { steps: 2 });
  await win.mouse.up();
  await expect(edge).toHaveAttribute('aria-valuenow', String(w));
}

/**
 * What a row shows that collides: visible pieces (`sel`) that overlap each other or stick out of the row. Each piece
 * counts as what is seen of it: its box clipped by its ancestors up to the row (a chip its button clips is not drawn
 * over the next one); a piece clipped to nothing, hidden or transparent is not shown, so it can't collide.
 */
export async function collisions(row: Locator, sel: string): Promise<string[]> {
  return row.evaluate((el, sel) => {
    const r = el.getBoundingClientRect();
    const seenBox = (n: Element) => {
      let { left, right, top, bottom } = n.getBoundingClientRect();
      for (let p = n.parentElement; p && p !== el; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
        const b = p.getBoundingClientRect();
        left = Math.max(left, b.left); right = Math.min(right, b.right); top = Math.max(top, b.top); bottom = Math.min(bottom, b.bottom);
      }
      return { left, right, top, bottom };
    };
    const seen = [...el.querySelectorAll<HTMLElement>(sel)].map((n) => ({ n, b: seenBox(n) })).filter(({ n, b }) => {
      const cs = getComputedStyle(n);
      return b.right - b.left > 0.5 && b.bottom - b.top > 0.5 && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05;
    });
    const name = (n: HTMLElement) => `${n.className || n.tagName}${n.textContent ? ` "${n.textContent.trim().slice(0, 24)}"` : ''}`;
    const out: string[] = [];
    for (const { n, b } of seen) {
      if (b.left < r.left - 0.5 || b.right > r.right + 0.5) out.push(`${name(n)} outside the row (${Math.round(b.left)}–${Math.round(b.right)} vs ${Math.round(r.left)}–${Math.round(r.right)})`);
    }
    for (let i = 0; i < seen.length; i++) {
      for (let j = i + 1; j < seen.length; j++) {
        const { n: a, b: ra } = seen[i]!; const { n: b, b: rb } = seen[j]!;
        if (a.contains(b) || b.contains(a)) continue;
        if (ra.left < rb.right - 0.5 && rb.left < ra.right - 0.5 && ra.top < rb.bottom - 0.5 && rb.top < ra.bottom - 0.5) out.push(`${name(a)} overlaps ${name(b)}`);
      }
    }
    return out;
  }, sel);
}

/** How many px of an element's text are visible (its box, clipped by its ancestors up to the row). */
export const shownWidth = (l: Locator): Promise<number> => l.evaluate((el) => {
  let { left, right } = el.getBoundingClientRect();
  for (let p = el.parentElement; p && !p.matches('[role="listitem"]'); p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (cs.overflow === 'visible' && cs.overflowX === 'visible') continue;
    const b = p.getBoundingClientRect();
    left = Math.max(left, b.left); right = Math.min(right, b.right);
  }
  return Math.max(0, right - left);
});

