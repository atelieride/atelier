import { expect, test, type Page } from '@playwright/test';
import { rows } from '../../src/content/features';
import { expectOneToOne, expectPhoneScale } from '../support/pixels';

// /features: every feature in README form, with an index.
const toc = (page: Page) => page.locator('nav.toc');
const bar = (page: Page) => page.locator('header.appbar');
const barBottom = async (page: Page) => { const b = (await bar(page).boundingBox())!; return b.y + b.height; };
const articles = (page: Page) => page.locator('article.feature');

test('head: the title, a two-tone h1, the lead; a canonical address of its own', async ({ page }) => {
  await page.goto('/features');
  await expect(page).toHaveTitle('Atelier | Features');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Everything Atelier does\.\s*In the order you'll meet it\.$/);
  await expect(page.locator('h1 .dim')).toHaveText("In the order you'll meet it.");
  await expect(page.locator('.page-head .lead')).toHaveText('Each feature with its shortcut and a screenshot. On a desktop, most of them open in the live demo.');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://useatelier.dev/features');
});

test('the index: the fourteen rows in order, then And more and Keyboard, each an anchor on this page', async ({ page }) => {
  await page.goto('/features');
  await expect(toc(page)).toHaveAttribute('aria-label', 'On this page');
  const links = toc(page).locator('a');
  await expect(links).toHaveText([...rows.map((r) => r.eyebrow), 'And more', 'Keyboard']);
  const hrefs = await links.evaluateAll((as) => as.map((a) => a.getAttribute('href')!));
  expect(hrefs).toEqual([...rows.map((r) => `#${r.id}`), '#more', '#shortcuts']);
  for (const h of hrefs) await expect(page.locator(h), h).toHaveCount(1);
});

test('fourteen articles in order: the title, the shortcut beside it, no callouts; "Try it live" on the rows the demo shows', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/features');
  await expect(articles(page)).toHaveCount(14);
  expect(await articles(page).evaluateAll((as) => as.map((a) => a.id))).toEqual(rows.map((r) => r.id));
  for (const r of rows) {
    const a = page.locator(`#${r.id}`);
    await expect(a.locator('h2'), r.id).toHaveText(r.title);
    if (r.shortcut) expect(await a.locator('.shortcut').textContent(), r.id).toBe(r.shortcut);
    else await expect(a.locator('.shortcut'), r.id).toHaveCount(0);
    if (r.demo) {
      const tryIt = a.locator('.try-live');
      await expect(tryIt, r.id).toBeVisible();
      await expect(tryIt, r.id).toHaveAttribute('data-live-demo-for', r.id);
      await expect(a.locator('[data-live-demo]'), r.id).toHaveAttribute('data-demo-view', r.demo.view);
    } else {
      await expect(a.locator('.try-live'), r.id).toHaveCount(0);
      await expect(a.locator('[data-live-demo]'), r.id).toHaveCount(0);
    }
  }
  await expect(page.locator('.callout')).toHaveCount(0);
  // After the articles: the list of smaller things, the keys, the closing.
  await expect(page.locator('#more li')).toHaveCount(8);
  await expect(page.locator('#shortcuts li')).toHaveCount(9);
  await expect(page.locator('.final [data-download]')).toBeAttached();
});

test.describe('on a desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('the index stays in view as the page scrolls, under the header, and marks the section in view', async ({ page }) => {
    await page.goto('/features');
    await expect(toc(page).locator('a[aria-current]')).toHaveCount(0); // the page's head: no section yet
    await page.evaluate(() => scrollTo({ top: 3000, behavior: 'instant' }));
    await expect(toc(page)).toBeInViewport();
    expect((await toc(page).boundingBox())!.y).toBeGreaterThanOrEqual(await barBottom(page) - 1);
    for (const [id, label] of [['docker', 'Docker'], ['accounts', 'Claude accounts'], ['more', 'And more'], ['shortcuts', 'Keyboard']]) {
      await page.locator(`#${id}`).evaluate((e) => e.scrollIntoView({ behavior: 'instant' }));
      await expect(toc(page).locator('a[aria-current="location"]'), id).toHaveText(label);
      await expect(toc(page).locator('a[aria-current]'), id).toHaveCount(1);
    }
  });

  test('a click in the index lands on the article, its title just under the header', async ({ page }) => {
    await page.goto('/features');
    await toc(page).getByRole('link', { name: 'Docker', exact: true }).click();
    await expect(page).toHaveURL(/\/features#docker$/);
    const h2 = page.locator('#docker h2');
    // The smooth scroll runs for a moment: wait until it has settled (two reads 300 ms apart agree).
    let last = NaN;
    await expect.poll(async () => { const y = Math.round((await h2.boundingBox())!.y); const still = y === last; last = y; return still; }, { timeout: 6000, intervals: [300] }).toBe(true);
    const y = (await h2.boundingBox())!.y;
    expect(y).toBeGreaterThan(await barBottom(page));
    expect(y).toBeLessThan(await barBottom(page) + 80);
    // The article's top edge is below the header too: nothing of it hides under the bar.
    expect((await page.locator('#docker').boundingBox())!.y).toBeGreaterThanOrEqual(await barBottom(page));
  });

  test('before any interaction: nothing from /demo-app/, no layout shift, no long task after load', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (r) => requests.push(new URL(r.url()).pathname));
    await page.addInitScript(() => {
      const w = window as unknown as { perf: { long: number[]; cls: number } };
      w.perf = { long: [], cls: 0 };
      new PerformanceObserver((l) => { for (const e of l.getEntries()) w.perf.long.push(e.startTime); }).observe({ type: 'longtask', buffered: true });
      new PerformanceObserver((l) => { for (const e of l.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) if (!e.hadRecentInput) w.perf.cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
    });
    await page.mouse.move(4, 600);
    await page.goto('/features', { waitUntil: 'networkidle' });
    await expect(page.locator('[data-live-demo][data-armed]').first()).toBeAttached();
    await page.waitForTimeout(2000);
    const perf = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
      const w = window as unknown as { perf: { long: number[]; cls: number } };
      return { ...w.perf, long: w.perf.long.filter((t) => t >= nav.loadEventStart) };
    });
    expect(requests.filter((p) => p.startsWith('/demo-app/') || /live-demo-stage/i.test(p))).toEqual([]);
    expect(perf.long).toEqual([]);
    expect(perf.cls).toBe(0);
  });
});

test.describe('on a Retina desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  test('every article\'s shot is drawn 1:1', async ({ page }) => {
    await page.goto('/features');
    const shots = page.locator('article.feature .window .frame img');
    await expect(shots).toHaveCount(14);
    for (const img of await shots.all()) await expectOneToOne(img);
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  test('the index is a wrapped row above the first article, not sticky; the shots are the phone crops', async ({ page }) => {
    await page.goto('/features');
    const t = (await toc(page).boundingBox())!;
    expect(t.y + t.height).toBeLessThanOrEqual((await articles(page).first().boundingBox())!.y);
    expect(t.height).toBeLessThan(260);
    expect(await toc(page).evaluate((e) => getComputedStyle(e).position)).not.toBe('sticky');
    await expect(page.locator('.try-live').first()).toBeHidden(); // the demo is a desktop thing
    for (const img of await page.locator('article.feature .window .frame img').all()) await expectPhoneScale(img);
  });

  test('no sideways scroll at 360 px', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto('/features');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  });
});

// The home's old anchors: the rows, the bento and the keys used to live on the home, and links to them are
// out there (search results, chats, the releases README's history). Hashes never reach the server: an inline script
// at the top of the home sends them on before anything is painted.
test.describe('old links to the home\'s sections', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('/#docker lands on /features#docker, the article under the header', async ({ page }) => {
    await page.goto('/#docker');
    await expect(page).toHaveURL(/\/features#docker$/);
    const art = page.locator('#docker');
    await expect(art).toBeInViewport();
    await expect.poll(async () => (await art.boundingBox())!.y).toBeGreaterThanOrEqual(await barBottom(page));
  });

  test('/#features, /#more and /#shortcuts land on the page and its sections; a query string comes along', async ({ page }) => {
    for (const [from, to] of [['/#features', /\/features$/], ['/#more', /\/features#more$/], ['/?ref=readme#redis', /\/features\?ref=readme#redis$/], ['/#shortcuts', /\/features#shortcuts$/]] as const) {
      await page.goto(from);
      await expect(page, from).toHaveURL(to);
    }
    await expect(page.locator('#shortcuts')).toBeInViewport();
  });

  test('/#film stays on the home (the film opens), and so does an unknown hash', async ({ page }) => {
    await page.goto('/#film');
    await expect(page.locator('dialog.film-sheet')).toBeVisible();
    await expect(page).toHaveURL(/\/#film$/);
    await page.goto('/#nope');
    await page.waitForTimeout(300);
    await expect(page).toHaveURL(/\/#nope$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Run many Claude Code sessions/);
  });

  test('the redirect runs before the page paints: an inline script in the head, ahead of every stylesheet and the body', async ({ request }) => {
    const html = await (await request.get('/')).text();
    const at = html.indexOf('location.replace');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(html.indexOf('<link rel="stylesheet"'));
    expect(at).toBeLessThan(html.indexOf('<body'));
    // Every row id is in its list, and nothing that lives on the home (the film).
    const script = html.slice(html.lastIndexOf('<script', at), at);
    for (const r of rows) expect(script).toContain(`"${r.id}"`);
    expect(script).not.toContain('"film"');
  });
});

test('visual check: desktop top, mid-page with the index, phone', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/features');
  await page.waitForTimeout(700);
  await page.screenshot({ path: 'test-results/features-top.png' });
  await page.locator('#redis').evaluate((e) => e.scrollIntoView({ behavior: 'instant' }));
  await page.waitForTimeout(900);
  await page.screenshot({ path: 'test-results/features-mid.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/features-phone.png' });
});
