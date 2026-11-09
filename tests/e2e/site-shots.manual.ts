import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { makeDemoProject } from './site-shots/demo-project';
import { LIVE_SELECTORS, liveSpots, type MeasuredSpot, type SpotKind } from './site-shots/live-spots';
import { SENSITIVE, SHOTS_ONLY, findBanned } from '../support/banned-strings';
import { FakeDocker } from '../support/fake-docker';
import { stageDocker } from './docker-fixture';
import { FakeRedis } from '../support/fake-redis';
import { acmeStore } from '../support/redis-fixtures';
import { startDemoPostgres } from '../support/pg-demo-seed';
import { cell, dbIcon, front, header, relRow, tabOf } from './databases-fixture';
import { ACME_DB } from '../../src/demo/world/databases-conn';
import { SCENARIOS, type ScenarioName } from '../../src/demo/world/scenarios';
import { claudeAccountsAt, scenarioAccount } from '../../src/demo/world/accounts';
import { AUTHOR } from '../../src/demo/world/project';
import { worldAutomations } from '../../src/demo/world/automations';
import { ASK_SCRIPT } from '../../src/demo/world/ask';
import { startFake } from './fake-clickup-cli';

// Website screenshots: the real app, a fictional project, scripted sessions; nothing of the Mac.
// Run with `npm run site:shots`; every PNG is looked at before it is committed.
const OUT = resolve('site/src/assets/shots');
// The Changes shot's ✦ message (the fake claude prints it), in the style of the world's history, and the mailer's
// welcome email before and after the onboarding work.
const COMMIT_MESSAGE = 'Greet returning customers by name\n\nReturning customers see their name and a link back to their cart.';
const MAILER_BEFORE = '<h1>Welcome to Acme</h1>\n<p>Thanks for signing up.</p>\n';
const MAILER_AFTER = '<h1>Good to see you, {{name}}</h1>\n<p>Your cart is right where you left it.</p>\n';
/** git in one of the shots' repositories, never with the Mac's global or system config. */
const gitIn = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
const SESSIONS = Object.keys(SCENARIOS) as ScenarioName[];
// SITE_SHOTS=ask,changes: only those shots are written (the others stay as committed) and the run stops once they are
// taken. Unset: every shot.
const ONLY = process.env.SITE_SHOTS ? process.env.SITE_SHOTS.split(',').map((s) => s.trim()).filter(Boolean) : null;
/** Thrown by shot() once every shot SITE_SHOTS names is taken: the rest of the staging is skipped. */
class AllTaken extends Error {}

// Ask: the session it catches up on, and where the demo world's script has it now (its
// phase in src/demo/world/ask.ts, as the live demo plays it).
const ASK_SHOT = { session: 'auth-refactor' as ScenarioName, phase: 'waiting' };

/** The demo world's Catch me up for the shot's session, as the fake companion plays it (fake-claude-ask.mjs). */
function askScript(lastMessageAt: number): string {
  const c = ASK_SCRIPT.sessions[ASK_SHOT.session].phases.find((p) => p.id === ASK_SHOT.phase)!.catchUp;
  const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 5);
  const points = c.points.map((p, i) => ({ n: i + 1, text: p.text, status: p.status, at: p.at === 'turn' ? hhmm(lastMessageAt) : null, note: p.note ?? null }));
  return JSON.stringify({ catchUp: { data: { points, where: c.where, choices: [...c.choices], leftOpen: null }, read: c.read } });
}

/** A session's chat where Ask reads it (the default account's projects folder, both spellings of the cwd). */
function writeChat(projects: string, cwd: string, sessionId: string, prompt: string, at: number) {
  const line = (o: object) => JSON.stringify(o) + '\n';
  for (const dir of new Set([cwd, realpathSync(cwd)])) {
    const folder = join(projects, dir.replace(/[^a-zA-Z0-9]/g, '-'));
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${sessionId}.jsonl`),
      line({ type: 'user', sessionId, cwd: dir, timestamp: new Date(at - 90_000).toISOString(), message: { role: 'user', content: prompt } })
      + line({ type: 'assistant', sessionId, cwd: dir, timestamp: new Date(at).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] } }));
  }
}

async function launch(env: Record<string, string>, project: string): Promise<{ app: ElectronApplication; win: Page }> {
  // 2× pixels whatever the display; the window renders hidden, as in every e2e.
  const app = await electron.launch({ args: ['--force-device-scale-factor=2', 'out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0]!.setContentSize(s.width, s.height), WINDOW);
  return { app, win };
}

type Dbs = {
  databases: {
    save(a: { form: object; password: null; id: null }): Promise<{ ok: boolean; value?: { id: string } }>;
    select(id: string): Promise<void>; noteWrite(id: string): Promise<void>;
  };
};

/** The acme-store's Postgres saved as the live demo has it (acme, Local, its database and user), on the test server. */
async function saveDemoDatabase(win: Page, port: number, project: string): Promise<string> {
  const form = {
    name: ACME_DB.name, engine: 'postgres', env: ACME_DB.env, host: '127.0.0.1', port, database: ACME_DB.database,
    user: ACME_DB.user, tls: ACME_DB.tls, ssh: null, scope: { kind: 'project', root: project }
  };
  const saved = await win.evaluate((f) => (window as unknown as { atelier: Dbs }).atelier.databases.save({ form: f, password: null, id: null }), form);
  expect(saved.ok, 'the demo connection is saved').toBe(true);
  const id = saved.value!.id;
  // PGlite's one role is a superuser: its write note dismissed, as the demo's role reads as one that can only read.
  await win.evaluate((i) => (window as unknown as { atelier: Dbs }).atelier.databases.noteWrite(i), id);
  return id;
}

async function newSession(win: Page, name: string) {
  await win.locator('.btn-new').click();
  await win.getByRole('menuitem', { name: 'Claude Session' }).click();
  await win.getByPlaceholder('Session name (optional)').fill(name);
  // Its Claude account (world/accounts.ts): Tab from Personal, the one set for new sessions, to Work.
  if (scenarioAccount(SCENARIOS[name as ScenarioName]).id === 'work') {
    await win.keyboard.press('Tab');
    await expect(win.locator('.acct-card.is-on')).toContainText('Work');
  }
  await win.keyboard.press('Enter');
  await expect(win.locator('.session-row', { hasText: name })).toBeVisible({ timeout: 20000 });
}

/** Clicks a menu item, as the menu bar would (the window never has focus: its accelerators never fire). */
async function menu(app: ElectronApplication, top: string, label: string) {
  await app.evaluate(({ Menu, BrowserWindow }, [t, l]) => {
    const sub = Menu.getApplicationMenu()!.items.find((m) => m.label === t)!;
    sub.submenu!.items.find((m) => m.label === l)!.click(undefined, BrowserWindow.getAllWindows()[0]);
  }, [top, label] as const);
}

/** Drags the first split divider until the right pane starts at `x` (CSS px). */
async function rightPaneAt(win: Page, x: number) {
  const split = (await win.locator('.workspace-body > .pane-frame').nth(1).boundingBox())!;
  const divider = (await win.locator('.pane-divider').first().boundingBox())!;
  const y = divider.y + divider.height / 2;
  await win.mouse.move(divider.x + divider.width / 2, y);
  await win.mouse.down();
  await win.mouse.move(divider.x + divider.width / 2 - (split.x - x), y, { steps: 4 });
  await win.mouse.up();
  await expect.poll(async () => Math.round((await win.locator('.workspace-body > .pane-frame').nth(1).boundingBox())!.x)).toBe(x);
}

/** Gives the focus to a pane (0: the left one), through its tab in front (is-active only in the focused pane). */
async function focusPane(win: Page, pane: number) {
  await win.locator(`.pane-strip[data-pane="${pane}"] .tab[aria-selected="true"]`).click();
  await expect(win.locator(`.pane-strip[data-pane="${pane}"]`)).toHaveClass(/is-focused/);
}

/** Opens a file from the palette (F1), in the focused pane or, with `side`, in a new pane on the right. */
async function openFile(win: Page, query: string, file: string, side = false) {
  await win.keyboard.press('F1');
  await win.locator('.palette-input').fill(query);
  await win.locator('.palette-item', { hasText: file }).first().click(side ? { modifiers: ['Alt'] } : undefined);
}

// The window, and the part of it each feature row shows (CSS px). The site draws every shot 1:1 on a Retina desktop
// (site/src/components/Window.astro): the hero is the whole window at 1280, a feature row's column is 640 wide, so its
// shot is a 640-wide crop of what the feature is about. Panes: sidebar to 313, workspace to 976 (split at 645), Changes.
const WINDOW = { width: 1280, height: 800 };
// The Changes shot's window (the last one): as wide, shorter, so the commit drawer meets the rows.
const GIT_WINDOW = { width: 1280, height: 680 };
// The Ask shot's window: as wide, taller, so the panel's thread holds the whole Catch me up card (444 px) under the
// needs-you card.
const ASK_WINDOW = { width: 1280, height: 980 };
const FEATURE = { width: 640, height: 440 };
const CLIPS: Record<string, { x: number; y: number; width: number; height: number }> = {
  sessions: { x: 0, y: 0, ...FEATURE },
  workspace: { x: 313, y: 45, ...FEATURE },
  // The diff of welcome.tsx and Changes with the commit drawer open, down to the panel's bottom (GIT_WINDOW): taller
  // than the others, the rows and the drawer tell one story.
  changes: { x: 640, y: 45, width: FEATURE.width, height: 609 },
  editor: { x: 640, y: 45, ...FEATURE },
  dictation: { x: 324, y: 320, ...FEATURE },
  // Taken with Changes hidden: the Background pane from x 640 to the window's edge, list beside the details. From its
  // own header down (its tab and pane title say the same), so the live output has room below the details.
  background: { x: 640, y: 120, ...FEATURE },
  // Taken with Changes hidden, the Docker tab in the right pane (from x 640) beside auth-refactor: the api's last lines,
  // two errors picked, and the bar that sends them to the session.
  docker: { x: 640, y: 330, ...FEATURE },
  // Taken with Changes hidden, the Redis tab in the right pane (from x 640) beside auth-refactor: email-queue's failed
  // jobs, the first one's error and the bar that asks Claude why it failed.
  redis: { x: 640, y: 326, ...FEATURE },
  // Taken with Changes hidden, the orders table in the right pane (from x 640) beside auth-refactor: newest first, the
  // inspector on the newest order, its customer's peek card.
  databases: { x: 640, y: 45, ...FEATURE },
  alive: { x: 0, y: 0, ...FEATURE },
  // The New Session sheet (520 wide, centred from x 380, 84 from the top) over the workspace: both Claude accounts
  // with their limits, Work picked. Shorter than the others: down to the sheet's
  // shadow, below it there is only the blurred session.
  accounts: { x: 320, y: 0, width: FEATURE.width, height: 280 },
  // The Schedule a prompt sheet (600 wide, centred from x 340, 84 from the top): its prompt, the presets with "When
  // usage resets" picked, the rail, down to its buttons.
  scheduled: { x: 320, y: 60, width: FEATURE.width, height: 500 },
  // The Automations tab in the workspace, from its left margin to Changes: the rule that is on, what it does, and its
  // runs at work and for review, down to the line under the second.
  automations: { x: 326, y: 45, width: FEATURE.width, height: 566 },
  // Ask docked at the session pane's right (from x 876, ASK_WINDOW), beside the waiting terminal's edge: from the session
  // bar (its Ask pill open) down to the Catch me up card's source line. Taller than the others: the card is the story.
  ask: { x: 640, y: 84, width: FEATURE.width, height: 673 }
};
// On a phone the site shows a tighter crop of each shot (<name>.mobile.png, at most 480 px wide screens): about as wide
// as the page's column there (~343 px), so the app's text stays near its real size. The hero's: the session waiting
// for permission (tabs, its bar, the glowing transcript). One with x 0, y 0 includes the corner, where lights go.
const MOBILE: Record<string, { x: number; y: number; width: number; height: number }> = {
  overview: { x: 313, y: 45, width: 360, height: 320 },
  sessions: { x: 0, y: 45, width: 320, height: 400 },
  workspace: { x: 313, y: 45, width: 360, height: 400 },
  // The panel from the store's header down: the staged row, the folded mailer, the drawer with ✦'s message.
  changes: { x: 976, y: 90, width: 304, height: 564 },
  editor: { x: 640, y: 45, width: 336, height: 400 },
  // Taken while db-migration is the right pane (640–976): the pill is as wide as the pane.
  dictation: { x: 640, y: 470, width: 336, height: 300 },
  // Taken while the Background pane is 360 wide (920–1280): its items as pills above the details, down to the output.
  background: { x: 920, y: 120, width: 360, height: 546 },
  alive: { x: 0, y: 0, width: 360, height: 460 },
  // The pane's header, the container's state and its live stats.
  docker: { x: 640, y: 45, width: 360, height: 400 },
  // Taken while the Redis pane is 360 wide (920–1280): the failed job's error and its bar.
  redis: { x: 920, y: 358, width: 360, height: 416 },
  // Taken while the orders tab is 360 wide (920–1280): from the filter bar (the breadcrumb above is cut that narrow), the
  // inspector over the grid, the newest order's fields and its customer's peek card, down to its total.
  databases: { x: 920, y: 130, width: 360, height: 376 },
  // The sheet's left side: Personal whole, then Work, picked, cut at the right — both names read (both cards need
  // 520 px, too wide to stay near real size on a phone).
  accounts: { x: 384, y: 76, width: 360, height: 180 },
  // The sheet's left side: its title, the prompt and the first presets.
  scheduled: { x: 340, y: 76, width: 360, height: 300 },
  // The runs, task and state (the worktree column starts past it), down to the line under the third.
  automations: { x: 326, y: 343, width: 330, height: 362 },
  // The panel from its facts down to the end of the Catch me up card, from the cards' left edge to the times and the
  // refresh (368 wide, so a phone draws it at 0.9× or more: the cards' right edges and the header's × fall outside).
  ask: { x: 888, y: 158, width: 368, height: 599 }
};

// Shots the site replays live (the waiting pane's breathing hairline) and the animations each must contain.
const LIVE: Record<string, SpotKind[]> = { overview: ['glow'] };

/** Where the app animates something, measured in the window (CSS px). */
async function measureSpots(win: Page): Promise<MeasuredSpot[]> {
  return win.evaluate((selectors) => Object.entries(selectors).flatMap(([kind, selector]) =>
    [...document.querySelectorAll(selector)].map((el) => {
      const b = el.getBoundingClientRect();
      // The waiting glow is drawn 6 px inside its pane (layout.css: inset 6px, --radius).
      const inset = kind === 'glow' ? 6 : 0;
      const r = kind === 'glow' ? 10 : getComputedStyle(el).borderTopLeftRadius;
      return { kind, x: b.x + inset, y: b.y + inset, w: b.width - 2 * inset, h: b.height - 2 * inset, r };
    })), LIVE_SELECTORS) as Promise<MeasuredSpot[]>;
}

/**
 * Takes one shot into `shots` (written to disk only when every shot passed, so a failure never leaves old and new
 * PNGs mixed). Fails when the staged UI is not on screen or the window shows anything real (text, tooltips, labels,
 * input values). Waits for Changes to list the four edited files first: in a window that never has focus it catches
 * up with a delay. The app's animations are frozen on their first frame (no half-drawn pulse baked into the image);
 * for live shots, where they run is saved next to the PNG. `only`: just the desktop shot or just the phone crop, when
 * each needs the window staged differently. `changes: false`: the Changes panel is hidden for this shot (the check
 * already passed for the earlier ones).
 */
async function shot(win: Page, shots: Map<string, Buffer>, name: string, staged: Locator, only?: 'desktop' | 'phone', changes = true) {
  if (changes) await expect(win.locator('.changes-body')).toContainText('4 files', { timeout: 90000 });
  await expect(staged, `"${name}": the staged UI is on screen`).toBeVisible({ timeout: 20000 });
  // A notification that arrived while staging (a session finishing) would put a count on the bell: read it.
  if (await win.locator('.bell-count').count()) {
    await win.locator('.bell-btn').click();
    await win.getByRole('button', { name: 'Mark all as read' }).click();
    await win.locator('.bell-btn').click();
    await expect(win.locator('.bell-btn')).toHaveAttribute('aria-expanded', 'false');
    await expect(win.locator('.bell-count')).toHaveCount(0);
  }
  // No caret and no hover: editors draw no cursor in a shot, a focused button gives up the keyboard (no ring), and the
  // pointer rests in the window's corner, off the sidebar rows (whose pin and close show on hover).
  await win.evaluate(() => {
    if (!document.getElementById('shots-no-caret')) {
      const style = Object.assign(document.createElement('style'), { id: 'shots-no-caret', textContent: '.cm-cursorLayer { display: none !important; } input, textarea { caret-color: transparent !important; }' });
      document.head.append(style);
    }
    const a = document.activeElement;
    if (a instanceof HTMLElement && a.tagName === 'BUTTON') a.blur();
  });
  await win.mouse.move(WINDOW.width - 2, WINDOW.height - 2);
  await win.waitForTimeout(800); // transitions settle
  // The pointer rests where the last click left it: no tooltip of whatever it is on (a wheel hides it, Tooltip.tsx).
  await win.evaluate(() => document.dispatchEvent(new WheelEvent('wheel')));
  await expect(win.locator('.tooltip'), `"${name}": no tooltip in the shot`).toHaveCount(0);
  // Lasting animations (the site replays the live ones) are frozen on their first frame; finite ones (the attention
  // cues and entrances) are finished, so the shot shows their rest state. An entrance on its
  // first frame is invisible, which once emptied the whole sidebar.
  await win.evaluate(() => document.getAnimations().forEach((a) => {
    if (a.effect?.getTiming().iterations === Infinity) { a.pause(); a.currentTime = 0; } else a.finish();
  }));
  // Playwright calls an element at opacity 0 visible: check the staged UI is really drawn.
  expect(await staged.evaluate((el) => { for (let e: Element | null = el; e; e = e.parentElement) if (getComputedStyle(e).opacity === '0') return false; return true; }),
    `"${name}": the staged UI is drawn (no ancestor at opacity 0)`).toBe(true);
  const text = await win.evaluate(() => [
    document.body.innerText,
    ...[...document.querySelectorAll('[title],[aria-label]')].map((e) => `${e.getAttribute('title') ?? ''} ${e.getAttribute('aria-label') ?? ''}`),
    ...[...document.querySelectorAll('input,textarea')].map((e) => (e as HTMLInputElement).value)
  ].join(' '));
  const banned = findBanned(text, [...SENSITIVE, ...SHOTS_ONLY]);
  // Where it is: the text around the first hit, so the element can be found without rerunning blind.
  const around = banned.length ? (() => { const i = text.indexOf(banned[0]!); return text.slice(Math.max(0, i - 120), i + 160).replace(/\s+/g, ' '); })() : '';
  expect(banned, `banned text in shot "${name}"${around ? `: …${around}…` : ''}`).toEqual([]);
  // SHOTS_DEBUG=<folder>: the whole window too, to check the staging around each crop.
  if (process.env.SHOTS_DEBUG) await win.screenshot({ path: join(process.env.SHOTS_DEBUG, `${name}${only ? `-${only}` : ''}-window.png`) });
  const clip = CLIPS[name];
  const phone = MOBILE[name];
  if (phone && only !== 'desktop') shots.set(`${name}.mobile.png`, await win.screenshot({ clip: phone }));
  if (only === 'phone') return void await win.evaluate(() => document.getAnimations().forEach((a) => { if (a.playState === 'paused') a.play(); }));
  const png = await win.screenshot(clip ? { clip } : {});
  expect(png.readUInt32BE(16), `"${name}" must be 2×`).toBe((clip?.width ?? WINDOW.width) * 2);
  shots.set(`${name}.png`, png);
  if (LIVE[name]) {
    const live = liveSpots(await measureSpots(win), clip ?? { x: 0, y: 0, ...WINDOW });
    for (const kind of LIVE[name]) expect(live.spots.some((s) => s.kind === kind), `"${name}": a live ${kind} is in the shot`).toBe(true);
    shots.set(`${name}.live.json`, Buffer.from(JSON.stringify(live, null, 2) + '\n'));
  }
  await win.evaluate(() => document.getAnimations().forEach((a) => { if (a.playState === 'paused') a.play(); }));
  if (ONLY?.every((n) => shots.has(`${n}.png`) && (!MOBILE[n] || shots.has(`${n}.mobile.png`)))) throw new AllTaken();
}

test('website screenshots', async () => {
  test.setTimeout(300000);
  mkdirSync(OUT, { recursive: true });
  chmodSync(resolve('tests/e2e/fake-claude-demo.pl'), 0o755);
  const fakeHome = mkdtempSync(join(tmpdir(), 'atl-shots-home-'));
  const project = makeDemoProject(fakeHome);
  const dockerSocket = join(mkdtempSync(join(tmpdir(), 'dk-')), 'd.sock');
  // The demo Claude (Perl) reads the world's scenarios as JSON; the TS module stays their one source.
  // Each with the limits of the Claude account it runs as (world/accounts.ts), which the demo Claude reports.
  const scenarios = join(mkdtempSync(join(tmpdir(), 'atl-shots-scenarios-')), 'scenarios.json');
  writeFileSync(scenarios, JSON.stringify(Object.fromEntries(SESSIONS.map((n) => {
    const { limits } = scenarioAccount(SCENARIOS[n]);
    return [n, { ...SCENARIOS[n], limits: [limits.fiveHour, limits.sevenDay] }];
  }))));
  // Redis: a fake on a free port, the only one the app may contact. Without it the app would probe
  // the Mac's own Redis (6379, also the fake Docker stack's published port).
  const redis = await FakeRedis.start({ version: '8.4.0' });
  acmeStore(redis);
  // Postgres: the live demo's database (src/demo/world/databases.ts) in the test
  // Postgres on a free port, saved before the first shot: the view looks for nothing, so the Mac's own
  // 5432 is never contacted.
  const postgres = await startDemoPostgres(Date.now());
  // Ask's own `claude -p`: the fake, playing the demo world's script (written when the Ask shot starts).
  const askScriptFile = join(mkdtempSync(join(tmpdir(), 'atl-shots-ask-')), 'ask.json');
  const { env, home } = e2eEnv({
    HOME: fakeHome,
    // Claude's default config dir in the fake home (~/.claude), next to the Work account's (~/.claude-work).
    ATELIER_TEST_CLAUDE_HOME: fakeHome,
    ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude-demo.pl'),
    ATELIER_DEMO_SCENARIOS: scenarios,
    ATELIER_TEST_FAKE_MIC: resolve('tests/fixtures/dictation-it.wav'),
    ATELIER_TEST_WHISPER_BIN: resolve('tests/fixtures/fake-whisper.mjs'),
    // The Docker shot's fake engine (started only for it) is found within half a second.
    ATELIER_TEST_DOCKER_SOCKET: dockerSocket,
    ATELIER_TEST_DOCKER_PROBE_MS: '500',
    ATELIER_TEST_REDIS_PORTS: String(redis.port),
    ATELIER_TEST_REDIS_PROBE_MS: '500',
    FAKE_WHISPER_TEXT: 'existing orders default to paid',
    // ✦ in the commit drawer: never the real claude.
    ATELIER_TEST_MESSAGE_CLAUDE: resolve('tests/e2e/fake-claude-message.mjs'),
    ATELIER_TEST_MESSAGE_TEXT: COMMIT_MESSAGE,
    ATELIER_TEST_COMPANION_CLAUDE: resolve('tests/e2e/fake-claude-ask.mjs'),
    ATELIER_TEST_COMPANION_SCRIPT: askScriptFile
  });
  // Dictation on, with the fake model already in place (as tests/e2e/dictation.spec.ts does).
  const spec = { file: 'm.bin', url: 'http://127.0.0.1:9/m.bin', size: 3, sha256: 'a'.repeat(64) };
  env.ATELIER_TEST_MODEL_SPEC = JSON.stringify(spec);
  mkdirSync(join(home, 'models'));
  writeFileSync(join(home, 'models', 'm.bin'), 'abc');
  writeFileSync(join(home, 'models', 'm.bin.ok'), spec.sha256);
  // The world's two Claude accounts, Personal and Work. Ask's settings spelled out
  // (Settings › Ask): the shot presses Catch me up itself, whatever the default.
  const ask = { askModel: 'sonnet', askAccount: 'session', askCatchUpOnOpen: false, askAnswers: 'short', askKnown: '' };
  writeFileSync(join(home, 'preferences.json'), JSON.stringify({ dictationEnabled: true, showServices: true, automationsEnabled: true, claudeAccounts: claudeAccountsAt(fakeHome), ...ask }));
  // Claude Code's temp and projects roots (e2eEnv's, in the temporary home), where the demo Claude writes its
  // background work's output and transcripts for the Background tab.
  mkdirSync(env.ATELIER_TEST_CLAUDE_TMP!, { recursive: true });
  mkdirSync(env.ATELIER_TEST_CLAUDE_PROJECTS!, { recursive: true });

  const shots = new Map<string, Buffer>();
  /** Writes the shots taken (only SITE_SHOTS' when set), once every one of them passed. */
  const save = () => {
    const missing = (ONLY ?? []).filter((n) => !shots.has(`${n}.png`));
    expect(missing, 'SITE_SHOTS names shots that were not taken').toEqual([]);
    for (const [file, data] of shots) if (!ONLY || ONLY.includes(file.slice(0, file.indexOf('.')))) writeFileSync(join(OUT, file), data);
  };
  // Docker: a fake engine with the demo project's compose stack, all healthy, for the whole run: the
  // whale is in the activity bar of every shot, as for anyone with Docker, without a failure dot.
  const docker = await FakeDocker.start(dockerSocket);
  stageDocker(docker, project, Date.now(), { healthy: true });
  // The Redis icon is in every shot too (the stack has a Redis); email-queue's failed jobs only for the Redis shot, so
  // the other shots' footer shows a healthy Redis.
  const failedJobs = redis.get('bull:email-queue:failed')!;
  redis.db(0).delete('bull:email-queue:failed');
  let { app, win } = await launch(env, project);
  let clickup: { close(): void } | null = null;
  try {
    await expect(win.locator('.activity-bar .act-docker')).toBeVisible({ timeout: 20000 });
    // The store's Postgres saved before the first shot, so the Databases icon is in the activity bar of every shot, the
    // hero's included, as in the live demo. With none saved,
    // Auto hides it; saved, it stays across the relaunch below.
    const dbId = await saveDemoDatabase(win, postgres.port, project);
    await expect(dbIcon(win)).toBeVisible({ timeout: 20000 });
    for (const name of SESSIONS) await newSession(win, name);
    // onboarding-copy is done and seen (Idle, as in the hero): it finishes either while in front or just after the next
    // session took its place (then unread, "Ready for review"), so once it is done it is looked at, whichever happened.
    const stateOf = (title: string) => win.evaluate(async (t) => (await (window as unknown as { atelier: { terminals: { list(): Promise<{ title: string; session?: { state: string } | null }[]> } } }).atelier.terminals.list()).find((x) => x.title === t)?.session?.state, title);
    await expect.poll(() => stateOf('onboarding-copy'), { timeout: 20000 }).toBe('done');
    await win.locator('.session-row', { hasText: 'onboarding-copy' }).click();
    await win.locator('.session-row', { hasText: 'auth-refactor' }).click();
    await expect(win.locator('.inbox-head.is-review')).toHaveCount(0, { timeout: 10000 });
    await shot(win, shots, 'overview', win.locator('.inbox-head.is-needs'));   // hero: the waiting one in front

    await shot(win, shots, 'sessions', win.locator('.inbox-head.is-needs'));   // the sidebar's states, up close

    // Ask: Changes hidden, so the panel docks beside the session's terminal; a taller window
    // (ASK_WINDOW), so the whole Catch me up card sits under the needs-you card. Catch me up from the empty state's
    // button; the card is the demo world's (src/demo/world/ask.ts).
    {
      await menu(app, 'View', 'Changes');
      await expect(win.locator('.changes-body')).toHaveCount(0);
      await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0]!.setContentSize(s.width, s.height), ASK_WINDOW);
      await win.locator('.session-row', { hasText: ASK_SHOT.session }).click();
      type Terms = { terminals: { list(): Promise<{ title: string; cwd: string; session?: { sessionId: string; cwd?: string | null } | null }[]> } };
      const term = await win.evaluate(async (t) => (await (window as unknown as { atelier: Terms }).atelier.terminals.list()).find((x) => x.title === t)!, ASK_SHOT.session);
      const at = Date.now() - 60_000;
      writeChat(env.ATELIER_TEST_CLAUDE_PROJECTS!, term.session!.cwd ?? term.cwd, term.session!.sessionId, SCENARIOS[ASK_SHOT.session].prompt, at);
      writeFileSync(askScriptFile, askScript(at));
      await menu(app, 'View', 'Ask About This Session');
      const panel = win.getByRole('complementary', { name: `Ask about ${ASK_SHOT.session}` });
      await expect(panel).toHaveClass(/is-dock/);
      await panel.locator('.ask-empty').getByRole('button', { name: 'Catch me up' }).click();
      const card = panel.getByRole('region', { name: 'Catch me up' });
      await expect(card).toBeVisible({ timeout: 20000 });
      await expect(card.locator('.ask-pt')).toHaveCount(2);
      await expect(panel.locator('.ask-needs')).toBeVisible();
      // The card whole, from its header to its source line, never scrolled under the needs-you card.
      expect(await panel.locator('.ask-thread').evaluate((el) => el.scrollTop === 0 && el.scrollHeight <= el.clientHeight)).toBe(true);
      if (process.env.SHOTS_DEBUG) await win.screenshot({ path: join(process.env.SHOTS_DEBUG, 'ask-full.png') });
      await shot(win, shots, 'ask', card.locator('.ask-src'), undefined, false);
      // As before for the next shot: Ask closed, the usual window, Changes shown, auth-refactor in front.
      await menu(app, 'View', 'Ask About This Session');
      await expect(panel).toBeHidden();
      await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0]!.setContentSize(s.width, s.height), WINDOW);
      await menu(app, 'View', 'Changes');
      await expect(win.locator('.changes-body')).toBeVisible();
      await win.locator('.session-row', { hasText: 'auth-refactor' }).click();
    }

    await openFile(win, 'invoice', 'invoice.ts', true);  // split: session | file
    await shot(win, shots, 'workspace', win.locator('.workspace-body > .pane-frame').nth(1));
    // The right pane starts where the 640-wide crops of Changes and the editor do (x 640): no sliver of the left one.
    await rightPaneAt(win, 640);

    await win.locator('.session-row', { hasText: 'onboarding-copy' }).click();
    await expect(win.locator('.changes-body')).toContainText('welcome.tsx', { timeout: 90000 });
    await win.locator('.changes-body').getByText('welcome.tsx').click();   // its diff, next to the session

    // A session's row brings it forward in its own pane, the left one: the file opens in the
    // right pane once it has the focus.
    await focusPane(win, 1);
    await openFile(win, 'session', 'session.ts');
    await expect(win.locator('.pane-strip[data-pane="1"] .tab.is-active')).toContainText('session.ts');
    // invoice.ts (the workspace shot's) closed with a middle click: the pane's strip holds session.ts alone, not scrolled.
    await win.locator('.pane-strip[data-pane="1"] .tab', { hasText: 'invoice.ts' }).click({ button: 'middle' });
    await expect(win.locator('.pane-strip[data-pane="1"] .tab')).toHaveCount(1);
    await shot(win, shots, 'editor', win.locator('.cm-content', { hasText: 'SKEW_MS' }));

    // db-migration to the right pane: its row brings it forward on the left, ⌥-click on its tab moves it right.
    await win.locator('.session-row', { hasText: 'db-migration' }).click();
    await win.locator('.pane-strip[data-pane="0"] .tab', { hasText: 'db-migration' }).click({ modifiers: ['Alt'] });
    await expect(win.locator('.pane-strip[data-pane="1"] .tab.is-active')).toContainText('db-migration');
    const pill = win.locator('.dictation-pill');
    // The phone crop: db-migration in the right pane, the pill as wide as it. Esc cancels (no text reaches Claude).
    await win.keyboard.down('Alt'); await win.keyboard.down('Space');
    await shot(win, shots, 'dictation', pill, 'phone');
    await win.keyboard.press('Escape');
    await win.keyboard.up('Space'); await win.keyboard.up('Alt');
    await expect(pill).toHaveCount(0);
    // Unsplit (the left pane's ×: its tabs join the right one, nothing closes): db-migration alone, the pill centred under it.
    await win.locator('.pane-strip[data-pane="0"] .pane-close').click();
    await expect(win.locator('.pane-divider')).toHaveCount(0);
    await win.keyboard.down('Alt'); await win.keyboard.down('Space');
    await shot(win, shots, 'dictation', pill, 'desktop');
    await win.keyboard.up('Space'); await win.keyboard.up('Alt');
    await expect(pill).toHaveCount(0, { timeout: 20000 });

    // Background: billing-tests' work chip → popover → its test run, opened beside the
    // session. Changes hidden, the workspace reaches the window's edge: the Background pane from x 640 is 640 wide,
    // its list beside the details. The phone crop first, the pane 360 wide (its items as pills).
    await menu(app, 'View', 'Changes');
    await expect(win.locator('.changes-body')).toHaveCount(0);
    await win.locator('.session-row', { hasText: 'billing-tests' }).click();
    const chip = win.locator('.session-bar .work-chip');
    await expect(chip).toContainText('2 agents · 1 shell', { timeout: 20000 });
    await chip.click();
    await win.getByRole('dialog', { name: 'Background' }).locator('.bgp-row', { hasText: 'Run billing tests' }).click();
    const bgv = win.locator('.bgv');
    await expect(bgv.locator('.bgv-log')).toContainText('rounds half up on x.xx5', { timeout: 20000 });
    await rightPaneAt(win, 920);
    await shot(win, shots, 'background', bgv.locator('.bgv-pills'), 'phone', false);
    await rightPaneAt(win, 640);
    await shot(win, shots, 'background', bgv.locator('.bgv-list'), 'desktop', false);
    // As before for the next shot: the Background tab closed, one pane, Changes shown, db-migration in front.
    await bgv.locator('.bgv-head').click();
    await menu(app, 'File', 'Close Tab');
    await expect(bgv).toHaveCount(0);
    await menu(app, 'View', 'Unsplit All');
    await expect(win.locator('.pane-divider')).toHaveCount(0);
    await menu(app, 'View', 'Changes');
    await expect(win.locator('.changes-body')).toBeVisible();
    await win.locator('.session-row', { hasText: 'db-migration' }).click();

    // Docker: the api's logs beside the engine overview, in the Docker space; auth-refactor selected
    // in Sessions: the lines go to it.
    {
      await menu(app, 'View', 'Changes');
      await expect(win.locator('.changes-body')).toHaveCount(0);
      await win.locator('.session-row', { hasText: 'auth-refactor' }).click();
      await expect(win.locator('.activity-bar .act-docker')).toBeVisible({ timeout: 20000 });
      // Entered with no tab, Docker opens its Overview; the api's tab goes to its side (⌥-click), the right pane from x 640.
      await win.locator('.activity-bar .act-docker').click();
      await win.locator('.dk-row', { hasText: 'api' }).first().click();
      await win.locator('.tab', { has: win.locator('.tab-name', { hasText: /^api$/ }) }).click({ modifiers: ['Alt'] });
      await rightPaneAt(win, 640);
      // The left pane is in neither crop. Its Overview names the fake engine's socket and the project's folder: temporary
      // paths the privacy guard refuses (the app shortens only /Users/<name>/… to ~). Postgres's logs take its place.
      await focusPane(win, 0);
      await win.locator('.dk-row', { has: win.locator('.dk-row-title', { hasText: /^postgres$/ }) }).first().click();
      await expect(win.locator('.pane-strip[data-pane="0"] .tab[aria-selected="true"] .tab-name')).toHaveText('postgres');
      // The api's logs (the right pane): the one logs view with its failed mail line.
      const api = win.locator('.dk-logs', { has: win.locator('.dk-ln', { hasText: 'mail send failed' }) });
      const last = api.locator('.dk-ln', { hasText: 'mail send failed' });
      await expect(last).toBeVisible({ timeout: 20000 });
      await expect(win.locator('.dk-stat').first().locator('.dk-stat-v')).toHaveText(/%$/, { timeout: 20000 });
      await win.waitForTimeout(6000); // a few seconds of stats for the sparklines
      // On the time column (a frame's text ends with its "open the file" button); ⌘ picks a second line.
      await api.locator('.dk-ln', { hasText: 'unhandled rejection' }).click({ position: { x: 40, y: 8 } });
      await last.click({ position: { x: 40, y: 8 }, modifiers: ['Meta'] });
      await expect(api.locator('.dk-selbar')).toContainText('Send to auth-refactor');
      await expect(api.locator('.dk-live')).toContainText('Live');
      await shot(win, shots, 'docker', api.locator('.dk-selbar'), undefined, false);
      // As before for the next shot: the Docker tabs closed, one pane, Changes shown, the Sessions view.
      await win.keyboard.press('Escape');
      await menu(app, 'File', 'Close Tab');
      await menu(app, 'View', 'Unsplit All');
      await expect(win.locator('.pane-divider')).toHaveCount(0);
      await menu(app, 'File', 'Close Tab');
      await win.locator('.activity-bar .act').first().click();
      await menu(app, 'View', 'Changes');
    }

    // Redis: email-queue's failed jobs beside auth-refactor (selected: Ask Claude and Send go to it).
    {
      redis.put('bull:email-queue:failed', failedJobs);
      await menu(app, 'View', 'Changes');
      await expect(win.locator('.changes-body')).toHaveCount(0);
      await win.locator('.session-row', { hasText: 'auth-refactor' }).click();
      // Entered with no tab, Redis opens Keys; Queues goes to its side (⌥-click on its tab). The phone crop first, the
      // pane 360 wide.
      await win.locator('.activity-bar .act[aria-label^="Redis"]').click();
      await win.locator('.rd-row', { hasText: 'email-queue' }).click();
      await expect(win.locator('.rd-jrow:not(.is-head)')).toHaveCount(3, { timeout: 20000 });
      await win.locator('.tab', { has: win.locator('.tab-name', { hasText: /^Queues$/ }) }).click({ modifiers: ['Alt'] });
      await rightPaneAt(win, 920);
      await shot(win, shots, 'redis', win.getByRole('button', { name: 'Ask Claude Why It Failed' }), 'phone', false);
      await rightPaneAt(win, 640);
      await win.screenshot({ path: process.env.SHOTS_DEBUG ? join(process.env.SHOTS_DEBUG, 'redis-full.png') : join(tmpdir(), 'unused.png') });
      await shot(win, shots, 'redis', win.getByRole('button', { name: 'Ask Claude Why It Failed' }), 'desktop', false);
      // As before for the next shot: no failed jobs, the Redis tabs closed, one pane, Changes shown, the Sessions view.
      redis.db(0).delete('bull:email-queue:failed');
      await win.locator('.rd-view[data-view="queues"] .dk-head').click();
      await menu(app, 'File', 'Close Tab');
      await menu(app, 'View', 'Unsplit All');
      await expect(win.locator('.pane-divider')).toHaveCount(0);
      await menu(app, 'File', 'Close Tab');
      await expect(win.locator('.rd-view')).toHaveCount(0);
      await win.locator('.activity-bar .act').first().click();
      await menu(app, 'View', 'Changes');
    }

    // Databases: the acme-store's Postgres (saved at the start), its orders newest first beside auth-refactor (selected:
    // Send to goes to it), the inspector on the Redis world's newest order (10442) with its customer's peek card.
    {
      await win.evaluate((id) => (window as unknown as { atelier: Dbs }).atelier.databases.select(id), dbId);
      await menu(app, 'View', 'Changes');
      await expect(win.locator('.changes-body')).toHaveCount(0);
      await win.locator('.session-row', { hasText: 'auth-refactor' }).click();
      // In the Databases space: customers, then orders to its side (⌥-click on its tab), the right pane
      // from x 640.
      await dbIcon(win).click();
      await expect(relRow(win, 'orders')).toBeVisible({ timeout: 20000 });
      await relRow(win, 'customers').dblclick();
      await expect(tabOf(win, 'customers')).toHaveClass(/is-active/);
      await relRow(win, 'orders').dblclick();
      await expect(tabOf(win, 'orders')).toHaveClass(/is-active/);
      await tabOf(win, 'orders').click({ modifiers: ['Alt'] });
      await rightPaneAt(win, 640);
      const t = front(win);
      await expect(await cell(t, 0, 'id')).toHaveText('10103', { timeout: 20000 });
      // Newest first: the id header twice (ascending, then descending).
      for (const dir of ['ascending', 'descending']) {
        await header(t, 'id').locator('.dbt-th-btn').click();
        await expect(header(t, 'id')).toHaveAttribute('aria-sort', dir);
      }
      await expect(await cell(t, 0, 'id')).toHaveText('10442', { timeout: 20000 });
      // The id column was sized before the sort: its arrow cuts the name ("i."). Fitted, as a double click on its edge does.
      await header(t, 'id').locator('.dbt-th-rs').dblclick();
      await expect.poll(() => header(t, 'id').locator('.dbt-th-name').evaluate((el) => el.scrollWidth <= el.clientWidth), { timeout: 5000 }).toBe(true);
      await (await cell(t, 0, 'status')).click();
      await win.keyboard.press('Enter');
      const insp = t.locator('.dbi');
      await expect(insp.locator('.dbi-key')).toHaveText('10442');
      const peek = insp.locator('.dbi-f', { has: win.locator('.dbi-fn-t', { hasText: /^customer_id$/ }) }).locator('.dbi-peek');
      await expect(peek.locator('.dbi-peek-label')).toHaveText('Marco Rossi', { timeout: 20000 });
      // The phone crop first, the pane 360 wide: the inspector over the grid.
      await rightPaneAt(win, 920);
      await expect(insp).toHaveClass(/is-over/);
      if (process.env.SHOTS_DEBUG) await win.screenshot({ path: join(process.env.SHOTS_DEBUG, 'databases-phone-full.png') });
      await shot(win, shots, 'databases', peek.locator('.dbi-peek-label'), 'phone', false);
      await rightPaneAt(win, 640);
      await expect(insp).not.toHaveClass(/is-over/);
      if (process.env.SHOTS_DEBUG) await win.screenshot({ path: join(process.env.SHOTS_DEBUG, 'databases-full.png') });
      await shot(win, shots, 'databases', peek.locator('.dbi-peek-label'), 'desktop', false);
      // As before for the next shot: the tab closed, one pane, Changes shown, the Sessions view; the connection stays
      // saved, so its icon is in the next shots too.
      await t.locator('.dbt-crumb').click();
      await menu(app, 'File', 'Close Tab');
      await expect(tabOf(win, 'orders')).toHaveCount(0);
      await menu(app, 'View', 'Unsplit All');
      await expect(win.locator('.pane-divider')).toHaveCount(0);
      await win.locator('.activity-bar .act').first().click();
      await menu(app, 'View', 'Changes');
      await expect(dbIcon(win), 'the Databases icon in the shots after this one').toBeVisible();
    }

    // Git writes (the Changes shot, at the end): a second repository in the project, the store's mailer, discovered when
    // the app opens again. The store ignores its folder; both commit as the world's author (repo-local identity: the
    // app's git never reads a global config here).
    const mailer = join(project, 'plugins', 'mailer');
    appendFileSync(join(project, '.git', 'info', 'exclude'), 'plugins/\n');
    mkdirSync(join(mailer, 'templates'), { recursive: true });
    writeFileSync(join(mailer, 'templates', 'welcome.html'), MAILER_BEFORE);
    for (const [dir, ...a] of [[mailer, 'init', '-q', '-b', 'main'], [mailer, 'add', '-A'], [mailer, 'commit', '-q', '-m', 'Add the welcome email']] as const) gitIn(dir, ...a);
    for (const dir of [project, mailer]) { gitIn(dir, 'config', 'user.name', AUTHOR.name); gitIn(dir, 'config', 'user.email', AUTHOR.email); }

    // Always alive: quit the app (atelierd keeps the sessions), reopen it, the same sessions are still there.
    await app.close();
    ({ app, win } = await launch(env, project));
    for (const name of SESSIONS) await expect(win.locator('.session-row', { hasText: name })).toBeVisible({ timeout: 20000 });
    await expect(win.locator('.activity-bar .act-docker')).toBeVisible({ timeout: 20000 });
    await shot(win, shots, 'alive', win.locator('.session-row', { hasText: 'docs' }));

    // Claude accounts: the New Session sheet, both accounts with their limits, Tab on Work; behind it docs, which runs
    // as Work (its transcript under the sheet, the meter on Work).
    await win.locator('.session-row', { hasText: 'docs' }).click();
    await expect(win.locator('.usage-dir')).toHaveText('Work', { timeout: 20000 });
    await win.locator('.btn-new').click();
    await win.getByRole('menuitem', { name: 'Claude Session' }).click();
    await win.getByPlaceholder('Session name (optional)').fill('release-notes');
    await win.keyboard.press('Tab');
    const cards = win.locator('.new-session-accounts .acct-card');
    await expect(cards.nth(1)).toHaveAttribute('aria-checked', 'true');
    for (const i of [0, 1]) await expect(cards.nth(i).locator('.acct-usage')).toContainText('%', { timeout: 20000 });
    if (process.env.SHOTS_DEBUG) await win.screenshot({ path: join(process.env.SHOTS_DEBUG, 'accounts-full.png') });
    await shot(win, shots, 'accounts', cards.nth(1), undefined, false);
    await win.keyboard.press('Escape');

    // Scheduled prompts: the composer over docs (Work: its limits are known, so
    // "When usage resets" is offered), a prompt already set for later on its rail. Removed after the shot.
    {
      type Sched = { schedules: { add(o: { terminalId: string; text: string; at: number; ifBusy: 'wait' }): Promise<{ ok: boolean; prompt?: { id: string } }>; remove(id: string): Promise<unknown> } };
      type Terms = { terminals: { list(): Promise<{ id: string; title: string }[]> } };
      const docsId = await win.evaluate(async () => (await (window as unknown as { atelier: Terms }).atelier.terminals.list()).find((x) => x.title === 'docs')!.id);
      const later = await win.evaluate((id) => (window as unknown as { atelier: Sched }).atelier.schedules.add({ terminalId: id, text: 'Update the changelog for the release', at: Date.now() + 5 * 3600_000, ifBusy: 'wait' }), docsId);
      expect(later.ok, 'the prompt for later is scheduled').toBe(true);
      await expect(win.locator('.session-bar .sp-chip')).toBeVisible({ timeout: 10000 });
      await win.locator('.session-bar .sb-schedule').click();
      const sheet = win.getByRole('dialog', { name: 'Schedule a prompt' });
      await sheet.getByRole('textbox', { name: 'What should Claude do then?' }).fill('Finish the API reference: the refunds and webhooks pages, then open a draft pull request.');
      const reset = sheet.locator('.sp-preset.is-reset');
      await reset.click();
      await expect(reset).toHaveClass(/is-on/);
      if (process.env.SHOTS_DEBUG) await win.screenshot({ path: join(process.env.SHOTS_DEBUG, 'scheduled-full.png') });
      await shot(win, shots, 'scheduled', reset, undefined, false);
      await sheet.getByRole('button', { name: /^Cancel/ }).click();
      await expect(sheet).toHaveCount(0);
      await win.evaluate((id) => (window as unknown as { atelier: Sched }).atelier.schedules.remove(id), later.prompt!.id);
      await expect(win.locator('.session-bar .sp-chip')).toHaveCount(0, { timeout: 10000 });
    }

    // Changes: onboarding-copy's welcome.tsx staged from its context menu, the mailer's welcome
    // email staged from a terminal, the commit drawer open on the store (the mailer folded, the others line), the
    // message written by ✦ (the fake claude's, in the history's style). Next to the session-coloured rows, welcome.tsx's
    // diff in the right pane from x 640.
    {
      await expect(win.locator('.pane-divider')).toHaveCount(0);
      await openFile(win, 'invoice', 'invoice.ts', true);
      await rightPaneAt(win, 640);
      await win.locator('.session-row', { hasText: 'onboarding-copy' }).click();
      const panel = win.locator('.changes');
      const row = panel.locator('.change-row', { hasText: 'welcome.tsx' });
      await expect(row).toBeVisible({ timeout: 90000 });
      // Its diff tab is still in the left pane's strip (opened there for the editor shot), where a click brings it forward
      //: ⌥-click on its tab moves it to the right pane.
      await row.click();
      await win.locator('.pane-strip[data-pane="0"] .tab', { hasText: 'welcome.tsx' }).click({ modifiers: ['Alt'] });
      await expect(win.locator('.pane-strip[data-pane="1"] .tab.is-active')).toContainText('welcome.tsx');
      await expect(win.locator('.cm-content', { hasText: 'Good to see you' })).toBeVisible({ timeout: 20000 });
      writeFileSync(join(mailer, 'templates', 'welcome.html'), MAILER_AFTER);
      gitIn(mailer, 'add', 'templates/welcome.html');
      await row.click({ button: 'right' });
      await win.getByRole('menuitem', { name: 'Stage', exact: true }).click();
      await expect(panel.locator('.git-bar')).toContainText('in 2 repositories', { timeout: 20000 });
      // A shorter window: the drawer, pinned at the panel's bottom, sits right under the rows (no empty band between).
      await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0]!.setContentSize(s.width, s.height), GIT_WINDOW);
      await menu(app, 'Git', 'Commit…');
      const drawer = panel.locator('.git-drawer');
      await expect(drawer.locator('.git-chip')).toContainText('acme-store');
      await expect(drawer.locator('.git-others')).toBeVisible();
      await menu(app, 'Git', 'Write Commit Message with Claude');
      await expect(panel.getByRole('textbox', { name: 'Commit message' })).toHaveValue(COMMIT_MESSAGE, { timeout: 20000 });
      await expect(drawer.locator('.git-write-meta')).toContainText('Haiku');
      // The rows fit above the drawer: no scrollbar in the list.
      expect(await panel.locator('.changes-body').evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
      if (process.env.SHOTS_DEBUG) await win.screenshot({ path: join(process.env.SHOTS_DEBUG, 'changes-full.png') });
      await shot(win, shots, 'changes', drawer.locator('.git-write-meta'), undefined, false);
    }

    // Automations: the world's two rules and their runs (src/demo/world/automations.ts, as the live
    // demo plays them), written to the app's store while it is closed: the run at work is billing-tests, the one for
    // review onboarding-copy. A fake ClickUp is connected for this shot only, so the rule that is on reads On.
    {
      const terms = await win.evaluate(() => (window as unknown as { atelier: { terminals: { list(): Promise<{ id: string; title: string }[]> } } }).atelier.terminals.list());
      const ids = Object.fromEntries(terms.map((t) => [t.title, t.id]));
      await app.close();
      const dir = join(home, 'automations');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const world = worldAutomations(project, Date.now());
      writeFileSync(join(dir, 'automations.json'), JSON.stringify({ v: 1, automations: world.map((w) => w.automation) }), { mode: 0o600 });
      for (const w of world) {
        const runs = w.runs.map(({ session, ...r }) => (session ? { ...r, terminalId: ids[session] } : r));
        writeFileSync(join(dir, `${w.automation.id}.runs.json`), JSON.stringify({ v: 1, runs }), { mode: 0o600 });
      }
      const fake = await startFake();
      clickup = fake;
      ({ app, win } = await launch({ ...env, ATELIER_TEST_CLICKUP_URL: fake.url, ATELIER_TEST_FOLLOW_AUTH: '1' }, project));
      await expect(win.locator('.footer')).toBeVisible({ timeout: 20000 });
      await win.evaluate('window.atelier.connectors.connect("clickup")');
      await expect.poll(() => win.evaluate('window.atelier.connectors.list().then((r) => r.connectors[0] && r.connectors[0].status)'), { timeout: 20000 }).toBe('connected');
      // The Changes shot's split comes back with the window: one pane, so the view spans the workspace.
      await menu(app, 'View', 'Unsplit All');
      await expect(win.locator('.pane-divider')).toHaveCount(0);
      await win.locator('.session-row', { hasText: 'auth-refactor' }).click();
      await menu(app, 'View', 'Automations');
      const view = win.locator('.au-view');
      await expect(view).toContainText('ENG-142', { timeout: 20000 });
      // Each linked run reads its session's state: billing-tests at work, onboarding-copy done.
      await expect(view.getByText('Ready for review').first()).toBeVisible({ timeout: 20000 });
      await expect(view.locator('.au-chip', { hasText: 'On' }).first()).toBeVisible({ timeout: 20000 });
      if (process.env.SHOTS_DEBUG) await win.screenshot({ path: join(process.env.SHOTS_DEBUG, 'automations-full.png') });
      await shot(win, shots, 'automations', view.getByText('ENG-142').first(), undefined, false);
    }
    // Every shot passed: only now replace the committed ones.
    save();
  } catch (e) {
    if (!(e instanceof AllTaken)) throw e;
    save();
  } finally {
    clickup?.close();
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
    await docker.close();
    await redis.stop();
    await postgres.stop();
  }
});
