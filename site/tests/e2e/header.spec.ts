import { expect, test, type Page } from '@playwright/test';

// The header in one row, as a path: the mark
// and the address as a path, the pages in mono, ⌘K search, Download. Merged with the page at the top; a frosted fill and
// a line once it scrolls.
const bar = (page: Page) => page.locator('header.appbar');
const pages = (page: Page) => bar(page).locator('nav a.ml');
const dialog = (page: Page) => page.locator('dialog.search-sheet');
// The header's script has run (it listens for the shortcuts and the scroll).
const open = async (page: Page, path: string) => { await page.goto(path); await expect(bar(page)).toHaveAttribute('data-ready', ''); };
const probe = (page: Page, value: string, prop: 'color' | 'background-color' = 'color') => page.evaluate(([v, p]) => {
  const e = document.createElement('span');
  e.style.setProperty(p!, v!);
  document.body.append(e);
  const c = getComputedStyle(e).getPropertyValue(p!);
  e.remove();
  return c;
}, [value, prop]);
const look = (page: Page) => bar(page).evaluate((h) => { const s = getComputedStyle(h); return { fill: s.backgroundColor, line: s.borderBottomColor, blur: s.backdropFilter }; });
const CLEAR = 'rgba(0, 0, 0, 0)';

test('one row: the mark and ~/useatelier.dev home, the pages and the code in mono, ⌘K search, Download', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/');
  const home = bar(page).locator('a.home');
  await expect(home).toHaveAttribute('href', '/');
  await expect(home).toHaveAttribute('aria-label', 'Atelier, home');
  await expect(home.locator('img')).toHaveCount(1);
  await expect(bar(page).locator('.path')).toHaveText('~/useatelier.dev');
  await expect(pages(page)).toHaveText(['features', 'changelog', 'github↗']);
  expect(await pages(page).evaluateAll((as) => as.map((a) => a.getAttribute('href')))).toEqual(['/features', '/changelog', 'https://github.com/atelieride/atelier']);
  await expect(pages(page).and(page.locator('[aria-current]'))).toHaveCount(0);
  expect(await pages(page).first().evaluate((a) => getComputedStyle(a).fontFamily)).toMatch(/JetBrains Mono/);
  await expect(bar(page).locator('button.search')).toContainText('⌘K');
  await expect(bar(page).locator('button.search')).toContainText('search');
  // The header's Download is one word and leads to /download (the platform cards); the version rides on the page's
  // own "Download for macOS" buttons, the ones that hand over the DMG.
  await expect(bar(page).locator('a[data-download]')).toHaveText('Download');
  await expect(bar(page).locator('a[data-download]')).toHaveAttribute('href', '/download');
  expect((await bar(page).boundingBox())!.height).toBe(60);
  // Gone: the window chrome's second row, the lights, the tabs.
  await expect(bar(page).locator('.tab, .lights, .appbar-svg')).toHaveCount(0);
});

test('the path follows the page; the page shown is marked, underlined in the brand', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const brand = await (async () => { await open(page, '/'); return probe(page, 'var(--brand)'); })();
  for (const [path, text, current] of [['/features', '~/useatelier.dev/features', 'features'], ['/changelog', '~/useatelier.dev/changelog', 'changelog'], ['/privacy', '~/useatelier.dev/privacy', null], ['/download', '~/useatelier.dev/download', null], ['/nope', '~/useatelier.dev', null]] as const) {
    await open(page, path);
    await expect(bar(page).locator('.path'), path).toHaveText(text);
    await expect(bar(page).locator('a.home'), path).toHaveAttribute('href', '/');
    const marked = pages(page).and(page.locator('[aria-current="page"]'));
    if (current) {
      await expect(marked, path).toHaveText(current);
      expect(await marked.evaluate((a) => getComputedStyle(a).textDecorationLine), path).toBe('underline');
      expect(await marked.evaluate((a) => getComputedStyle(a).textDecorationColor), path).toBe(brand);
    } else await expect(marked, path).toHaveCount(0);
    await expect(bar(page).locator('.caret'), path).toHaveCount(0); // the caret is the home's
  }
});

test('on the home a caret follows the path: it blinks five times, then rests', async ({ page }) => {
  await open(page, '/');
  const caret = bar(page).locator('.caret');
  await expect(caret).toBeVisible();
  await expect(caret).toHaveAttribute('aria-hidden', 'true');
  const anim = await caret.evaluate((c) => { const s = getComputedStyle(c); return { name: s.animationName, count: s.animationIterationCount }; });
  expect(anim.name).not.toBe('none');
  expect(anim.count).toBe('5');
});

test('with reduced motion the caret does not blink', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await open(page, '/');
  expect(await bar(page).locator('.caret').evaluate((c) => getComputedStyle(c).animationName)).toBe('none');
  await ctx.close();
});

test('merged with the page at the top: no fill, no line; both once it scrolls, on every page', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const path of ['/', '/features', '/changelog']) {
    await open(page, path);
    expect(await look(page), path).toMatchObject({ fill: CLEAR, line: CLEAR });
    await page.mouse.move(720, 450);
    await page.mouse.wheel(0, 200);
    await expect(bar(page), path).toHaveClass(/is-scrolled/);
    const line = await probe(page, 'var(--line-soft)');
    await expect.poll(async () => (await look(page)).line, { message: path }).toBe(line);
    await expect.poll(async () => (await look(page)).fill, { message: path }).not.toBe(CLEAR);
    expect((await look(page)).blur, path).toContain('blur');
    // The blur fades in with the fill, never pops in under it.
    expect(await bar(page).evaluate((h) => getComputedStyle(h).transitionProperty), path).toContain('backdrop-filter');
    // Back at the top: merged again.
    await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
    await expect(bar(page), path).not.toHaveClass(/is-scrolled/);
    await expect.poll(async () => (await look(page)).fill, { message: path }).toBe(CLEAR);
  }
});

test('a page opened mid-way (a link to a section, a reload) starts with the fill and the line', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/features#docker');
  await expect(bar(page)).toHaveClass(/is-scrolled/);
  await page.reload();
  await expect(bar(page)).toHaveClass(/is-scrolled/);
  await expect.poll(async () => (await look(page)).fill).not.toBe(CLEAR);
});

test('opening the search keeps the page where it was, header included', async ({ page }) => {
  await open(page, '/');
  await page.evaluate(() => window.scrollTo(0, 1500));
  await page.waitForFunction(() => window.scrollY === 1500);
  await page.keyboard.press('Meta+k');
  await expect(dialog(page)).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBe(1500);
  expect((await bar(page).boundingBox())!.y).toBe(0);
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.scrollY)).toBe(1500);
});

test('⌘K, Ctrl K, / and a click open the search; Esc closes it', async ({ page }) => {
  await open(page, '/');
  const ways = { 'Meta+K': () => page.keyboard.press('Meta+k'), 'Ctrl+K': () => page.keyboard.press('Control+k'), '/': () => page.keyboard.press('/'), click: () => bar(page).locator('button.search').click() };
  for (const [name, open] of Object.entries(ways)) {
    await open();
    await expect(dialog(page), name).toBeVisible();
    await expect(dialog(page).locator('input'), name).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog(page), name).toBeHidden();
  }
});

test('empty search: pages, features, what is new, shortcuts', async ({ page }) => {
  await open(page, '/');
  await page.keyboard.press('Meta+k');
  await expect(dialog(page).locator('.sheet-section')).toHaveText(['Pages', 'Features', /^New in \d/, 'Shortcuts']);
  await expect(dialog(page).locator('[role="option"]').first()).toHaveAttribute('aria-selected', 'true');
});

test('"split view" finds the changelog entries and the shortcut; Enter lands on the first entry', async ({ page }) => {
  await open(page, '/');
  await page.keyboard.press('Meta+k');
  // Two words: later entries about splits (0.2.0-beta.16's pane marks) must not come first; entries whose title starts
  // with "Split view" do (0.2.0-beta.6's, and newer ones such as 0.2.0-beta.28's tab groups).
  await page.keyboard.type('split view');
  const options = dialog(page).locator('[role="option"]');
  await expect(options.filter({ hasText: 'Split view' }).filter({ hasText: '0.2.0-beta.6' })).toHaveCount(1);
  await expect(dialog(page).locator('.sheet-caps').locator('xpath=..').filter({ hasText: 'Split view' })).toHaveCount(1); // the shortcut
  await expect(options.first().locator('mark')).toHaveText('Split view');
  await expect(options.first().locator('.sheet-label')).toHaveText(/^Split view/);
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/changelog#v[\d.]+(-beta\.\d+)?-split-view[-a-z]*$/);
  const entry = page.locator(decodeURIComponent(new URL(page.url()).hash).replace(/\./g, '\\.'));
  await expect(entry).toBeInViewport();
  // Clear of the header once the smooth scroll has settled (a reveal's 18 px rise must not push it under the bar).
  await expect.poll(async () => (await entry.boundingBox())!.y, { timeout: 4000 }).toBeGreaterThan((await bar(page).boundingBox())!.height);
  await page.waitForTimeout(800);
  expect((await entry.boundingBox())!.y).toBeGreaterThan((await bar(page).boundingBox())!.height);
});

test('arrow keys move the selection; a feature result goes to its section on /features', async ({ page }) => {
  await open(page, '/changelog');
  await page.keyboard.press('Meta+k');
  await page.keyboard.type('talk');
  const options = dialog(page).locator('[role="option"]');
  await expect(options.first()).toContainText('Dictation');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');
  await expect(dialog(page).locator('input')).toHaveAttribute('aria-activedescendant', (await options.first().getAttribute('id'))!);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/features#dictation$/);
  await expect(page.locator('#dictation')).toBeInViewport();
});

test('a result on the page already at its address still goes there (same hash twice)', async ({ page }) => {
  await open(page, '/features');
  const pick = async (q: string, label: string) => {
    await page.keyboard.press('Meta+k');
    await page.keyboard.type(q);
    await dialog(page).locator('[role="option"]').filter({ hasText: label }).first().click();
    await expect(dialog(page)).toBeHidden();
  };
  await pick('mention', 'Mention lines');
  await expect(page).toHaveURL(/\/features#shortcuts$/);
  await expect(page.locator('#shortcuts')).toBeInViewport();
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await expect(page.locator('#shortcuts')).not.toBeInViewport();
  await pick('new session', 'New session');
  await expect(page.locator('#shortcuts')).toBeInViewport();
});

test('the search field is 16 px on a phone, so iOS does not zoom the page when it opens', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await open(page, '/');
  await bar(page).locator('button.search').click();
  expect(await dialog(page).locator('input').evaluate((i) => parseFloat(getComputedStyle(i).fontSize))).toBeGreaterThanOrEqual(16);
});

test('no results: the sheet says so and suggests what to try', async ({ page }) => {
  await open(page, '/');
  await page.keyboard.press('Meta+k');
  await page.keyboard.type('zzzz');
  await expect(dialog(page).locator('[role="option"]')).toHaveCount(0);
  await expect(dialog(page)).toContainText('No results for “zzzz”');
});

test('the index is a static file built with the site', async ({ request }) => {
  const res = await request.get('/search.json');
  expect(res.ok()).toBe(true);
  const items = await res.json() as { group: string; label: string; href: string }[];
  expect(items.find((i) => i.group === 'Changelog' && i.label === 'Split view')?.href).toBe('/changelog#v0.2.0-beta.6-split-view');
  expect(items.filter((i) => i.group === 'Features')).toHaveLength(14);
  expect(items.find((i) => i.group === 'Features' && i.label === 'Docker')?.href).toBe('/features#docker');
});

test('the Changelog dot: shows for a version out since the last visit, clears on the changelog', async ({ page }) => {
  const dot = pages(page).filter({ hasText: 'changelog' }).locator('.dot');
  await page.goto('/');
  await expect(dot).toBeHidden(); // first visit: nothing is "new"
  await page.evaluate(() => localStorage.setItem('atelier.changelog-seen', '0.0.1'));
  await page.reload();
  await expect(dot).toBeVisible();
  await expect(pages(page).filter({ hasText: 'changelog' })).toHaveAttribute('aria-description', 'New since your last visit');
  await page.goto('/changelog');
  await expect(dot).toBeHidden();
  await page.goto('/');
  await expect(dot).toBeHidden();
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 360, height: 740 } });
  test('56 px; the pages and the search icon fit, no Download (the hero and the closing have it), no sideways scroll', async ({ page }) => {
    for (const path of ['/', '/features', '/changelog']) {
      await open(page, path);
      expect((await bar(page).boundingBox())!.height, path).toBe(56);
      for (const a of await pages(page).all()) await expect(a, path).toBeInViewport({ ratio: 1 });
      await expect(bar(page).locator('button.search'), path).toBeInViewport({ ratio: 1 });
      await expect(bar(page).locator('button.search .label'), path).toBeHidden();
      await expect(bar(page).locator('[data-download]'), path).toBeHidden();
      await expect(bar(page).locator('a.home img'), path).toBeInViewport({ ratio: 1 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth), path).toBeLessThanOrEqual(360);
    }
    // The path shrinks to ~ and the page.
    await expect(bar(page).locator('.path')).toHaveText(/^~.*changelog$/);
    await expect(bar(page).locator('.path .host')).toBeHidden();
  });
});

test('visual check: the header at the top and scrolled, desktop and phone, with the search open', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/');
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'test-results/header-top.png', clip: { x: 0, y: 0, width: 1440, height: 300 } });
  await page.mouse.move(720, 450);
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'test-results/header-scrolled.png', clip: { x: 0, y: 0, width: 1440, height: 300 } });
  await open(page, '/features');
  await page.mouse.move(720, 450);
  await page.mouse.wheel(0, 1600);
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'test-results/header-features-scrolled.png', clip: { x: 0, y: 0, width: 1440, height: 300 } });
  await page.keyboard.press('Meta+k');
  await page.keyboard.type('sess');
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'test-results/header-search.png' });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, '/');
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/header-phone.png', clip: { x: 0, y: 0, width: 390, height: 260 } });
  await open(page, '/features');
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'test-results/header-phone-features.png', clip: { x: 0, y: 0, width: 390, height: 260 } });
});

test('the palette offers Support Atelier with a heart on the brand, still (the quiet finish: no heartbeat, no gradient)', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Meta+k');
  const row = page.locator('.sheet-item.is-support');
  await expect(row).toContainText('Support Atelier');
  await expect(row.locator('.sheet-hint')).toHaveText('keeps Atelier free');
  const glyph = row.locator('.sheet-glyph.is-heart');
  await expect(glyph.locator('svg path')).toHaveCount(1);
  expect(await glyph.evaluate((g) => getComputedStyle(g).backgroundImage)).toBe('none');
  expect(await glyph.evaluate((g) => getComputedStyle(g).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  await dialog(page).locator('input').fill('donate');
  await expect(page.locator('.sheet-item').first()).toHaveClass(/is-support/);
  await expect(page.locator('.sheet-item').first()).toHaveAttribute('aria-selected', 'true');
  const beat = await page.locator('.sheet-item.is-support .sheet-glyph svg').evaluate((s) => getComputedStyle(s).animationName);
  expect(beat).toBe('none');
  await dialog(page).screenshot({ path: 'test-results/palette-support.png' }); // visual check
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/support$/);
});
