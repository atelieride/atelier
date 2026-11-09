import { expect, type Locator } from '@playwright/test';

/**
 * How a screenshot in the page is drawn: the chosen file's own width (naturalWidth is already divided by the srcset
 * density, so the file is decoded again), the image's natural width in CSS px, the box it is laid out in, and its
 * object-fit. A Window draws the file across its box; a home tile (object-fit none) draws it at its natural size.
 */
export async function pixels(img: Locator): Promise<{ file: number; natural: number; box: number; fit: string; label: string }> {
  await img.scrollIntoViewIfNeeded();
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
  const label = (await img.getAttribute('alt')) || (await img.evaluate((i) => i.closest('[id], [data-tile]')?.getAttribute('data-tile') ?? i.closest('[id]')?.id ?? '')) || '';
  const m = await img.evaluate(async (i: HTMLImageElement) => {
    const file = new Image();
    file.src = i.currentSrc;
    await file.decode();
    return { file: file.naturalWidth, natural: i.naturalWidth, box: i.getBoundingClientRect().width, fit: getComputedStyle(i).objectFit };
  });
  return { ...m, label };
}

/** The width the image's pixels are drawn at, in CSS px. */
export const drawn = (p: { natural: number; box: number; fit: string }) => (p.fit === 'none' ? p.natural : p.box);

/** On a 2× screen, one image pixel per screen pixel: never resampled, the app's text at its real size. */
export async function expectOneToOne(img: Locator) {
  const p = await pixels(img);
  expect(drawn(p) * 2, p.label).toBe(p.file);
}

/** On a phone, a crop made for it: one app pixel (the shots are 2×) drawn as 0.9–1.15 CSS px. */
export async function expectPhoneScale(img: Locator) {
  const p = await pixels(img);
  const scale = drawn(p) / (p.file / 2);
  expect(scale, p.label).toBeGreaterThanOrEqual(0.9);
  expect(scale, p.label).toBeLessThanOrEqual(1.15);
}
