import { _electron as electron, expect, test } from '@playwright/test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Videos in a tab: played from an atelier-media: token, seeking through byte
// ranges, a format Chromium can't play said so, a file deleted or replaced on disk followed, paused when hidden.
// tests/fixtures/media/clip.mp4: 160×90, 2 s, H.264 (made once with AVFoundation).
const CLIP = resolve('tests/fixtures/media/clip.mp4');

test('a video plays in its tab: metadata, seeking, paused when hidden; a broken one says so; deleted and replaced on disk', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  mkdirSync(join(project, 'media'));
  const reel = join(project, 'media', 'reel #1 è.mp4');
  copyFileSync(CLIP, reel);
  writeFileSync(join(project, 'media', 'broken.mp4'), Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919) % 256)));
  writeFileSync(join(project, 'notes.md'), '# notes\n');
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await win.getByRole('button', { name: /Files/ }).click();
    await win.locator('.tree-row', { hasText: 'media' }).click();

    // A file Chromium can't play: said so, with Reveal in Finder (not clicked: it would open Finder). A failed load first
    // asks for a new token once — a token main dropped (64 per window) fails like a bad file
    // — so the player had exactly two URLs: no loop.
    await win.evaluate(() => {
      const seen = new Set<string>();
      (window as unknown as { videoSrcs: Set<string> }).videoSrcs = seen;
      new MutationObserver(() => document.querySelectorAll('.video-view video').forEach((v) => seen.add((v as HTMLVideoElement).src)))
        .observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
    });
    await win.locator('.tree-row', { hasText: 'broken.mp4' }).click();
    const broken = win.locator('.video-view:visible');
    await expect(broken.locator('.file-empty')).toContainText("This video can't be played here: its format isn't supported.", { timeout: 10000 });
    await expect(broken.getByRole('button', { name: 'Reveal in Finder' })).toBeVisible();
    expect(await win.evaluate(() => (window as unknown as { videoSrcs: Set<string> }).videoSrcs.size)).toBe(2);

    // The reel (kept open: a double click), its URL the token only (never the name), metadata in the footer, seeking
    // answered by ranges.
    await win.locator('.tree-row', { hasText: 'reel #1 è.mp4' }).dblclick();
    const view = win.locator('.video-view:visible');
    const video = win.locator('.video-view video');
    await expect(video).toHaveAttribute('src', /^atelier-media:\/\/v\/[0-9a-f]{64}$/);
    await expect(view.locator('.file-foot')).toContainText('160 × 90 · 0:02 · 3.9 KB', { timeout: 10000 });
    await expect(view.locator('.file-foot')).toContainText('MP4');
    const at = await video.evaluate((v: HTMLVideoElement) => new Promise<number>((done) => { v.addEventListener('seeked', () => done(v.currentTime), { once: true }); v.currentTime = 1.5; }));
    expect(at).toBeGreaterThan(1.4);
    await win.mouse.move(5, 300);
    await look(view, 'test-results/video-tab.png');

    // Playing, then another tab in front: paused.
    await video.evaluate((v: HTMLVideoElement) => { v.loop = true; v.muted = true; v.currentTime = 0; return v.play(); });
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
    await win.locator('.tree-row', { hasText: 'notes.md' }).click();
    await expect(win.locator('.video-view')).toBeHidden();
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);

    // Deleted while its tab is open: says so. Back on disk: plays again from the start, with a new token.
    await win.locator('.tree-row', { hasText: 'reel #1 è.mp4' }).click();
    const first = await video.getAttribute('src');
    rmSync(reel);
    await expect(view.locator('.file-empty')).toContainText('The file no longer exists.', { timeout: 10000 });
    copyFileSync(CLIP, reel);
    await expect(win.locator('.video-view video')).toHaveCount(1, { timeout: 10000 });
    await expect(view.locator('.file-foot')).toContainText('160 × 90 · 0:02', { timeout: 10000 });
    expect(await video.getAttribute('src')).not.toBe(first);
    expect(await video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBe(0);
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});
