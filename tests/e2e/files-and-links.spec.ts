import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

test('file tree, full-size file with colors, terminal link to the right line', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  mkdirSync(join(project, 'src'));
  const lines = Array.from({ length: 80 }, (_, i) => (i === 59 ? "export const target = 'riga sessanta';" : `const v${i} = ${i}; // riga ${i + 1}`));
  writeFileSync(join(project, 'src', 'App.tsx'), lines.join('\n') + '\n');
  const { env, home } = e2eEnv();
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await win.getByRole('button', { name: 'Files (⌘⇧2)' }).click();
    await win.locator('.tree-row', { hasText: 'src' }).click();
    await win.locator('.tree-row', { hasText: 'App.tsx' }).click();
    const view = win.locator('.file-view:visible');
    await expect(view).toContainText('const v0 = 0; // riga 1', { timeout: 10000 }); // CodeMirror only creates the visible lines
    // Shiki colors applied: the keyword has the theme's color.
    // Keywords carry the theme's --syn-keyword: Aurora's pink.
    const keyword = view.locator('span[style*="var(--syn-keyword)"]').first();
    await expect(keyword).toBeVisible({ timeout: 10000 });
    expect(await keyword.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(244, 114, 182)');
    await look(win, 'test-results/files-links-file.png');

    // Link from the terminal.
    await win.getByRole('button', { name: 'Close tab' }).click();
    await win.getByRole('button', { name: 'Sessions (⌘⇧1)' }).click();
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(win.locator('.xterm-rows')).toContainText('›', { timeout: 10000 });
    await win.locator('.xterm-helper-textarea').focus();
    await win.keyboard.type('echo "vedi src/App.tsx:60 per il punto"\n');
    // Exact position of the link text in the output line (not the typed command's).
    await expect(win.locator('.xterm-rows')).toContainText('vedi src/App.tsx:60 per il punto', { timeout: 10000 });
    await expect.poll(() => textBox(win, 'vedi src/App.tsx:60', 'vedi '.length), { timeout: 10000 }).not.toBeNull();
    const box = await textBox(win, 'vedi src/App.tsx:60', 'vedi '.length);
    expect(box).not.toBeNull();
    await win.mouse.move(box!.x, box!.y);
    await expect(win.locator('.xterm-cursor-pointer')).toBeVisible({ timeout: 5000 });
    await win.mouse.click(box!.x, box!.y);
    await expect(win.locator('.cm-target-line')).toContainText('riga sessanta', { timeout: 10000 });
    await look(win, 'test-results/files-links-link.png');

    // The file changes on disk (as when Claude edits it) and is cited again: it is re-read.
    const changed = lines.map((l, i) => (i === 69 ? "export const dopo = 'riga settanta cambiata';" : l));
    writeFileSync(join(project, 'src', 'App.tsx'), changed.join('\n') + '\n');
    await win.getByRole('tab', { name: /Terminal/ }).click();
    await win.locator('.xterm-helper-textarea').focus();
    await win.keyboard.type('clear; echo "vedi src/App.tsx:70 per il punto"\n');
    await expect(win.locator('.xterm-rows')).toContainText('vedi src/App.tsx:70 per il punto', { timeout: 10000 });
    // The searched text appears first in the typed command: wait for the real output line.
    await expect.poll(() => textBox(win, 'vedi src/App.tsx:70', 'vedi '.length), { timeout: 10000 }).not.toBeNull();
    const box2 = await textBox(win, 'vedi src/App.tsx:70', 'vedi '.length);
    expect(box2).not.toBeNull();
    await win.mouse.move(box2!.x, box2!.y);
    await expect(win.locator('.xterm-cursor-pointer')).toBeVisible({ timeout: 5000 });
    await win.mouse.click(box2!.x, box2!.y);
    await expect(win.locator('.cm-target-line')).toContainText('riga settanta cambiata', { timeout: 10000 });

    // The reader goes back to the top; then the file changes on disk: the view stays where it is, it does not jump to the cited line.
    const scroller = () => win.evaluate(() => {
      const s = document.querySelector('.file-view:not([style*="none"]) .cm-scroller');
      return { top: s?.scrollTop ?? -1, height: s?.scrollHeight ?? -1 };
    });
    await win.evaluate(() => { const s = document.querySelector('.file-view:not([style*="none"]) .cm-scroller'); if (s) s.scrollTop = 0; });
    await win.waitForTimeout(300);
    const before = await scroller();
    writeFileSync(join(project, 'src', 'App.tsx'), changed.join('\n') + '\nexport const inFondo = 1;\n');
    // The extra line is in the editor (the content is taller): the reload happened; a jump would come with it.
    await expect.poll(async () => (await scroller()).height, { timeout: 10000 }).toBeGreaterThan(before.height);
    await win.waitForTimeout(300);
    expect((await scroller()).top).toBeLessThan(50);
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});

/** Exact center of a stretch of text in a terminal row (DOM renderer). */
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
