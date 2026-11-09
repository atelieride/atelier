import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// One-bar header (mockup "B" + usage "1"): New is the + at the end of the project chip,
// and the usage meter draws rings. The Windows half (the hamburger in the header) is checked on the PC.

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

test('the project chip ends with the +, the New menu under it; the usage meter draws rings; narrowest window at the largest interface size: everything stays in the bar, the path gives way to a long name, which never runs under the +', async () => {
  const project = join(mkdtempSync(join(tmpdir(), 'atl-prj-')), 'a-project-with-a-rather-long-name');
  mkdirSync(project);
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    // The project chip ends with the +: no New text button, the New menu opens under the +.
    const chip = win.locator('.header .project-chip');
    const plus = chip.locator('.btn-new');
    await expect(plus).toBeVisible({ timeout: 15000 });
    await expect(win.locator('.header button', { hasText: /^New/ })).toHaveCount(0);
    await expect(plus).toHaveAccessibleName('New…');
    const c = (await chip.boundingBox())!;
    const p = (await plus.boundingBox())!;
    // The + is the chip's end: flush with its right edge (inside the 1 px border).
    expect(Math.abs(c.x + c.width - 1 - (p.x + p.width))).toBeLessThanOrEqual(1);
    await look(win.locator('.header'), 'test-results/one-bar-header-chip.png');

    await expect(plus).toHaveAttribute('aria-expanded', 'false');
    await plus.click();
    const item = win.getByRole('menuitem', { name: /^Claude Session/ });
    await expect(item).toBeVisible();
    await expect(plus).toHaveAttribute('aria-expanded', 'true');
    await expect(plus).toHaveClass(/is-open/);
    const menu = (await win.locator('.ctx-menu').boundingBox())!;
    expect(Math.abs(menu.x - p.x)).toBeLessThanOrEqual(2);
    expect(menu.y).toBeGreaterThan(p.y + p.height);
    await look(win, 'test-results/one-bar-header-new-menu.png', { clip: { x: 0, y: 0, width: 900, height: 320 } });
    await win.keyboard.press('Escape');
    await expect(item).toBeHidden();
    await expect(plus).toHaveAttribute('aria-expanded', 'false');

    // The + does what New did: a terminal from its menu.
    await plus.click();
    await win.getByRole('menuitem', { name: /^Terminal\s*⌘T$/ }).click();
    await expect(win.locator('.term-row')).toHaveCount(1, { timeout: 10000 });

    // The usage meter draws rings: profile-less with one account, %, reset without ↺, tone colors near the limit.
    await expect(win.locator('.xterm-rows:visible')).toBeVisible({ timeout: 10000 });
    await win.locator('.xterm-helper-textarea:visible').focus();
    const text = () => win.locator('.xterm-rows:visible').evaluate((el) => el.textContent ?? '');
    // Typed before zsh draws its prompt (the Atelier prompt's ›), the first keys can be lost ("cho SHELLREADY").
    await expect.poll(text, { timeout: 15000 }).toContain('›');
    await win.keyboard.type('echo SHELL""READY\n');
    await expect.poll(text, { timeout: 15000 }).toContain('SHELLREADY');
    // 5h at 86% (warn, resets in 41 minutes); the fake's 7d is at 18% (brand).
    await win.keyboard.type('ATELIER_FAKE_5H=86:2460 claude -n Rings\n');

    const meter = win.locator('.header .usage');
    await expect(meter.locator('.usage-pct')).toHaveText(['86%', '18%'], { timeout: 20000 });
    await expect(meter.locator('.usage-bar')).toHaveCount(0);
    const rings = meter.locator('.usage-ring');
    await expect(rings).toHaveCount(2);
    await expect(rings.nth(0)).toHaveClass(/tone-warn/);
    await expect(rings.nth(1)).toHaveClass(/tone-brand/);
    await expect(rings.nth(0).locator('.usage-ring-arc')).toHaveAttribute('stroke-dasharray', '86 100');
    await expect(rings.nth(1).locator('.usage-ring-arc')).toHaveAttribute('stroke-dasharray', '18 100');
    // The brand arc draws in the brand, solid; a warn one in the waiting amber, and its % says so too.
    expect(await rings.nth(1).locator('.usage-ring-arc').evaluate((el) => getComputedStyle(el).stroke)).toBe(await win.evaluate(() => { const p = document.createElement('i'); p.style.color = 'var(--brand)'; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; }));
    // The ring draws in the brand, solid: no gradient defs any more.
    await expect(meter.locator('linearGradient')).toHaveCount(0);
    expect(await rings.nth(0).locator('.usage-ring-arc').evaluate((el) => getComputedStyle(el).stroke)).toBe('rgb(251, 191, 36)');
    expect(await meter.locator('.usage-pct').first().evaluate((el) => getComputedStyle(el).color)).toBe('rgb(251, 191, 36)');
    // Reset times: bare, the tooltip still says what they are.
    await expect(meter.locator('.usage-reset')).toHaveText([/^4[01]m$/, /^\d+d\d+h$/]);
    await expect(meter.locator('.usage-part').first()).toHaveAttribute('title', /^5h window resets in 4[01]m$/);
    // Each window is one group (label, ring, %, reset); a separator only after the profile, none here (one account).
    await expect(meter.locator('.usage-part')).toHaveCount(2);
    await expect(meter.locator('.usage-sep')).toHaveCount(0);
    await look(meter, 'test-results/one-bar-header-rings.png');
    await look(win.locator('.header'), 'test-results/one-bar-header-full.png');

    // Narrowest window at the largest interface size.
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]!; w.setSize(960, 700); w.webContents.setZoomFactor(1.25); });
    await expect.poll(() => win.evaluate(() => innerWidth)).toBe(768);
    const vw = 768;
    const bell = (await win.locator('.header .bell-btn').boundingBox())!;
    expect(bell.x + bell.width).toBeLessThanOrEqual(vw - 12 + 0.5);
    const chipBox = (await chip.boundingBox())!;
    const plusBox = (await plus.boundingBox())!;
    expect(plusBox.x + plusBox.width).toBeLessThanOrEqual(chipBox.x + chipBox.width);
    // A long name leaves the path too little room to read: it goes (no "/……" stub).
    await expect(win.locator('.header .project-path')).toBeHidden();
    // The name never runs under the +: it ends in an ellipsis inside the chip.
    const name = win.locator('.header .project-name');
    expect(await name.evaluate((el) => getComputedStyle(el).textOverflow)).toBe('ellipsis');
    const n = (await name.boundingBox())!;
    expect(n.x + n.width).toBeLessThanOrEqual(plusBox.x);
    await look(win.locator('.header'), 'test-results/one-bar-header-narrow.png');
  } finally {
    await stop(app, home);
  }
});
