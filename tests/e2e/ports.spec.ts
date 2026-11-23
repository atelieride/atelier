import { _electron as electron, expect, test } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Listening ports: a terminal runs a node server on an ephemeral port (a child of its shell, as a dev
// server would be); the chip appears in its row, opens localhost through main (logged, never a real browser), follows
// the terminal when it becomes a Claude session (row and session bar), and goes away with the setting off.

type Api = { terminals: { list(): Promise<{ id: string }[]> }; ports: { open(id: string, port: number): Promise<boolean> } };

/** Animations off for screenshots that are looked at. */
const still = (win: import('@playwright/test').Page) => win.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });

test('ports: chip in the terminal row, opens localhost through main, follows into the session bar, setting off hides it', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const urlLog = join(mkdtempSync(join(tmpdir(), 'atl-url-')), 'urls.txt');
  // The ports hub scans every 500 ms instead of 4 s.
  const { env, home } = e2eEnv({ ATELIER_TEST_URL_LOG: urlLog, ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ATELIER_TEST_PORTS_POLL_MS: '500' });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  let nodePid = 0;
  try {
    const win = await app.firstWindow();
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(win.locator('.xterm-rows:visible')).toBeVisible({ timeout: 10000 });
    await win.locator('.xterm-helper-textarea:visible').focus();
    const text = () => win.locator('.xterm-rows:visible').evaluate((el) => el.textContent ?? '');
    // Typed before zsh draws its prompt (the Atelier prompt's ›), the first keys can be lost ("cho SHELLREADY").
    await expect.poll(text, { timeout: 15000 }).toContain('›');
    // The shell is ready once it ran a first command (the echo prints what the typed line does not contain).
    await win.keyboard.type('echo SHELL""READY\n');
    await expect.poll(text, { timeout: 15000 }).toContain('SHELLREADY');
    // A random non-ephemeral port (< 49152), as a dev server's: ephemeral ones are hidden by default.
    const server = "const go=()=>{const s=require('http').createServer(()=>{});s.on('error',go);s.listen(20000+Math.floor(Math.random()*25000),'127.0.0.1',()=>console.log('PORT='+s.address().port))};go()";
    // `$!` unquoted: in zsh `!"` would switch history expansion off and eat the closing quote.
    await win.keyboard.type(`'${process.execPath}' -e "${server}" & echo NODEPID=$!\n`);
    await expect.poll(async () => /PORT=(\d+)/.exec(await text())?.[1] ?? '', { timeout: 10000 }).not.toBe('');
    const port = Number(/PORT=(\d+)/.exec(await text())![1]);
    nodePid = Number(/NODEPID=(\d+)/.exec(await text())?.[1] ?? 0);

    // The terminal row: a chip ":<port>" at the hub's next scan.
    const termChip = win.locator('.term-row .port-chip', { hasText: `:${port}` });
    await expect(termChip).toBeVisible({ timeout: 10000 });
    await expect(termChip).toHaveAttribute('data-tip', `Open localhost:${port} · node`);
    await still(win);
    await look(win.locator('.sidebar'), 'test-results/ports-term-row.png');

    // Click: main opens http://localhost:<port>/ (logged by the test seam instead of a browser).
    await termChip.click();
    await expect.poll(() => (existsSync(urlLog) ? readFileSync(urlLog, 'utf8') : ''), { timeout: 5000 }).toContain(`http://localhost:${port}/`);
    // A port main does not list for that terminal is refused (the renderer cannot open arbitrary URLs).
    const refused = await win.evaluate(async () => {
      const api = (window as unknown as { atelier: Api }).atelier;
      const id = (await api.terminals.list())[0]!.id;
      return api.ports.open(id, 1);
    });
    expect(refused).toBe(false);
    expect(readFileSync(urlLog, 'utf8')).not.toContain('http://localhost:1/');

    // The same terminal starts Claude (the fake): the server is still its child, so the session row and bar show it.
    await win.locator('.xterm-helper-textarea:visible').focus();
    await win.keyboard.type('claude\n');
    // At the default sidebar width a session row shows its ports as one live dot (the waiting reason
    // keeps the room); the dot names the port and opens it.
    const sessionChip = win.locator('.session-row .port-all');
    await expect(sessionChip).toBeVisible({ timeout: 20000 });
    await expect(sessionChip).toHaveAttribute('data-tip', `Open localhost:${port} · node`);
    await win.locator('.session-row').first().click();
    const barChip = win.locator('.session-bar .port-chip', { hasText: `:${port}` });
    await expect(barChip).toBeVisible({ timeout: 10000 });
    // The chip never covers the row's title: it sits at the right end of the second line, whose
    // text keeps the measured room of the ports. (Polled: the room is measured by a ResizeObserver, a frame later.)
    await expect.poll(() => win.evaluate(() => {
      const row = document.querySelector('.session-row')!;
      const line = row.querySelector('.session-line')!.getBoundingClientRect();
      const sub = row.querySelector('.session-sub')!.getBoundingClientRect();
      const chips = row.querySelector('.port-chips')!.getBoundingClientRect();
      return { belowTitle: chips.top >= line.bottom - 0.5, clearOfSub: sub.right <= chips.left + 0.5 };
    }), { timeout: 3000 }).toEqual({ belowTitle: true, clearOfSub: true });
    await look(win.locator('.sidebar'), 'test-results/ports-session-row.png');
    await look(win.locator('.session-bar'), 'test-results/ports-session-bar.png');

    // Settings › Terminal › Show listening ports off: every chip goes away.
    await win.getByRole('button', { name: 'Settings' }).click();
    const dialog = win.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('button', { name: 'Terminal' }).click();
    const toggle = dialog.getByRole('switch', { name: 'Show listening ports' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.scrollIntoViewIfNeeded();
    await look(dialog, 'test-results/ports-settings.png');
    // "Show ephemeral ports" depends on it: available while ports show, dimmed and disabled once they don't.
    const ephemeral = dialog.getByRole('switch', { name: 'Show ephemeral ports' });
    await expect(ephemeral).toBeEnabled();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(ephemeral).toBeDisabled();
    await expect(dialog.locator('.set-row', { has: win.getByRole('switch', { name: 'Show ephemeral ports' }) })).toHaveClass(/is-disabled/);
    await look(dialog, 'test-results/ports-settings-off.png');
    await win.keyboard.press('Escape');
    await expect(win.locator('.port-chip')).toHaveCount(0);
  } finally {
    if (nodePid) { try { process.kill(nodePid, 'SIGKILL'); } catch { /* already gone */ } }
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});
