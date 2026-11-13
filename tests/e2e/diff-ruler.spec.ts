// Readable diffs and the overview ruler.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

const SHOTS = 'test-results';
const BASE = Array.from({ length: 200 }, (_, i) => `const line${i} = ${i};`);
BASE[40] = 'const TTL = 60 * 30;';
BASE[150] = 'export const mode = "slow";';
// Far below, unchanged: wider than the view.
BASE[195] = `export const banner = '${'=-'.repeat(160)}';`;
const NOW = [...BASE];
NOW[40] = 'const TTL_SECONDS = 60 * 45;';
NOW.splice(60, 0, ...Array.from({ length: 11 }, (_, i) => `const added${i} = ${i};`));
NOW[161] = 'export const mode = "fast";';
// Two lines gone near the end.
NOW.splice(190, 2);

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

const fv = (win: Page) => win.locator('.file-view:visible');
const scroller = (win: Page) => fv(win).locator('.cm-scroller');

test('the overview ruler: changes, thumb, a click on a change goes there; the Diff view tinted, its changed words marked', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: project, env: gitEnv });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(project, 'a.ts'), BASE.join('\n') + '\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  writeFileSync(join(project, 'a.ts'), NOW.join('\n') + '\n');
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));
    await win.getByRole('button', { name: /^Files/ }).click();
    await win.locator('.tree-row', { hasText: 'a.ts' }).dblclick();
    await expect(fv(win).locator('.cm-content')).toBeVisible();

    // Margin: the ruler replaces the vertical scrollbar; the margin's marks are on it, one block each.
    const ruler = fv(win).locator('.cm-ruler');
    await expect(ruler).toBeVisible();
    expect(await scroller(win).evaluate((el) => (el as HTMLElement).offsetWidth - el.clientWidth)).toBe(0);
    await expect(ruler.locator('.cm-ruler-mark.is-add')).toHaveCount(1);
    await expect(ruler.locator('.cm-ruler-mark.is-mod')).toHaveCount(2);
    await expect(ruler.locator('.cm-ruler-mark.is-del')).toHaveCount(1);
    await expect(ruler.locator('.cm-ruler-mark.is-add')).toHaveAttribute('data-tip', 'Lines 61–71 · 11 added');
    await expect(ruler.locator('.cm-ruler-mark.is-mod').first()).toHaveAttribute('data-tip', 'Line 41 · modified');
    await expect(ruler.locator('.cm-ruler-mark.is-del')).toHaveAttribute('data-tip', 'Removed above line 191');
    // A line wider than the view far below: CodeMirror draws (and measures) only the lines near the view, so the
    // horizontal scrollbar used to show up only once that line came near, taking its height from the code. Now it is
    // there from the start and stays, the code as wide as its widest line.
    const hbar = () => scroller(win).evaluate((el) => (el as HTMLElement).offsetHeight - el.clientHeight);
    const frames = () => win.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const h0 = await hbar();
    expect(h0).toBeGreaterThan(0);
    for (const y of [1500, 1e6, 0]) {
      await scroller(win).evaluate((el, to) => { el.scrollTop = to; }, y);
      await frames();
      expect(await hbar()).toBe(h0);
      if (y !== 1e6) continue;
      // Drawn now: the code is exactly as wide as that line (its text and the line's padding), not wider.
      const fit = await fv(win).locator('.cm-line', { hasText: 'export const banner' }).evaluate((line) => {
        const r = document.createRange();
        r.selectNodeContents(line);
        const pad = parseFloat(getComputedStyle(line).paddingLeft) + parseFloat(getComputedStyle(line).paddingRight);
        return line.parentElement!.getBoundingClientRect().width - (r.getBoundingClientRect().width + pad);
      });
      expect(Math.abs(fit)).toBeLessThan(2);
    }
    // The thumb: the visible part, at the top, a fraction of the track.
    const thumb = ruler.locator('.cm-ruler-thumb');
    await expect(thumb).toBeVisible();
    const t0 = (await thumb.boundingBox())!;
    const r0 = (await ruler.boundingBox())!;
    expect(t0.y - r0.y).toBeLessThan(2);
    expect(t0.height).toBeLessThan(r0.height / 2);
    // A click on the "mode" change: the cursor goes to its line, which comes into view, centered.
    await ruler.locator('.cm-ruler-mark.is-mod').nth(1).click();
    await expect(fv(win).locator('.cm-activeLine')).toHaveText('export const mode = "fast";');
    // The scroll comes on the editor's next measure, a frame after the cursor (a run of many caught it in between).
    await expect.poll(() => scroller(win).evaluate((el) => el.scrollTop)).toBeGreaterThan(1000);
    // The thumb followed.
    await expect.poll(async () => (await thumb.boundingBox())!.y - r0.y).toBeGreaterThan(r0.height / 2);
    // A click at the very top of the track (off the thumb) brings the start back.
    await win.mouse.click(r0.x + r0.width / 2, r0.y + 2);
    await expect.poll(() => scroller(win).evaluate((el) => el.scrollTop)).toBe(0);
    await win.mouse.move(r0.x - 300, r0.y + 200);
    await look(fv(win), `${SHOTS}/ruler-margin.png`);

    // A change the thumb covers doesn't stop the thumb: pressed and moved there, the thumb drags.
    const ttl = ruler.locator('.cm-ruler-mark.is-mod').first();
    await ttl.click();
    await expect(fv(win).locator('.cm-activeLine')).toHaveText('const TTL_SECONDS = 60 * 45;');
    await expect.poll(async () => {
      const [m, th] = [(await ttl.boundingBox())!, (await thumb.boundingBox())!];
      return m.y > th.y + 4 && m.y + m.height < th.y + th.height - 4;
    }).toBe(true);
    const top = () => scroller(win).evaluate((el) => el.scrollTop);
    const m1 = (await ttl.boundingBox())!;
    const s1 = await top();
    await win.mouse.move(m1.x + m1.width / 2, m1.y + m1.height / 2);
    await win.mouse.down();
    await win.mouse.move(m1.x + m1.width / 2, m1.y + m1.height / 2 + 60, { steps: 4 });
    await win.mouse.up();
    expect(await top()).toBeGreaterThan(s1 + 200);
    await expect(ruler).not.toHaveClass(/is-dragging/);

    // A release that never reaches the ruler (over the window's drag region Electron can swallow it) doesn't leave the
    // thumb stuck to the pointer. Its capture lost: the drag ends there and then.
    const swallow = (types: string[]) => win.evaluate((ts) => {
      for (const t of ts) window.addEventListener(t, (e) => e.stopImmediatePropagation(), { capture: true, once: true });
    }, types);
    const dragThumb = async () => {
      const th = (await thumb.boundingBox())!;
      await win.mouse.move(th.x + th.width / 2, th.y + th.height / 2);
      await win.mouse.down();
      await win.mouse.move(th.x + th.width / 2, th.y + th.height / 2 + 30, { steps: 3 });
      await win.mouse.up();
      return th;
    };
    await swallow(['pointerup']);
    let th = await dragThumb();
    await expect(ruler).not.toHaveClass(/is-dragging/);
    let s2 = await top();
    await win.mouse.move(th.x + th.width / 2, r0.y + r0.height - 20, { steps: 4 });
    expect(await top()).toBe(s2);
    // No word at all (release and capture both gone): the next move without a button ends it, the code stays put.
    await swallow(['pointerup', 'lostpointercapture']);
    th = await dragThumb();
    s2 = await top();
    await win.mouse.move(th.x + th.width / 2, r0.y + 20, { steps: 4 });
    expect(await top()).toBe(s2);
    await expect(ruler).not.toHaveClass(/is-dragging/);

    // Diff: rows tinted, their numbers and signs fuller, removed text no longer faded, changed words marked.
    await fv(win).locator('.seg').getByRole('button', { name: 'Diff' }).click();
    await expect(fv(win).locator('.cm-diff-add').first()).toBeAttached();
    expect(await hbar()).toBe(h0);
    // The ruler shows the Diff view's rows (removed ones say how many) and takes us to them.
    await expect(ruler.locator('.cm-ruler-mark.is-del')).toHaveCount(3);
    await expect(ruler.locator('.cm-ruler-mark.is-del').first()).toHaveAttribute('data-tip', '1 removed');
    await expect(ruler.locator('.cm-ruler-mark.is-del').last()).toHaveAttribute('data-tip', '2 removed');
    await expect(ruler.locator('.cm-ruler-mark.is-add').first()).toHaveAttribute('data-tip', 'Line 41 · added');
    await ruler.locator('.cm-ruler-mark.is-del').nth(1).click();
    await expect(fv(win).locator('.cm-diff-word-del', { hasText: 'slow' })).toBeVisible();
    await expect(fv(win).locator('.cm-diff-word-add', { hasText: 'fast' })).toBeVisible();
    await ruler.locator('.cm-ruler-mark.is-del').first().click();
    await expect(fv(win).locator('.cm-diff-add').first()).toBeVisible();
    await expect(fv(win).locator('.cm-diff-word-del').first()).toHaveText('TTL');
    await expect(fv(win).locator('.cm-diff-word-add').first()).toHaveText('TTL_SECONDS');
    await expect(fv(win).locator('.cm-diff-word-del').nth(1)).toHaveText('30');
    await expect(fv(win).locator('.cm-diff-word-add').nth(1)).toHaveText('45');
    expect(await fv(win).locator('.cm-gutterElement.cm-diff-gadd').count()).toBeGreaterThan(0);
    expect(await fv(win).locator('.cm-gutterElement.cm-diff-gdel').count()).toBeGreaterThan(0);
    const alpha = (el: Element) => { const m = getComputedStyle(el).backgroundColor.match(/[\d.]+(?=\)$)/); return m ? Number(m[0]) : 1; };
    const row = await fv(win).locator('.cm-diff-add').first().evaluate(alpha);
    const cell = await fv(win).locator('.cm-gutterElement.cm-diff-gadd').first().evaluate(alpha);
    expect(row).toBeGreaterThan(0.12);
    expect(cell).toBeGreaterThan(row);
    expect(await fv(win).locator('.cm-diff-del span').first().evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    await win.mouse.move(r0.x - 300, r0.y + 200);
    await look(fv(win), `${SHOTS}/ruler-diff.png`);

    // Find's matches move into the ruler's right lane while the card is open.
    await fv(win).locator('.cm-content').click();
    await win.keyboard.press('Meta+f');
    await win.keyboard.type('mode');
    await expect(ruler.locator('.cm-ruler-find').first()).toBeAttached();
    await win.keyboard.press('Escape');
    await expect(ruler.locator('.cm-ruler-find')).toHaveCount(0);

    // Word wrap: nothing to scroll sideways, whatever the widest line.
    const wrap = (on: boolean) => win.evaluate((w) => (window as unknown as { atelier: { settings: { set(p: object): Promise<unknown> } } }).atelier.settings.set({ wordWrap: w }), on);
    await wrap(true);
    await expect(fv(win).locator('.cm-lineWrapping')).toHaveCount(1);
    await expect.poll(hbar).toBe(0);
    expect(await scroller(win).evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    await wrap(false);
    await expect.poll(hbar).toBe(h0);
  } finally {
    await stop(app, home);
  }
});
