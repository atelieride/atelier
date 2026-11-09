import { expect, test } from '@playwright/test';

test('/support: what it pays for, one button to the Polar checkout, ways to help without money', async ({ page }) => {
  await page.goto('/support');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Atelier is free.');
  const pay = page.getByRole('link', { name: 'Support Atelier' });
  await expect(pay).toHaveAttribute('href', /^https:\/\/buy\.polar\.sh\/polar_cl_\w+\?theme=dark$/); // dark, like the site
  await expect(page.locator('.costs li')).toHaveCount(3);
  await expect(page.locator('.costs')).toContainText('$99 / year');
  await expect(page.locator('.help a')).toHaveCount(2);
  // A bug goes to the repository's issues, on its bug form (.github/ISSUE_TEMPLATE/bug_report.yml).
  await expect(page.locator('.help a', { hasText: 'Report a bug' })).toHaveAttribute('href', 'https://github.com/atelieride/atelier/issues/new?template=bug_report.yml');
  await expect(page.locator('.thanks')).toBeHidden();
});

test('/support?thanks=1, where Polar sends people back after paying, says thank you', async ({ page }) => {
  await page.goto('/support?thanks=1');
  await expect(page.locator('.thanks')).toBeVisible();
  await expect(page.locator('.thanks')).toContainText('Thank you');
});

test('every page links /support from the footer', async ({ page }) => {
  for (const path of ['/', '/download', '/changelog']) {
    await page.goto(path);
    await expect(page.locator('footer').getByRole('link', { name: 'Support' })).toHaveAttribute('href', '/support');
  }
});

test('every download button shows the support note once the DMG is on its way; the header link (just a page) does not', async ({ page }) => {
  const toast = page.locator('.support-toast');
  for (const [path, button] of [['/', '.hero a[data-download]'], ['/', '.final a[data-download]'], ['/download', '.platform.mac a[data-download]']] as const) {
    await page.goto(path);
    await expect(toast, `${path} ${button}`).toBeHidden();
    // Keep the page: the real link hands over a DMG, the preview server has none.
    await page.evaluate(() => document.addEventListener('click', (e) => e.preventDefault()));
    await page.locator(button).click();
    await expect(toast, `${path} ${button}`).toBeVisible();
    await expect(toast.getByRole('link', { name: 'consider supporting it →' })).toHaveAttribute('href', '/support');
    await toast.getByRole('button', { name: 'Close' }).click();
    await expect(toast).toBeHidden();
  }
  await page.goto('/');
  await page.evaluate(() => document.addEventListener('click', (e) => e.preventDefault()));
  await page.locator('header a[data-download]').click();
  await expect(toast).toBeHidden();
});

test('visual check: support page and the download note', async ({ page }) => {
  for (const [w, h, name] of [[1440, 900, 'desktop'], [375, 812, 'phone']] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto('/support?thanks=1');
    await page.evaluate(() => document.querySelectorAll('[data-reveal]').forEach((e) => e.classList.add('is-in')));
    await page.waitForTimeout(700);
    await page.screenshot({ path: `test-results/support-${name}.png`, fullPage: true });
  }
  await page.goto('/');
  await page.evaluate(() => document.addEventListener('click', (e) => e.preventDefault()));
  await page.locator('.hero a[data-download]').click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/download-note-phone.png' });
});

test('the footer links sit on one line, Support included, at every width they fit in', async ({ page }) => {
  for (const width of [1440, 1280, 1024, 900, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/support');
    const centers = await page.locator('footer nav a').evaluateAll((as) => as.map((a) => {
      // The words, not the link boxes: a stretched box can hold its text off-centre (the bug this test caught).
      const range = document.createRange();
      range.selectNodeContents([...a.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim()).pop()!);
      const r = range.getBoundingClientRect();
      return Math.round(r.top + r.height / 2);
    }));
    const first = centers[0];
    const sameRow = centers.filter((c) => Math.abs(c - first) < 12); // a wrapped second row is fine, a half-step is not
    expect(sameRow.length, `${width}px: ${centers}`).toBe(centers.filter((c) => Math.abs(c - first) < 40).length);
    for (const c of sameRow) expect(Math.abs(c - first), `${width}px: ${centers}`).toBeLessThanOrEqual(1);
  }
});

test('the heart is filled, in the footer and on the button', async ({ page }) => {
  await page.goto('/support');
  for (const svg of [page.locator('footer .support svg'), page.locator('.head .btn svg')]) {
    const path = svg.locator('path').first();
    expect(await path.evaluate((p) => getComputedStyle(p).fill)).not.toBe('none');
  }
});

test('the secure checkout line stands out: a lock, in green', async ({ page }) => {
  await page.goto('/support');
  const secure = page.locator('.secure');
  await expect(secure).toContainText('Secure checkout by Polar');
  await expect(secure.locator('svg')).toHaveCount(1);
  expect(await secure.evaluate((e) => getComputedStyle(e).color)).toBe('rgb(52, 211, 153)'); // --done
  // Plain text under the fine print, so it never reads as a second button.
  expect(await secure.evaluate((e) => getComputedStyle(e).borderTopStyle)).toBe('none');
  const fine = (await page.locator('.head .fine').boundingBox())!;
  const box = (await secure.boundingBox())!;
  expect(box.y).toBeGreaterThan(fine.y + fine.height - 1);
  expect(Math.abs(box.x + box.width / 2 - (fine.x + fine.width / 2))).toBeLessThanOrEqual(1);
});

test('footer Support is an outlined pill', async ({ page }) => {
  await page.goto('/support');
  const pill = page.locator('footer .support');
  expect(await pill.evaluate((e) => getComputedStyle(e).borderTopStyle)).toBe('solid');
  expect(await pill.evaluate((e) => parseFloat(getComputedStyle(e).borderTopLeftRadius))).toBeGreaterThan(10);
});
