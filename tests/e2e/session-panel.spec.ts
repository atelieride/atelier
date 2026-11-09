import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Session panel with a fake Claude that logs every byte typed into it (fake-claude-keys.pl) and a fixture
// Claude home (ATELIER_TEST_CLAUDE_HOME): never the user's ~/.claude.

type Api = { terminals: { list(): Promise<{ id: string; title: string }[]>; input(id: string, data: string): void } };

const SECRETS = ['sk-e2e-ENV-SECRET', 'E2E-ARG-SECRET', 'Bearer E2E-HEADER-SECRET', 'https://e2e-url-secret.example/mcp'];

const put = (path: string, data: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data)); };

function fixtures(project: string): string {
  const claudeHome = mkdtempSync(join(tmpdir(), 'atl-claude-home-'));
  put(join(claudeHome, '.claude.json'), {
    mcpServers: {
      github: { command: 'npx', args: ['-y', SECRETS[1]], env: { GITHUB_TOKEN: SECRETS[0] } },
      linear: { type: 'http', url: SECRETS[3], headers: { Authorization: SECRETS[2] } }
    },
    projects: { [project]: { disabledMcpServers: ['linear'] } }
  });
  put(join(claudeHome, '.claude', 'settings.json'), { enabledPlugins: { 'review-tools@official': true, 'old-tool@official': false } });
  put(join(claudeHome, '.claude', 'skills', 'release-notes', 'SKILL.md'), '---\nname: release-notes\n---\n');
  put(join(project, '.mcp.json'), { mcpServers: { sentry: { type: 'http', url: 'https://mcp.sentry.dev/mcp' } } });
  return claudeHome;
}

async function launch(): Promise<{ app: ElectronApplication; home: string; keys: string; claudeHome: string }> {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const claudeHome = fixtures(project);
  const keysDir = mkdtempSync(join(tmpdir(), 'atl-keys-'));
  const keys = join(keysDir, 'keys.log');
  writeFileSync(keys, '');
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude-keys.pl'), ATELIER_TEST_CLAUDE_HOME: claudeHome, ATELIER_FAKE_KEYS_LOG: keys });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  return { app, home, keys, claudeHome };
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
  await expect(win.locator('.session-row', { hasText: name })).toHaveClass(/state-done/, { timeout: 20000 });
}

async function typeInto(win: Page, title: string, text: string) {
  await win.evaluate(async ({ title, text }) => {
    const api = (window as unknown as { atelier: Api }).atelier;
    api.terminals.input((await api.terminals.list()).find((x) => x.title === title)!.id, text);
  }, { title, text });
}

/** What Atelier typed into the fake Claude since `from` (the log's length before an action). */
const typedSince = (keys: string, from: number) => readFileSync(keys, 'latin1').slice(from);
const logLength = (keys: string) => readFileSync(keys, 'latin1').length;

test('Session panel: the model switch types exactly "/model opus\\r" when Claude waits at its prompt, and nothing while it works', async () => {
  const { app, home, keys } = await launch();
  try {
    const win = await app.firstWindow();
    await newSession(win, 'Panel');
    const chip = win.locator('.session-bar .sb-model');
    await expect(chip).toContainText('Opus 5.5', { timeout: 10000 });

    // The chip opens it; the current model is marked; Configured lists names and states from the fixture home only.
    await chip.click();
    const panel = win.getByRole('dialog', { name: /^Session: / });
    await expect(panel).toBeVisible();
    await expect(chip).toHaveAttribute('aria-expanded', 'true');
    const opus = panel.getByRole('button', { name: 'Opus', exact: true });
    await expect(opus).toHaveAttribute('aria-pressed', 'true');
    await expect(panel).toBeFocused();
    await expect(panel).toContainText('Default');
    await expect(panel.locator('.spanel-mode-value')).toHaveText('Default');
    const mcp = panel.getByRole('group', { name: 'MCP servers' });
    await expect(mcp.locator('.spanel-chip')).toHaveText(['github', 'linearoff', 'sentryneeds approval']);
    await expect(panel.getByRole('group', { name: 'Skills' })).toContainText('release-notes');
    await expect(panel.getByRole('group', { name: 'Plugins' }).locator('.spanel-chip')).toHaveText(['old-tool@officialoff', 'review-tools@official']);
    await expect(panel).toContainText('Servers added after the session started load when it restarts.');
    await expect(panel).not.toContainText('Couldn\'t read Claude Code\'s settings');
    const text = await panel.innerText();
    for (const s of SECRETS) expect(text).not.toContain(s);
    expect(text).not.toContain('mcp.sentry.dev');
    await look(win, 'test-results/session-panel-idle.png', { settle: 300 });

    // Arrow keys move between the models without choosing (choosing types into the session).
    const before = logLength(keys);
    await opus.focus();
    await win.keyboard.press('ArrowRight');
    await expect(panel.getByRole('button', { name: 'Sonnet', exact: true })).toBeFocused();
    await win.keyboard.press('ArrowLeft');
    await expect(opus).toBeFocused();
    await win.waitForTimeout(400);
    expect(typedSince(keys, before)).toBe('');

    // Opus: "/model opus" and its Enter, nothing else; the panel closes, the keyboard goes to the terminal.
    await opus.click();
    await expect(panel).toBeHidden();
    await expect.poll(() => typedSince(keys, before), { timeout: 10000 }).toBe('/model opus\r');
    await expect(win.locator('.terminal-slot:visible .xterm-rows')).toContainText('FAKE-CLAUDE submitted=/model opus');
    await expect(chip).toContainText('Opus', { timeout: 10000 });

    // Next mode: one Shift+Tab (ESC [ Z), no Enter; the mode Claude reports shows on the next open.
    await chip.click();
    let at = logLength(keys);
    await panel.getByRole('button', { name: /^Next mode/ }).click();
    await expect.poll(() => typedSince(keys, at), { timeout: 10000 }).toBe('\x1b[Z');
    await chip.click();
    await expect(panel.locator('.spanel-mode-value')).toHaveText('Accept edits', { timeout: 10000 });

    // Clear asks first; Escape steps back from the question, then closes the panel.
    at = logLength(keys);
    await panel.getByRole('button', { name: 'Clear…' }).click();
    await expect(panel.getByRole('alertdialog', { name: 'Clear this conversation?' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await look(panel, 'test-results/session-panel-clear.png');
    await win.keyboard.press('Escape');
    await expect(panel.getByRole('alertdialog')).toHaveCount(0);
    await expect(panel).toBeVisible();
    await win.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(chip).toBeFocused();
    expect(typedSince(keys, at)).toBe('');
    await chip.click();
    await panel.getByRole('button', { name: 'Clear…' }).click();
    await panel.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect.poll(() => typedSince(keys, at), { timeout: 10000 }).toBe('/clear\r');

    // Compact.
    await chip.click();
    at = logLength(keys);
    await panel.getByRole('button', { name: 'Compact' }).click();
    await expect.poll(() => typedSince(keys, at), { timeout: 10000 }).toBe('/compact\r');

    // Claude at work: every typing action is disabled with the reason, and nothing is typed.
    await typeInto(win, 'Panel', 'work\r');
    await expect(win.locator('.session-row', { hasText: 'Panel' })).toHaveClass(/state-running/, { timeout: 10000 });
    at = logLength(keys);
    // From the session's menu this time.
    await win.locator('.session-row', { hasText: 'Panel' }).click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Session Panel' }).click();
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('status')).toHaveText('Available when Claude is waiting for you');
    // One reason everywhere in the panel, Phone included.
    for (const name of ['Default', 'Opus', 'Sonnet', 'Haiku', 'Compact', 'Clear…', 'Phone']) {
      const b = panel.getByRole('button', { name, exact: true });
      await expect(b).toHaveAttribute('aria-disabled', 'true');
      await expect(b).toHaveAttribute('data-tip', 'Available when Claude is waiting for you');
    }
    await expect(panel.getByRole('button', { name: /^Next mode/ })).toHaveAttribute('aria-disabled', 'true');
    await panel.getByRole('button', { name: 'Sonnet', exact: true }).click({ force: true });
    await panel.getByRole('button', { name: /^Next mode/ }).click({ force: true });
    await expect(panel).toBeVisible();
    await win.waitForTimeout(800);
    expect(typedSince(keys, at)).toBe('');
    await panel.getByRole('button', { name: 'Haiku', exact: true }).hover();
    await expect(win.locator('.tooltip')).toHaveText('Available when Claude is waiting for you', { timeout: 5000 });
    // Disabled, the chosen model still reads: on the neutral chosen step its label takes
    // --text-3, never the white of a brand fill (light themes), and the segment dims as a whole; and
    // the quick actions stay inside the panel with Restart's longest label, in Aurora's face and in Docsy's wider one.
    await expect(panel.getByRole('button', { name: 'Restart When Done', exact: true })).toBeVisible();
    for (const theme of ['aurora', 'docsy']) {
      await win.evaluate((th) => (window as unknown as { atelier: { settings: { set(p: object): Promise<unknown> } } }).atelier.settings.set({ theme: th }), theme);
      await expect.poll(() => win.evaluate(() => document.documentElement.dataset.theme ?? 'aurora')).toBe(theme);
      await win.evaluate(() => document.fonts.ready);
      const on = panel.locator('.spanel-model.is-on');
      await expect(on).toHaveAttribute('aria-disabled', 'true');
      // Polled: the label's color transitions after the theme switch.
      await expect.poll(() => on.evaluate((el) => {
        const probe = document.createElement('i'); probe.style.color = 'var(--text-3)'; el.after(probe);
        const want = getComputedStyle(probe).color; probe.remove();
        return getComputedStyle(el).color === want;
      }), { message: theme }).toBe(true);
      const fit = await panel.locator('.spanel-actions').evaluate((g) => {
        const box = g.getBoundingClientRect();
        return [...g.children].map((b) => {
          const r = b.getBoundingClientRect(); const label = b.querySelector('span')!;
          return { name: label.textContent, inside: r.left >= box.left - 0.5 && r.right <= box.right + 0.5, whole: label.scrollWidth <= label.clientWidth + 0.5 };
        }).filter((x) => !x.inside || !x.whole);
      });
      expect(fit, theme).toEqual([]);
      await look(win.locator('.spanel'), `test-results/session-panel-working-${theme}.png`);
    }
    await win.evaluate(() => (window as unknown as { atelier: { settings: { set(p: object): Promise<unknown> } } }).atelier.settings.set({ theme: 'aurora' }));
    await look(win, 'test-results/session-panel-working.png');
    await win.keyboard.press('Escape');
    await expect(panel).toBeHidden();

    // Done again: from the palette, and enabled.
    await typeInto(win, 'Panel', 'stop\r');
    await expect(win.locator('.session-row', { hasText: 'Panel' })).toHaveClass(/state-done/, { timeout: 10000 });
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>session panel');
    await win.locator('.palette-item', { hasText: 'Session Panel' }).click();
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Haiku', exact: true })).not.toHaveAttribute('aria-disabled', 'true');
    // Tab stays inside the panel.
    for (let i = 0; i < 12; i++) await win.keyboard.press('Tab');
    expect(await win.evaluate(() => !!document.activeElement?.closest('.spanel'))).toBe(true);
    // A click outside closes it.
    await win.locator('.terminal-slot:visible').click({ position: { x: 40, y: 200 } });
    await expect(panel).toBeHidden();
  } finally {
    await stop(app, home);
  }
});

async function menu(app: ElectronApplication, label: string) {
  await app.evaluate(({ Menu, BrowserWindow }, l) => {
    const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const it of items) { if (it.label === l) return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
      return undefined;
    };
    walk(Menu.getApplicationMenu()!.items)!.click(undefined, BrowserWindow.getAllWindows()[0]);
  }, label);
}

test('Session panel: opens on itself (a held Enter chooses nothing), follows its chip, refuses over a draft, stays its own in split view, says when Claude Code\'s settings can\'t be read', async () => {
  const { app, home, keys, claudeHome } = await launch();
  try {
    const win = await app.firstWindow();
    await newSession(win, 'Panel');
    const chip = win.locator('.session-bar .sb-model');
    await expect(chip).toContainText('Opus 5.5', { timeout: 10000 });
    const panel = win.getByRole('dialog', { name: /^Session: / });
    const reason = panel.getByRole('status');

    // The first focus is the panel itself: an Enter still held from the menu or palette chooses nothing.
    const start = logLength(keys);
    await chip.click();
    await expect(panel).toBeFocused();
    await win.keyboard.press('Enter');
    await win.keyboard.press('Space');
    await win.waitForTimeout(600);
    expect(typedSince(keys, start)).toBe('');
    await expect(panel).toBeVisible();

    // It follows its chip when the bar's layout changes (Changes hidden: the bar is wider, the chip moves).
    const rightOf = (l: typeof chip) => l.evaluate((el) => el.getBoundingClientRect().right);
    const gap = async () => (await rightOf(panel)) - (await rightOf(chip));
    expect(Math.abs((await gap()) - 12)).toBeLessThan(2);
    const chipBefore = await rightOf(chip);
    await menu(app, 'Changes');
    await expect.poll(() => rightOf(chip)).not.toBe(chipBefore);
    await expect.poll(async () => Math.abs((await gap()) - 12) < 2).toBe(true);
    await menu(app, 'Changes');
    await win.keyboard.press('Escape');
    await expect(panel).toBeHidden();

    // A draft typed in Claude's prompt: every action that sends an Enter refuses, with the reason, and types nothing.
    const DRAFT = 'Send or clear your draft in Claude first (press Enter on an empty prompt).';
    const textarea = win.locator('.xterm-helper-textarea:visible').first();
    await textarea.focus();
    const typing = logLength(keys);
    await win.keyboard.type('half a thought');
    // The whole draft reaches Claude before the count starts (under load its last key came after it).
    await expect.poll(() => typedSince(keys, typing)).toContain('half a thought');
    const at = logLength(keys);
    await chip.click();
    await expect(reason).toHaveText(DRAFT);
    for (const name of ['Default', 'Opus', 'Sonnet', 'Haiku', 'Compact', 'Clear…']) {
      await expect(panel.getByRole('button', { name, exact: true })).toHaveAttribute('data-tip', DRAFT);
    }
    await panel.getByRole('button', { name: 'Sonnet', exact: true }).click({ force: true });
    await win.waitForTimeout(800);
    expect(typedSince(keys, at)).toBe('');
    await panel.getByRole('button', { name: 'Haiku', exact: true }).hover();
    await expect(win.locator('.tooltip')).toHaveText(DRAFT, { timeout: 5000 });
    await look(win, 'test-results/session-panel-draft.png');
    // Next mode sends no Enter: it stays available over a draft (a task's prompt → plan mode → send), and the draft stays.
    const next = panel.getByRole('button', { name: /^Next mode/ });
    await expect(next).not.toHaveAttribute('aria-disabled', 'true');
    await next.click();
    await expect(panel).toBeHidden();
    await expect.poll(() => typedSince(keys, at), { timeout: 10000 }).toBe('\x1b[Z');
    // Sent: available again, and the bytes go out as before.
    await textarea.focus();
    await win.keyboard.press('Enter');
    await expect(win.locator('.terminal-slot:visible .xterm-rows')).toContainText('FAKE-CLAUDE submitted=half a thought');
    await chip.click();
    await expect(reason).toHaveCount(0);
    const sent = logLength(keys);
    await panel.getByRole('button', { name: 'Haiku', exact: true }).click();
    // Typed while the command's Enter waits (the keyboard is the terminal's at once): after the Enter, never inside.
    await expect(textarea).toBeFocused();
    await win.keyboard.type('zz');
    await expect.poll(() => typedSince(keys, sent), { timeout: 10000 }).toBe('/model haiku\rzz');
    await expect(win.locator('.terminal-slot:visible .xterm-rows')).toContainText('FAKE-CLAUDE submitted=/model haiku');

    // A reload (as after an app restart: the session lives on in atelierd): what is in Claude's prompt is unknown, so it
    // counts as a draft until the user's first Enter there; Next mode still goes.
    await win.reload();
    await expect(win.locator('.footer')).toBeVisible({ timeout: 15000 });
    await win.locator('.session-row', { hasText: 'Panel' }).click();
    await expect(chip).toBeVisible({ timeout: 10000 });
    await chip.click();
    await expect(reason).toHaveText(DRAFT);
    await expect(panel.getByRole('button', { name: 'Opus', exact: true })).toHaveAttribute('aria-disabled', 'true');
    await expect(panel.getByRole('button', { name: 'Compact', exact: true })).toHaveAttribute('aria-disabled', 'true');
    await expect(next).not.toHaveAttribute('aria-disabled', 'true');
    await look(win, 'test-results/session-panel-restart.png', { settle: 300 });
    await win.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await textarea.focus();
    await win.keyboard.press('Enter');
    await expect(win.locator('.terminal-slot:visible .xterm-rows')).toContainText('FAKE-CLAUDE submitted=zz');
    await chip.click();
    await expect(reason).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Opus', exact: true })).not.toHaveAttribute('aria-disabled', 'true');
    await win.keyboard.press('Escape');
    await expect(panel).toBeHidden();

    // Split view: the session's bar heads a pane; a right-click in its panel is the panel's, not the pane header's.
    await menu(app, 'Split Right');
    await expect(win.locator('.workspace-body.is-split')).toBeVisible();
    await win.locator('.session-row', { hasText: 'Panel' }).click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Session Panel' }).click();
    await expect(panel).toBeVisible();
    await panel.locator('.spanel-label').first().click({ button: 'right' });
    await win.waitForTimeout(300);
    await expect(win.locator('.ctx-menu')).toHaveCount(0);
    await expect(panel).toBeVisible();
    await look(win, 'test-results/session-panel-split.png');
    await win.keyboard.press('Escape');
    await expect(panel).toBeHidden();

    // Claude Code's settings turn unreadable: the panel, read again when it opens, says so; the rest is still listed.
    put(join(claudeHome, '.claude', 'settings.json'), '{ "enabledPlugins": ');
    await win.locator('.session-row', { hasText: 'Panel' }).click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Session Panel' }).click();
    await expect(panel).toContainText('Couldn\'t read Claude Code\'s settings');
    await expect(panel.getByRole('group', { name: 'MCP servers' })).toContainText('github');
  } finally {
    await stop(app, home);
  }
});
