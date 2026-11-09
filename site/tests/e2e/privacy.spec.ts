import { expect, test } from '@playwright/test';

// What the app and the site send.
test('privacy: linked from every footer, says what the app and the site send, fits a phone, logs nothing', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  for (const path of ['/', '/download', '/changelog', '/support']) {
    await page.goto(path);
    await expect(page.locator('footer').getByRole('link', { name: 'Privacy' }), path).toHaveAttribute('href', '/privacy');
  }
  await page.goto('/privacy');
  // No absolute claim the page then contradicts: Claude Code, dictation clean-up, commit messages, git and gh do reach
  // the network.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your work stays yours.');
  const main = page.locator('main');
  await expect(main).toContainText('sends nothing about your work to us');
  await expect(main).toContainText('fetches from your project\'s remotes');
  await expect(main).toContainText('GitHub CLI (gh)');
  await expect(main).toContainText('pushes and pulls only when you ask');
  await expect(main).toContainText('When Claude writes a commit message');
  // Ask reaches Claude too (a digest of the session's chat); the compatibility notes never leave the computer.
  await expect(main).toContainText('Only when you ask about a session, Atelier sends a digest of its conversation');
  await expect(main).toContainText('on your computer only: nothing is sent');
  await expect(main).toContainText('the update check sends nothing');
  await expect(main).toContainText('first check of the day, week or month');
  await expect(main).toContainText('Off');
  await expect(main).toContainText('No cookies');
  await expect(main).toContainText('IP addresses are not stored');
  await expect(main).toContainText('Polar');
  // Both systems: the update check is scoped to the Mac (the Windows app asks the Microsoft Store itself), and nothing
  // says "your Mac" for all.
  await expect(main).toContainText('On a Mac, at launch and every six hours');
  await expect(main).toContainText('nothing leaves your computer');
  // Everything that reaches the network is listed: the dictation model's download and the Postgres servers you save.
  await expect(main).toContainText('downloads the transcription model (about 570 MB) from Hugging Face');
  await expect(main).toContainText('connects only to the Postgres servers you save');
  await expect(main).not.toContainText('on your Mac');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://useatelier.dev/privacy');
  for (const [w, h, name] of [[1440, 900, 'desktop'], [375, 812, 'phone']] as const) {
    await page.setViewportSize({ width: w, height: h });
    expect(await page.evaluate(() => document.documentElement.scrollWidth), name).toBeLessThanOrEqual(w);
    await page.screenshot({ path: `test-results/privacy-${name}.png`, fullPage: true });
  }
  expect(errors).toEqual([]);
});
