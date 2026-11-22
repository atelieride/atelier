import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Richer session states: the e2e atelierd is this build's, with the 'states2' capability; the fake
// Claude sends the v2.0 hook events through the real bridge ("ev:<what>" lines, see fake-claude.pl).

type Api = { terminals: { list(): Promise<{ id: string; title: string }[]>; input(id: string, data: string): void } };

async function launch(extra: Record<string, string> = {}): Promise<{ app: ElectronApplication; home: string; win: Page }> {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ...extra });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  return { app, home, win: await app.firstWindow() };
}

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

const command = (app: ElectronApplication, cmd: string) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:command', c), cmd);

async function newSession(win: Page, name: string) {
  await win.locator('.btn-new').click();
  await win.getByRole('menuitem', { name: 'Claude Session' }).click();
  await win.getByPlaceholder('Session name (optional)').fill(name);
  await win.keyboard.press('Enter');
  await expect(row(win, name)).toHaveClass(/state-waiting/, { timeout: 20000 });
}

/** Types into a session's prompt without selecting it. */
async function typeInto(win: Page, title: string, text: string) {
  await win.evaluate(async ({ title, text }) => {
    const api = (window as unknown as { atelier: Api }).atelier;
    const id = (await api.terminals.list()).find((x) => x.title === title)!.id;
    api.terminals.input(id, text);
  }, { title, text });
}

const row = (win: Page, name: string) => win.locator('.session-row').filter({ has: win.locator('.session-title', { hasText: new RegExp(`^${name}$`) }) });
const subtitle = (win: Page, name: string) => row(win, name).locator('.session-activity');

/** Animations off for screenshots that are looked at. */
const still = (win: Page) => win.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });

test('states2: permission, question, compacting, subagents, plan, error labels — rows, bar, inbox, ⌘J, phone gating', async () => {
  const { app, home, win } = await launch();
  try {
    for (const name of ['Perm', 'Quest', 'Compact', 'Planner', 'Broken']) await newSession(win, name);
    // Each fake session starts on a Bash permission request.
    await expect(subtitle(win, 'Perm')).toHaveText('Needs permission: Bash npm test');

    // Everybody but Perm answers it, then each goes somewhere else.
    for (const name of ['Quest', 'Compact', 'Planner', 'Broken']) await typeInto(win, name, '\r');
    await expect(row(win, 'Broken')).toHaveClass(/state-done/, { timeout: 10000 });
    await typeInto(win, 'Quest', 'ev:question\r');
    await typeInto(win, 'Compact', 'ev:work\rev:agents:3\rev:compact\r');
    await typeInto(win, 'Planner', 'ev:work\rev:mode:plan\r');
    await typeInto(win, 'Broken', 'ev:fail:overloaded\r');

    await expect(subtitle(win, 'Quest')).toHaveText('Has a question');
    await expect(row(win, 'Quest')).toHaveClass(/state-waiting/);
    await expect(subtitle(win, 'Compact')).toHaveText('Compacting…');
    await expect(subtitle(win, 'Compact')).not.toHaveClass(/shimmer/);
    await expect(row(win, 'Compact').locator('.work-chip .work-full')).toHaveText('3 agents');
    await expect(row(win, 'Planner').locator('.plan-badge')).toHaveText('plan');
    await expect(row(win, 'Perm').locator('.plan-badge')).toHaveCount(0);
    await expect(row(win, 'Perm').locator('.work-chip')).toHaveCount(0);
    // Error: a label, the raw code in the tooltip.
    await expect(subtitle(win, 'Broken')).toHaveText('Overloaded');
    await expect(subtitle(win, 'Broken')).toHaveAttribute('data-tip', 'Claude Code error: overloaded');

    await still(win);
    await look(win.locator('.sidebar'), 'test-results/states2-rows.png');

    // Inbox: Needs you = the permission, the question and the error.
    // (The state heads carry no number since 2026-11-02: the rows under Needs you are counted.)
    const needs = () => win.evaluate(() => {
      let n = 0;
      for (let e = document.querySelector('.inbox-head.is-needs')?.nextElementSibling; e && !e.classList.contains('inbox-head'); e = e.nextElementSibling) if (e.classList.contains('session-row')) n++;
      return n;
    });
    await expect.poll(needs).toBe(3);
    await look(win.locator('.sidebar'), 'test-results/states2-inbox.png');

    // The idle notice (waitingFor 'input') is not "needs you": Quest answered, finished, then idle.
    await typeInto(win, 'Quest', 'ev:answered\rev:stop\rev:idle\r');
    await expect.poll(needs, { timeout: 10000 }).toBe(2);
    await expect(row(win, 'Quest')).not.toHaveClass(/state-waiting/);

    // ⌘J: the permission request first, wherever it is in the tab order.
    await row(win, 'Broken').locator('.row-main').click();
    await typeInto(win, 'Quest', 'ev:question\r');
    await expect(subtitle(win, 'Quest')).toHaveText('Has a question');
    await command(app, 'next-attention');
    await expect(row(win, 'Perm')).toHaveClass(/is-selected/);
    // The session bar has no state chip, phone, Changes or close button (2026-10-26: the row, the tab bar and the
    // menus have them); the terminal's amber frame says it waits.
    const bar = win.locator('.session-bar');
    await expect(win.locator('.workspace-body.is-waiting')).toHaveCount(1);
    for (const gone of ['.state-chip', '.sb-phone', '.sb-changes', '.sb-close']) await expect(bar.locator(gone), gone).toHaveCount(0);

    await row(win, 'Quest').locator('.row-main').click();
    await expect(win.locator('.workspace-body.is-waiting')).toHaveCount(1);
    await expect(bar.locator('.state-chip')).toHaveCount(0);

    await row(win, 'Planner').locator('.row-main').click();
    await expect(bar.locator('.plan-badge')).toHaveText('plan');

    await row(win, 'Broken').locator('.row-main').click();
    await expect(bar.locator('.sb-activity')).toHaveText('Overloaded');
    await expect(bar.locator('.sb-activity')).toHaveAttribute('data-tip', 'Claude Code error: overloaded');

    await row(win, 'Compact').locator('.row-main').click();
    await expect(bar.locator('.sb-activity')).toHaveText('Compacting…');
    await expect(bar.locator('.work-chip .work-full')).toHaveText('3 agents');
    await look(win.locator('.session-bar'), 'test-results/states2-bar.png');
    // Compaction over, one agent back: the activity returns, the chip counts down.
    await typeInto(win, 'Compact', 'ev:compacted\rev:agent-done\r');
    await expect(bar.locator('.work-chip .work-full')).toHaveText('2 agents');
    await expect(bar.locator('.sb-activity')).not.toHaveText('Compacting…');

    // Notification center: the waiting entries say what for.
    await command(app, 'show-notifications');
    const details = win.locator('.notes-pop .note-row .note-detail');
    await expect(details.filter({ hasText: 'Needs permission · Bash npm test' }).first()).toBeVisible();
    await expect(details.filter({ hasText: 'Has a question' }).first()).toBeVisible();
  } finally {
    await stop(app, home);
  }
});

/** The grouped list: [section label, row titles] in order. */
const sections = (win: Page) => win.locator('.list.inbox').evaluateAll((lists) => {
  const out: [string, string[]][] = [];
  for (const el of lists[0]?.children ?? []) {
    if (el.classList.contains('inbox-head')) out.push([el.querySelector('.section-label')?.textContent ?? '', []]);
    else if (el.classList.contains('session-row')) out.at(-1)?.[1].push(el.querySelector('.session-title')?.textContent ?? '');
  }
  return out;
});

test('background subagents: the chip stays after the main Stop, its dot in the working color; the session reads as Working; the idle notice clears a subagent that never stopped', async () => {
  const { app, home, win } = await launch();
  try {
    await newSession(win, 'Bg');
    // Another session selected: Bg is never looked at, so its finished turn stays unread.
    await newSession(win, 'Other');
    await typeInto(win, 'Bg', '\r');
    await expect(row(win, 'Bg')).toHaveClass(/state-done/, { timeout: 10000 });
    const chip = row(win, 'Bg').locator('.work-chip');

    // The main agent launches a background subagent, then its turn ends: the subagent goes on.
    await typeInto(win, 'Bg', 'ev:work\rev:agents:1\r');
    await expect(chip.locator('.work-full')).toHaveText('1 agent');
    await expect(chip).not.toHaveClass(/is-counting/);
    await typeInto(win, 'Bg', 'ev:stop\rev:agent-tool\r');
    await expect(row(win, 'Bg')).toHaveClass(/state-running/);
    await expect(chip.locator('.work-full')).toHaveText('1 agent');
    await expect(chip).toHaveClass(/is-counting/);
    // A thin outline whose dot carries the state: no shimmer, no pulse.
    await expect(chip.locator('.shimmer')).toHaveCount(0);
    expect(await chip.locator('.work-dot').evaluate((el) => el.getAnimations().length)).toBe(0);
    // The tooltip: the summary, then each item ("agent · <its type>").
    await expect(chip).toHaveAttribute('data-tip', '1 agent\nagent · Explore\nClick for details');

    // Main Stop: done, but the subagent still counts: the row stays Working (not Ready for review) until it ends.
    await typeInto(win, 'Bg', 'ev:work\rev:stop\rev:agent-tool\r');
    await expect(row(win, 'Bg')).toHaveClass(/state-running/);
    await expect(row(win, 'Bg')).toHaveClass(/is-unread/);
    await expect(chip.locator('.work-full')).toHaveText('1 agent');
    await expect(chip).toHaveClass(/is-counting/);
    await expect.poll(() => sections(win)).toEqual([['Needs you', ['Other']], ['Working', ['Bg']]]);
    await look(win.locator('.sidebar'), 'test-results/states2-background-agents.png');

    // Its own SubagentStop ends it: the chip goes away.
    await typeInto(win, 'Bg', 'ev:agent-done\r');
    await expect(chip).toHaveCount(0);
    await expect(row(win, 'Bg')).toHaveClass(/state-done/);
    await expect.poll(() => sections(win)).toEqual([['Needs you', ['Other']], ['Ready for review', ['Bg']]]);

    // A subagent that never sends its SubagentStop (a foreground one interrupted with Esc): Claude Code's idle notice
    // comes only with no background agent left, so it ends it.
    await typeInto(win, 'Bg', 'ev:work\rev:agents:1\rev:stop\r');
    await expect(row(win, 'Bg')).toHaveClass(/state-running/);
    await expect(chip).toHaveClass(/is-counting/);
    await typeInto(win, 'Bg', 'ev:idle\r');
    await expect(chip).toHaveCount(0);
    await expect(row(win, 'Bg')).toHaveClass(/state-done/);
  } finally {
    await stop(app, home);
  }
});

/**
 * The boxes of a row's parts that are laid out, the pairs among them that overlap (by more than half a pixel), those
 * outside the row, what each of its three lines holds, whether the details line stays one line (its parts and the
 * ports on one band, nothing clipped), and where the avatar and the title sit.
 */
async function rowLayout(win: Page, name: string) {
  return row(win, name).evaluate((el) => {
    const sel = ['.avatar', '.session-title', '.cwd-chip', '.profile-chip', '.account-chip', '.plan-badge', '.work-chip', '.sched-chip', '.port-chip', '.session-activity', '.row-pending', '.row-pin', '.row-close'];
    const boxes = sel.flatMap((s) => [...el.querySelectorAll(s)].map((n) => ({ s, r: n.getBoundingClientRect() }))).filter((b) => b.r.width > 0 && b.r.height > 0);
    const own = el.getBoundingClientRect();
    const overlaps: string[] = [];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!.r; const b = boxes[j]!.r;
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (w > 0.5 && h > 0.5) overlaps.push(`${boxes[i]!.s} × ${boxes[j]!.s}`);
    }
    const outside = boxes.filter((b) => b.r.left < own.left - 0.5 || b.r.right > own.right + 0.5).map((b) => b.s);
    // What each line holds: the classes of its children that are laid out.
    const kids = (s: string) => [...(el.querySelector(s)?.children ?? [])].filter((c) => (c as HTMLElement).offsetWidth > 0).map((c) => c.classList[0]!);
    const detailParts = boxes.filter((b) => ['.plan-badge', '.work-chip', '.sched-chip', '.port-chip', '.cwd-chip', '.profile-chip', '.account-chip'].includes(b.s));
    const mids = detailParts.map((b) => b.r.top + b.r.height / 2);
    const details = el.querySelector('.session-details') as HTMLElement | null;
    const box = (s: string) => el.querySelector(s)!.getBoundingClientRect();
    return {
      parts: boxes.map((b) => b.s), overlaps, outside,
      title: kids('.session-line'), sub: kids('.session-sub'), hasDetails: !!details && details.offsetHeight > 0,
      detailsOneLine: mids.every((y) => Math.abs(y - mids[0]!) < 2),
      detailsBelow: !details || detailParts.every((b) => b.r.top >= box('.session-sub').bottom - 0.5),
      detailsClipped: !!details && [details, ...details.children].some((c) => (c as HTMLElement).scrollWidth > (c as HTMLElement).clientWidth + 0.5),
      titleW: box('.session-title').width,
      // The avatar stands beside the name: their tops within a couple of pixels.
      avatarToTitle: Math.abs(box('.avatar').top - box('.session-line').top)
    };
  });
}

test('session rows: the name alone, then the activity alone, then a details line with every chip and the ports; nothing overlaps from 200 to 400 px', async () => {
  const { app, home, win } = await launch({ ATELIER_TEST_PORTS_POLL_MS: '500' });
  try {
    await newSession(win, 'Brainstorming the layout');
    await newSession(win, 'Other');
    await newSession(win, 'Plain');
    for (const name of ['Brainstorming the layout', 'Other', 'Plain']) await typeInto(win, name, '\r');
    await expect(row(win, 'Brainstorming the layout')).toHaveClass(/state-done/, { timeout: 10000 });
    // A subagent and a background shell, a scheduled wake-up (its Stop), three listening ports, plan mode, then a
    // permission request: every part of the details line at once.
    await typeInto(win, 'Brainstorming the layout', 'ev:work\rev:agents:1\rev:shell:b1\rev:cron\rev:listen:3\rev:mode:plan\rev:permission\r');
    // A usual row: one background shell and a dev server.
    await typeInto(win, 'Other', 'ev:work\rev:shell:o1\rev:listen:1\r');
    const busy = row(win, 'Brainstorming the layout');
    await expect(busy.locator('.session-details .work-chip')).toHaveAttribute('data-tip', '1 agent · 1 shell\nagent · Explore\nshell · Running e2e suite b1\nClick for details');
    await expect(busy.locator('.session-details .sched-chip')).toHaveAttribute('data-tip', /^1 scheduled wake-up · next at 12:30( tomorrow)? · check the deploy\nClick for details$/);
    await expect(busy.locator('.session-details .plan-badge')).toHaveText('plan');
    await expect(busy.locator('.session-sub .session-activity')).toHaveText('Needs permission: Bash npm test');
    // The ports: the first one and +2, at the end of the details line (the hub polls every 4 s, 500 ms here).
    await expect(busy.locator('.row-ports .port-more')).toHaveText('+2', { timeout: 10000 });
    await expect(busy.locator('.row-actions .port-chips')).toHaveCount(0);
    await busy.click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Pin', exact: true }).click();
    await expect(busy.locator('.row-pin')).toHaveAttribute('aria-pressed', 'true');
    // Nothing to tell beyond its activity: two lines, no details line.
    await expect(row(win, 'Plain').locator('.session-details')).toBeHidden();
    await expect(row(win, 'Other').locator('.row-ports .port-chip').first()).toBeVisible({ timeout: 10000 });

    // The fake session reports 58% of context: the rows don't show it, the session bar still does.
    await busy.locator('.row-main').click();
    await expect(win.locator('.session-bar .ctx-ring')).toBeVisible();
    await expect(win.locator('.session-row .ctx-ring')).toHaveCount(0);

    // The session bar shows the chips too; crowded by the ports (≤ 1100 px), compacted, the tooltips in full.
    const bar = win.locator('.session-bar');
    await expect(bar.locator('.work-chip')).toHaveAttribute('data-tip', '1 agent · 1 shell\nagent · Explore\nshell · Running e2e suite b1\nClick for details');
    await expect(bar.locator('.sched-chip')).toBeVisible();
    const barW = await bar.evaluate((el) => el.getBoundingClientRect().width);
    await expect(bar.locator(barW > 1100 ? '.work-full' : '.work-short')).toBeVisible();
    // No name or avatar above a single terminal (its tab has them): the activity takes their room.
    await expect(bar.locator('.sb-title, .avatar')).toHaveCount(0);
    expect(await bar.locator('.sb-activity').evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(60);
    // Narrow (the 960 px window with Changes open): with no name to make room for, the activity stays, cut by an ellipsis.
    await bar.evaluate((el) => { el.style.width = '480px'; });
    await expect(bar.locator('.sb-activity')).toHaveCSS('visibility', 'visible');
    await bar.evaluate((el) => { el.style.width = ''; });

    await still(win);
    await look(win.locator('.session-bar'), 'test-results/rows-bar.png');
    // Keyboard: the row's own buttons (pin, close) come before its ports in the tab order.
    expect(await busy.evaluate((el) => !!(el.querySelector('.row-actions')!.compareDocumentPosition(el.querySelector('.row-ports')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    for (const width of [200, 230, 264, 300, 340, 400]) {
      await win.locator('.body').evaluate((el, w) => (el as HTMLElement).style.setProperty('--sidebar-w', `${w}px`), width);
      await expect.poll(() => win.locator('.sidebar').evaluate((el) => el.getBoundingClientRect().width)).toBe(width);
      for (const hovered of [false, true]) {
        if (hovered) await busy.hover(); else await win.mouse.move(700, 500);
        const r = await rowLayout(win, 'Brainstorming the layout');
        const at = `at ${width}px${hovered ? ' (hover)' : ''}`;
        expect(r.parts).toEqual(expect.arrayContaining(['.session-title', '.plan-badge', '.work-chip', '.sched-chip', '.port-chip', '.session-activity', ...(hovered ? ['.row-pin', '.row-close'] : [])]));
        // Each line holds one thing: the name, then the activity; every chip is on the details line, under them.
        expect(r.title, `title line ${at}`).toEqual(['session-title']);
        expect(r.sub, `activity line ${at}`).toEqual(['session-activity']);
        expect(r.detailsBelow, `details under the activity ${at}`).toBe(true);
        // The buttons show only on hover, over the end of the title line, which fades out under them.
        if (!hovered) expect(r.parts.filter((p) => p === '.row-pin' || p === '.row-close'), `buttons hidden ${at}`).toEqual([]);
        const titleLine = /^\.session-title × \.row-(pin|close|pending)$/;
        expect(r.overlaps.filter((o) => !(hovered && titleLine.test(o))), `overlaps ${at}`).toEqual([]);
        if (hovered) expect(await busy.locator('.session-line').evaluate((el) => getComputedStyle(el).webkitMaskImage), `title fades ${at}`).toContain('gradient');
        expect(r.outside, `outside the row ${at}`).toEqual([]);
        expect(r.detailsOneLine, `details on one line ${at}`).toBe(true);
        expect(r.detailsClipped, `details clipped ${at}`).toBe(false);
        expect(r.avatarToTitle, `avatar beside the name ${at}`).toBeLessThan(3);
        // The name has the whole line: whole where it fits, never crushed where it doesn't.
        expect(r.titleW, `title width ${at}`).toBeGreaterThan(Math.min(140, width - 140));
        const other = await rowLayout(win, 'Other');
        expect(other.overlaps, `Other's overlaps ${at}`).toEqual([]);
        expect(other.outside, `Other outside the row ${at}`).toEqual([]);
        expect(other.detailsOneLine, `Other's details on one line ${at}`).toBe(true);
        const plain = await rowLayout(win, 'Plain');
        expect(plain.hasDetails).toBe(false);
        expect(plain.overlaps).toEqual([]);
      }
      // One form while the live parts fit: glyphs and numbers for the work, the wake-up's time. Only a crowd of them
      // on a narrow row compacts them (the work's total, the clock alone); a usual row never, from the default width.
      const chip = busy.locator('.work-chip');
      const crowded = await busy.evaluate((el) => el.hasAttribute('data-crowded'));
      if (width >= 340) expect(crowded, `crowded at ${width}px`).toBe(false);
      if (width <= 200) expect(crowded, `crowded at ${width}px`).toBe(true);
      if (crowded) {
        await expect(chip.locator('.work-total')).toHaveText('2');
        await expect(busy.locator('.sched-time')).toBeHidden();
      } else {
        await expect(chip.locator('.work-short')).toHaveText('11');
        await expect(busy.locator('.sched-time')).toHaveText('12:30');
      }
      if (width >= 264) {
        expect(await row(win, 'Other').evaluate((el) => el.hasAttribute('data-crowded')), `Other crowded at ${width}px`).toBe(false);
        await expect(row(win, 'Other').locator('.work-chip .work-short')).toBeVisible();
      }
      // Narrower than the default and still too much: plan mode its "P", the first port naming the others.
      const packed = await busy.evaluate((el) => el.hasAttribute('data-packed'));
      if (width >= 264) expect(packed, `packed at ${width}px`).toBe(false);
      await expect(busy.locator('.row-ports .port-more')).toBeVisible({ visible: !packed });
      if (packed) await expect(busy.locator('.row-ports .port-chip').first()).toHaveAttribute('data-tip', /^Open localhost:\d+ · perl\nAlso listening: :\d+ · perl, :\d+ · perl$/);
      await expect(chip.locator('.work-full')).toBeHidden();
      await expect(busy.locator('.row-ports .port-chip:not(.port-more):not(.port-all)')).toBeVisible();
      await expect(busy.locator('.row-ports .port-all')).toBeHidden();
      // The plan badge keeps one form (uppercase) at every width.
      expect(await busy.locator('.plan-badge').evaluate((el) => getComputedStyle(el).textTransform)).toBe('uppercase');
      // The waiting reason has its line to itself: whole from the default width.
      if (width >= 264) expect(await busy.locator('.session-activity').evaluate((el) => el.scrollWidth <= el.clientWidth), `activity whole at ${width}px`).toBe(true);
      await look(win.locator('.sidebar'), `test-results/rows-${width}.png`);
    }
  } finally {
    await stop(app, home);
  }
});

test('Remote Control: the wifi glyph alone on the row and the session bar while Claude Code says it is on; a click opens the session at claude.ai/code; gone with the next hook once off', async () => {
  const urlLog = join(mkdtempSync(join(tmpdir(), 'atl-url-')), 'urls.log');
  const { app, home, win } = await launch({ ATELIER_TEST_URL_LOG: urlLog });
  try {
    await newSession(win, 'Couch');
    await typeInto(win, 'Couch', '\r');
    const r = row(win, 'Couch');
    await expect(r).toHaveClass(/state-done/, { timeout: 10000 });
    await expect(r.locator('.remote-chip')).toHaveCount(0);
    // /remote-control: Claude Code puts the claude.ai session's id in its hooks' environment; the next hook says it.
    await typeInto(win, 'Couch', 'ev:rc:session_01TestRemoteCtl4Kp9Zq\rev:work\r');
    const chip = r.locator('.session-details .remote-chip');
    await expect(chip.locator('svg')).toBeVisible({ timeout: 10000 });
    // The glyph alone, no word beside it; the row's name still says it to a screen reader.
    await expect(chip).toHaveText('Remote Control');
    expect((await chip.boundingBox())!.width).toBeLessThanOrEqual(20);
    await expect(chip).toHaveAttribute('data-tip', /^Remote Control is on: this session goes on at claude\.ai/);
    await still(win);
    await win.mouse.move(700, 500);
    await look(win.locator('.sidebar'), 'test-results/remote-row.png');
    // A click opens it in the browser (logged here), and leaves the row as it was.
    await chip.click();
    await expect.poll(() => (existsSync(urlLog) ? readFileSync(urlLog, 'utf8') : ''), { timeout: 5000 }).toContain('https://claude.ai/code/session_01TestRemoteCtl4Kp9Zq');
    // The session bar: a button that says where it goes.
    await r.locator('.row-main').click();
    const bar = win.locator('.session-bar .remote-chip');
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute('aria-label', 'Open on claude.ai');
    const box = (await bar.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(box.height + 1);
    await look(win.locator('.session-bar'), 'test-results/remote-bar.png');
    // The keyboard's way: the row's menu.
    await r.click({ button: 'right' });
    await expect(win.getByRole('menuitem', { name: 'Open on claude.ai' })).toBeVisible();
    await win.keyboard.press('Escape');
    // Off: the next hook's environment no longer has it.
    await typeInto(win, 'Couch', 'ev:rc-off\rev:stop\r');
    await expect(r.locator('.remote-chip')).toHaveCount(0, { timeout: 10000 });
    await expect(win.locator('.session-bar .remote-chip')).toHaveCount(0);
  } finally {
    await stop(app, home);
  }
});

test('an atelierd without states2: rows exactly as before, and Settings › Terminal says how to get them', async () => {
  // An atelierd older than states2 is older than background work too.
  const { app, home, win } = await launch({ ATELIER_TEST_NO_PROFILES: 'states2,background' });
  try {
    await newSession(win, 'Old');
    // The v2.0 fields are ignored: the activity as atelierd wrote it, no chips.
    await expect(row(win, 'Old').locator('.session-activity')).toHaveText('waiting: Bash npm test');
    await typeInto(win, 'Old', '\r');
    await expect(row(win, 'Old')).toHaveClass(/state-done/, { timeout: 10000 });
    await typeInto(win, 'Old', 'ev:work\rev:agents:2\rev:mode:plan\rev:fail:rate_limit\r');
    await expect(row(win, 'Old')).toHaveClass(/state-error/, { timeout: 10000 });
    await expect(subtitle(win, 'Old')).toHaveText('rate_limit');
    await expect(row(win, 'Old').locator('.work-chip, .plan-badge')).toHaveCount(0);

    await win.getByRole('button', { name: 'Settings' }).click();
    const dialog = win.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('button', { name: 'Terminal' }).click();
    const notice = dialog.locator('.set-notice');
    await expect(notice).toHaveText(/Restart atelierd to get richer session states and command blocks/);
    // Profiles are there: their row stays.
    await expect(dialog.getByRole('button', { name: 'Reload' })).toHaveCount(1);
    await still(win);
    await look(dialog, 'test-results/states2-notice.png');
    await app.evaluate(({ dialog: d }) => {
      (globalThis as { asked?: string }).asked = '';
      d.showMessageBox = (async (...args: unknown[]) => { (globalThis as { asked?: string }).asked = (args.at(-1) as { message: string }).message; return { response: 1, checkboxChecked: false }; }) as typeof d.showMessageBox;
    });
    await notice.getByRole('button', { name: 'Restart atelierd…' }).click();
    // Asked in the window, never the native dialog.
    const sheet = win.locator('.confirm-sheet');
    await expect(sheet).toContainText('Restart atelierd?');
    await sheet.getByRole('button', { name: /^Cancel/ }).click();
    await expect(sheet).toHaveCount(0);
    expect(await app.evaluate(() => (globalThis as { asked?: string }).asked)).toBe('');
  } finally {
    await stop(app, home);
  }
});
