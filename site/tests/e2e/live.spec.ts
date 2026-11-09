import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// The screenshots the site replays live (tests/e2e/site-shots.manual.ts writes their spots next to the PNG).
const spots = (name: string) => JSON.parse(readFileSync(new URL(`../../src/assets/shots/${name}.live.json`, import.meta.url), 'utf8')) as
  { width: number; height: number; spots: { kind: string; x: number; y: number; w: number; h: number }[] };

for (const [name, frame] of [['overview', '.hero .frame']] as const) {
  test(`${name}: one live layer per measured spot, each exactly over its spot in the image`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    const data = spots(name);
    const layers = page.locator(`${frame} .live-spot`);
    await expect(layers).toHaveCount(data.spots.length);
    // The hero frame rises in on load: measure once it has landed, or the frame and its layers are read mid-flight.
    await page.locator(frame).evaluate((e) => Promise.all(e.getAnimations().map((a) => a.finished)));
    const box = (await page.locator(frame).boundingBox())!;
    const scale = box.width / data.width;
    for (let i = 0; i < data.spots.length; i++) {
      const s = data.spots[i]!;
      const b = (await layers.nth(i).boundingBox())!;
      expect(Math.abs(b.x - (box.x + s.x * scale)), `${name} #${i} x`).toBeLessThan(1);
      expect(Math.abs(b.y - (box.y + s.y * scale)), `${name} #${i} y`).toBeLessThan(1);
      expect(Math.abs(b.width - s.w * scale), `${name} #${i} width`).toBeLessThan(1);
    }
  });
}

test('the live layers move with motion on and stand still with reduced motion', async ({ browser }) => {
  for (const [reducedMotion, moving] of [['no-preference', true], ['reduce', false]] as const) {
    const ctx = await browser.newContext({ reducedMotion });
    const page = await ctx.newPage();
    await page.goto('/');
    const names = await page.locator('.hero .live-spot').evaluateAll((els) => els.map((e) => getComputedStyle(e).animationName));
    expect(names.length).toBeGreaterThan(0);
    // Our own animations, not the app's: theme.css has global classes (.pulse) a layer must not pick up.
    expect(names.every((n) => n.startsWith('live-')), reducedMotion).toBe(moving);
    expect(names.every((n) => n === 'none'), reducedMotion).toBe(!moving);
    await ctx.close();
  }
});

test('the other screenshots stay still', async ({ page }) => {
  await page.goto('/');
  for (const id of ['ask', 'workspace', 'background', 'scheduled', 'docker', 'changes', 'automations', 'editor', 'dictation', 'accounts', 'alive', 'sessions']) await expect(page.locator(`#${id} .live-spot`)).toHaveCount(0);
});
