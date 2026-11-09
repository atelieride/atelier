import { expect, test, type Page } from '@playwright/test';
import { faq, rows, tiles, yourMac } from '../../src/content/features';
import { drawn, expectOneToOne, expectPhoneScale, pixels } from '../support/pixels';

// The home in six blocks: the hero, who needs you, Ask, the tiles, your Mac, the
// questions; then the closing. Every feature lives on /features (features.spec.ts).
const LEAD = 'A desktop workbench around the real Claude Code CLI. See what every session is doing, and jump to the one waiting for you.';
const HEADINGS = ['Run many Claude Code sessions.', 'Know who needs you.', 'Ask a session where it is.', 'The rest of your work,', 'Your Claude.', 'Questions', 'Your sessions,'];
const probe = (page: Page, value: string) => page.evaluate((v) => {
  const p = document.createElement('span');
  p.style.color = v;
  document.body.append(p);
  const c = getComputedStyle(p).color;
  p.remove();
  return c;
}, value);

test('six blocks in order, then the closing', async ({ page }) => {
  await page.goto('/');
  const headings = await page.locator('main h1, main h2').allTextContents();
  expect(headings).toHaveLength(HEADINGS.length);
  headings.forEach((h, i) => expect(h, `heading ${i}`).toMatch(new RegExp(`^${HEADINGS[i]!.replace(/[.,]/g, '\\$&')}`)));
});

test('hero: the new lead, the window, the Mac download with the app version, Windows one quiet line under it', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Run many Claude Code sessions\.\s*Never lose track\.$/);
  await expect(page.locator('.hero .lead')).toHaveText(LEAD);
  // The Mac button always carries the version it hands over, here and in the closing.
  for (const where of ['.hero', '.final']) {
    const mac = page.locator(`${where} a[data-download]`);
    await expect(mac, where).toContainText('Download for macOS');
    await expect(mac.locator('.ver'), where).toHaveText(/^v\d+\.\d+\.\d+(-beta\.\d+)?$/);
    const also = page.locator(`${where} a.also`);
    await expect(also, where).toBeVisible();
    const [b, a] = [(await mac.boundingBox())!, (await also.boundingBox())!];
    expect(a.y, where).toBeGreaterThanOrEqual(b.y + b.height); // under the button, never beside it
    expect(Math.abs(a.x + a.width / 2 - (b.x + b.width / 2)), where).toBeLessThan(2); // centred under it
  }
  const shot = page.locator('.hero .window .frame img');
  await expect(shot).toHaveAttribute('alt', /Atelier/);
  await expect.poll(() => shot.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
});

test('the hero\'s bar on the desktop: try it live, watch the film (unchanged)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.locator('.hero .see-try')).toBeVisible();
  await expect(page.locator('.hero .see-try')).toContainText('Try it live');
  await expect(page.locator('.hero .see-film')).toContainText('Watch the film');
});

test('who needs you: the words, the four states in their colours, the sessions window', async ({ page }) => {
  await page.goto('/');
  const block = page.locator('.split').nth(0);
  await expect(block.locator('h2')).toHaveText(/^Know who needs you\.\s*⌘J takes you there\.$/);
  await expect(block.locator('.lead')).toHaveText('Every session shows what it is doing. When one asks for permission or has a question, the sidebar, the Dock and a banner tell you, and one key opens it.');
  const states = block.locator('.states li');
  await expect(states).toHaveText(['Needs you', 'Working', 'Done', 'Failed']);
  for (const [i, token] of ['--waiting', '--working', '--done', '--error'].entries()) {
    expect(await states.nth(i).locator('.dot').evaluate((e) => getComputedStyle(e).backgroundColor), token).toBe(await probe(page, `var(${token})`));
  }
  await expect(block.locator('.window img')).toHaveAttribute('alt', rows.find((r) => r.id === 'sessions')!.alt);
});

test('Ask: the words, the read-only note, the Ask window on the other side', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const block = page.locator('.split').nth(1);
  await expect(block).toHaveClass(/reverse/);
  await expect(block.locator('h2')).toHaveText(/^Ask a session where it is\.\s*It keeps working\.$/);
  await expect(block.locator('.note')).toHaveText('Read-only · never edits files or runs commands · runs on your Claude account');
  await expect(block.locator('.window img')).toHaveAttribute('alt', rows.find((r) => r.id === 'ask')!.alt);
  // The window on the left, the words on the right.
  expect((await block.locator('.media').boundingBox())!.x).toBeLessThan((await block.locator('.copy').boundingBox())!.x);
});

test('the tiles: eight links to their features, then the rest in one line and All features', async ({ page }) => {
  await page.goto('/');
  const links = page.locator('.tiles a.tile');
  await expect(links).toHaveCount(8);
  expect(await links.evaluateAll((as) => as.map((a) => a.getAttribute('href')))).toEqual(tiles.map((t) => `/features#${t.id}`));
  await expect(links.locator('strong')).toHaveText(tiles.map((t) => t.title));
  for (const img of await links.locator('img').all()) await expect(img).toHaveAttribute('alt', '');
  await expect(page.locator('.beside .more p')).toHaveText('Also: background agents and shells · scheduled prompts · Claude accounts · ports · service logs');
  await expect(page.locator('.beside a.all')).toHaveAttribute('href', '/features');
  await expect(page.locator('.beside a.all')).toHaveText(/All features/);
});

test('your Mac: four cells, then the checks', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.mac .strip li strong')).toHaveText(yourMac.map((c) => c.title));
  await expect(page.locator('.mac .strip li code')).toHaveText(yourMac.map((c) => c.mono));
  await expect(page.locator('.mac .checks li')).toHaveText(['Free and open source', 'Notarized by Apple', 'Updates without closing sessions']);
});

test('the questions: five, the first open, a click opens another; links to GitHub, support and privacy; no counted accounts', async ({ page }) => {
  await page.goto('/');
  const items = page.locator('.questions details');
  await expect(items.locator('summary')).toHaveText(faq.map((f) => f.q));
  expect(await items.evaluateAll((ds) => ds.map((d) => (d as HTMLDetailsElement).open))).toEqual([true, false, false, false, false]);
  await items.nth(1).locator('summary').click();
  await expect(items.nth(1)).toHaveAttribute('open', '');
  await expect(items.nth(1).locator('p')).toBeVisible();
  await expect(items.nth(0).locator('a')).toHaveText(['on GitHub', 'support it']);
  await expect(items.nth(0).locator('a').first()).toHaveAttribute('href', 'https://github.com/atelieride/atelier');
  await expect(items.nth(0).locator('a').last()).toHaveAttribute('href', '/support');
  await expect(items.nth(3).locator('a')).toHaveAttribute('href', '/privacy');
  await expect(page.locator('.questions .ask a')).toHaveAttribute('href', 'mailto:hello@useatelier.dev');
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(/\b(2|two) (Claude )?accounts\b/i);
});

test('the closing: the Mac button and Windows one quiet line, no fine print', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.final a[data-download]')).toBeVisible();
  await expect(page.locator('.final a.also')).toHaveAttribute('href', '/download#windows');
  await expect(page.locator('.final .fine')).toHaveCount(0);
});

test('the home is at most 7,000 px tall on a 1440 × 900 desktop (it was 12,968)', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto('/', { waitUntil: 'networkidle' });
  // Scrolled through first: the tiles block counts by its placeholder size until it has rendered once.
  for (let y = 0; y < (await page.evaluate(() => document.documentElement.scrollHeight)); y += 700) {
    await page.evaluate((top) => scrollTo({ top, behavior: 'instant' }), y);
    await page.waitForTimeout(50);
  }
  await expect(page.locator('.tile img').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(7000);
  await ctx.close();
});

// Between a phone and a wide desktop (a tablet, a half-screen window), blocks 2 and 3 stack: side by side, the
// 640 px window would leave the words 150–340 px. Stacked, the window is never wider than its 1:1 size.
for (const width of [820, 1024, 1180]) {
  test.describe(`at ${width} px on a 2× screen`, () => {
    test.use({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });
    test('blocks 2 and 3 stack, the words first; their windows are drawn 1:1, never wider than 640 px', async ({ page }) => {
      await page.goto('/');
      for (const block of await page.locator('.split').all()) {
        const copy = (await block.locator('.copy').boundingBox())!;
        const media = (await block.locator('.media').boundingBox())!;
        expect(media.y).toBeGreaterThan(copy.y + copy.height - 1);
        const img = block.locator('.window .frame img');
        expect((await img.boundingBox())!.width).toBeLessThanOrEqual(640);
        await expectOneToOne(img);
      }
    });
  });
}

test('screenshots come as AVIF with WebP fallback, sized for the column they sit in', async ({ page }) => {
  await page.goto('/');
  // One for the phone crop, one for the desktop shot.
  await expect(page.locator('.hero picture source[type="image/avif"]')).toHaveCount(2);
  await expect(page.locator('.split').first().locator('picture source[type="image/avif"]')).toHaveCount(2);
  await expect(page.locator('.split').first().locator('.window img')).toHaveAttribute('sizes', /640px/);
  await expect(page.locator('.hero .window .frame img')).toHaveAttribute('sizes', /1280px/);
  // A tile: the 640 px column's files (the ones /features uses), lazy.
  await expect(page.locator('.tile picture source[type="image/avif"]')).toHaveCount(8);
  await expect(page.locator('.tile img').first()).toHaveAttribute('loading', 'lazy');
});

test('a tile shows the same files as its feature on /features (one download for both pages)', async ({ page }) => {
  await page.goto('/');
  const tileSet = await page.locator('.tile[data-tile="docker"] source[type="image/avif"]').getAttribute('srcset');
  await page.goto('/features');
  const rowSet = await page.locator('#docker .window source[type="image/avif"]:not([media])').getAttribute('srcset');
  expect(tileSet).toBe(rowSet);
});

test('traffic lights only on shots that include the window\'s top-left corner', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.hero .lights')).toHaveCount(1);
  await expect(page.locator('.split').nth(0).locator('.lights')).toHaveCount(1); // sessions: from the corner
  await expect(page.locator('.split').nth(1).locator('.lights')).toHaveCount(0); // ask: a crop
});

test.describe('on a Retina desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  test('every picture is drawn 1:1, the tiles included: one image pixel per screen pixel', async ({ page }) => {
    await page.goto('/');
    const shots = page.locator('.window .frame img');
    await expect(shots).toHaveCount(3); // the hero, who needs you, Ask
    for (const img of await shots.all()) await expectOneToOne(img);
    const tileImgs = page.locator('.tile img');
    await expect(tileImgs).toHaveCount(8);
    for (const img of await tileImgs.all()) {
      await expectOneToOne(img);
      // A window onto the shot: the tile shows part of it, never all of it shrunk.
      const p = await pixels(img);
      expect(drawn(p), p.label).toBeGreaterThan(p.box);
    }
  });

  test('the traffic lights sit where macOS draws them: 12 px, 20 px in, centred in the app\'s 45 px top bar', async ({ page }) => {
    await page.goto('/');
    for (const frame of [page.locator('.hero .frame'), page.locator('.split').first().locator('.frame')]) {
      await frame.scrollIntoViewIfNeeded();
      const [f, dot] = await frame.evaluate((e) => [e, e.querySelector('.lights i')!].map((n) => n.getBoundingClientRect().toJSON() as DOMRect));
      expect(Math.round(dot.width)).toBe(12);
      expect(Math.round(dot.x - f.x)).toBe(20);
      expect(Math.round(dot.y + dot.height / 2 - f.y)).toBe(23);
    }
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  test('the windows are crops made for it, near their real size; the tiles one column; the text first', async ({ page }) => {
    await page.goto('/');
    for (const img of await page.locator('.window .frame img').all()) await expectPhoneScale(img);
    const boxes = await page.locator('.tile').evaluateAll((ts) => ts.map((t) => t.getBoundingClientRect().x));
    expect(new Set(boxes.map(Math.round)).size).toBe(1);
    for (const block of await page.locator('.split').all()) {
      expect((await block.locator('.media').boundingBox())!.y).toBeGreaterThan((await block.locator('.copy').boundingBox())!.y);
    }
  });

  test('no sideways scroll at 360 px', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto('/');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  });
});

test('visual check: desktop and phone', async ({ page }) => {
  for (const [w, h, name] of [[1440, 900, 'desktop'], [390, 844, 'phone']] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto('/');
    // Scroll through once so lazy images load and every section reveals, then wait for all images.
    for (let y = 0; y < (await page.evaluate(() => document.body.scrollHeight)); y += 600) {
      // Instant: html's smooth scrolling would spend half a second on every step.
      await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), y);
      await page.waitForTimeout(120);
    }
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await expect.poll(() => page.evaluate(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0))).toBe(true);
    await page.waitForTimeout(700);
    await page.screenshot({ path: `test-results/home-${name}.png`, fullPage: true });
    await page.screenshot({ path: `test-results/home-hero-${name}.png` }); // the first screen: headline and downloads
  }
});

test('the Mac button carries the Apple mark, filled; "Notarized by Apple" lives in Your Mac, not under the buttons', async ({ page }) => {
  await page.goto('/');
  for (const where of ['.hero', '.final']) {
    const mark = page.locator(`${where} a[data-download] svg[data-icon="apple"] path`);
    await expect(mark, where).toHaveCount(1);
    expect(await mark.evaluate((p) => getComputedStyle(p).fill), where).not.toBe('none');
    await expect(page.locator(`${where} a[data-download] svg[data-icon="download"]`), where).toHaveCount(0);
  }
  await expect(page.locator('.mac .checks li').filter({ hasText: 'Notarized by Apple' })).toHaveCount(1);
});

// The second line of a title is dim text (--title-dim), no longer violet.
test('titles are two-tone: the second line is dim, not violet, on every page that has one', async ({ page }) => {
  for (const [path, selectors] of [['/', ['.hero h1 .dim', '.split h2 .dim', '.beside h2 .dim', '.mac h2 .dim', '.final h2 .dim']], ['/features', ['h1 .dim']], ['/support', ['h1 .dim']], ['/demo', ['h1 .dim']]] as const) {
    await page.goto(path);
    const dim = await probe(page, 'var(--title-dim)');
    expect(dim, path).not.toBe(await probe(page, 'var(--violet-soft)'));
    expect(dim, path).not.toBe(await probe(page, 'var(--text)'));
    for (const sel of selectors) expect(await page.locator(sel).first().evaluate((e) => getComputedStyle(e).color), `${path} ${sel}`).toBe(dim);
    await expect(page.locator('.grad'), path).toHaveCount(0);
  }
});
