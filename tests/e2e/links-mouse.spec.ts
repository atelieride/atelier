import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

/** Center of the text at offset `at` of the terminal row that starts with `rowStart` (DOM renderer). */
function textBox(win: Page, rowStart: string, at: number): Promise<{ x: number; y: number } | null> {
  return win.evaluate(([start, target]) => {
    const row = [...document.querySelectorAll('.xterm-rows > div')].find((r) => (r.textContent ?? '').startsWith(start));
    if (!row) return null;
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let offset = 0;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const len = n.textContent?.length ?? 0;
      if (offset + len > target) {
        const range = document.createRange();
        range.setStart(n, target - offset);
        range.setEnd(n, Math.min(len, target - offset + 4));
        const r = range.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      offset += len;
    }
    return null;
  }, [rowStart, at] as const);
}

// Full-screen Claude Code captures the mouse: every click is reported to it, and its redraw between press and release
// could lose the link. ⌘-click opens the hovered link and is never reported; a plain click stays the program's.
test('mouse captured by the program: ⌘-click opens links without reporting the click, a plain click is the program\'s', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  mkdirSync(join(project, 'src'));
  writeFileSync(join(project, 'src', 'App.tsx'), 'export const one = 1;\nexport const two = 2;\nexport const three = 3;\n');
  const urlLog = join(mkdtempSync(join(tmpdir(), 'atl-url-')), 'urls.txt');
  const { env, home } = e2eEnv({ ATELIER_TEST_URL_LOG: urlLog });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    const rows = win.locator('.xterm-rows');
    await expect(rows).toBeVisible({ timeout: 10000 });
    await win.locator('.xterm-helper-textarea').focus();
    // Alternate screen with the mouse captured (SGR encoding, like Claude Code); cat -v shows every report received.
    await win.keyboard.type("printf '\\033[?1049h\\033[?1000h\\033[?1006h'; echo 'see src/App.tsx:3 and https://example.com/x'; stty -icanon -echo; cat -v\n");
    await expect.poll(() => textBox(win, 'see src/', 'see '.length), { timeout: 10000 }).not.toBeNull();
    // Every press and release reported in SGR encoding (⌘ would show as ^[[<8;).
    const reports = async () => ((await rows.textContent()) ?? '').split('^[[<').length - 1;
    const hover = async (at: number) => {
      const box = (await textBox(win, 'see src/', at))!;
      await win.mouse.move(box.x - 3, box.y);
      await win.mouse.move(box.x, box.y);
      await expect(win.locator('.xterm-cursor-pointer')).toBeVisible({ timeout: 5000 });
      return box;
    };
    // A sync barrier for "nothing was reported": a sentinel written to the terminal's input after the click reaches cat
    // behind any report the click made (same input path), so once cat echoes it, a report would be on screen.
    const barrier = async (mark: string) => {
      await win.evaluate(async (m) => {
        const api = (window as unknown as { atelier: { terminals: { list(): Promise<{ id: string }[]>; input(id: string, data: string): void } } }).atelier;
        api.terminals.input((await api.terminals.list())[0]!.id, m);
      }, mark);
      await expect(rows).toContainText(mark, { timeout: 5000 });
    };
    const pathAt = 'see '.length;
    const urlAt = 'see src/App.tsx:3 and '.length;

    // Plain click on the path: reported to the program (press and release), nothing opens.
    const p = await hover(pathAt);
    await win.mouse.click(p.x, p.y);
    await expect.poll(reports, { timeout: 5000 }).toBe(2);
    await barrier('mark-1');
    await expect(win.locator('.cm-target-line')).toHaveCount(0);

    // ⌘-click on the URL: opened in the browser, not reported.
    const u = await hover(urlAt);
    await win.keyboard.down('Meta');
    await win.mouse.click(u.x, u.y);
    await win.keyboard.up('Meta');
    await expect.poll(() => existsSync(urlLog) ? readFileSync(urlLog, 'utf8') : '', { timeout: 5000 }).toContain('https://example.com/x');
    await barrier('mark-2');
    expect(await reports()).toBe(2);
    // One ⌘-click, one browser tab: a double open (mousedown and mouseup both opening) would log two lines.
    expect(readFileSync(urlLog, 'utf8').split('\n').filter(Boolean)).toEqual(['https://example.com/x']);

    // ⌘-click on the path: the file opens at the line, not reported.
    const p2 = await hover(pathAt);
    await win.keyboard.down('Meta');
    await win.mouse.click(p2.x, p2.y);
    await win.keyboard.up('Meta');
    await expect(win.locator('.cm-target-line')).toContainText('three', { timeout: 10000 });
    await look(win, 'test-results/links-mouse.png');
    // The terminal behind the file's tab draws nothing: back to it to read what cat received.
    await win.locator('.tab').first().click();
    await barrier('mark-3');
    expect(await reports()).toBe(2);
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});
