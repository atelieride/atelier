import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

type Api = { atelier: { settings: { set(p: object): Promise<unknown> } } };

test('preview tabs: single click replaces one italic tab, double click / typing keep it, setting off opens normal tabs', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  for (const n of ['a', 'b', 'c', 'd', 'e', 'f']) writeFileSync(join(project, `${n}.ts`), `export const ${n} = 1;\n`);
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    const fileTabs = win.locator('.tab[data-key^="f:"]');
    const tab = (name: string) => win.locator('.tab', { hasText: name });
    const row = (name: string) => win.locator('.tree-row', { hasText: name });
    await win.getByRole('button', { name: /Files/ }).click();

    await row('a.ts').click();
    await expect(tab('a.ts')).toHaveClass(/is-preview/);
    await expect(tab('a.ts').locator('.tab-name')).toHaveCSS('font-style', 'italic');
    await row('b.ts').click();
    await expect(fileTabs).toHaveCount(1);
    await expect(tab('b.ts')).toHaveClass(/is-preview/);

    // Double click on the file keeps it open; the next single click gets a new preview tab.
    await row('b.ts').dblclick();
    await expect(tab('b.ts')).not.toHaveClass(/is-preview/);
    await row('c.ts').click();
    await expect(fileTabs).toHaveCount(2);
    await expect(tab('c.ts')).toHaveClass(/is-preview/);
    await expect(tab('c.ts').locator('.tab-name')).toHaveCSS('font-style', 'italic');
    await look(win, 'test-results/preview-tab.png');

    // Clicking a normal tab's file only activates it: the preview tab stays.
    await row('b.ts').click();
    await expect(fileTabs).toHaveCount(2);
    await expect(tab('c.ts')).toHaveClass(/is-preview/);

    // Typing promotes it.
    await row('c.ts').click();
    const view = win.locator('.file-view:visible .cm-content');
    await view.click();
    await win.keyboard.type('// edited\n');
    await expect(tab('c.ts')).not.toHaveClass(/is-preview/);

    // Double click on the tab keeps it open.
    await row('d.ts').click();
    await expect(fileTabs).toHaveCount(3);
    await tab('d.ts').dblclick();
    await expect(tab('d.ts')).not.toHaveClass(/is-preview/);

    // Keep Open in the tab's context menu.
    await row('e.ts').click();
    await expect(tab('e.ts')).toHaveClass(/is-preview/);
    await tab('e.ts').click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Keep Open' }).click();
    await expect(tab('e.ts')).not.toHaveClass(/is-preview/);

    // Setting off: every single click opens a normal tab.
    await win.evaluate(() => (window as unknown as Api).atelier.settings.set({ previewTabs: false }));
    await row('f.ts').click();
    await row('a.ts').click();
    await expect(fileTabs).toHaveCount(6);
    await expect(win.locator('.tab.is-preview')).toHaveCount(0);
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});
