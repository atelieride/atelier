import { expect, test } from 'vitest';
import { imageMime, isLargeText, videoMime, type FileContent } from './files';

test('a large text is any text past 5 MB, whatever else makes it read-only (Latin-1, UTF-16, inside .git)', () => {
  const text = (size: number, readOnly?: 'not-utf8' | 'git-internal' | 'large'): FileContent => ({ kind: 'text', path: '/p/a.log', rel: 'a.log', text: '', size, mtimeMs: 0, hash: '', ...(readOnly ? { readOnly } : {}) });
  const MB = 1024 * 1024;
  expect(isLargeText(text(6 * MB, 'large'))).toBe(true);
  expect(isLargeText(text(6 * MB, 'not-utf8'))).toBe(true);
  expect(isLargeText(text(6 * MB, 'git-internal'))).toBe(true);
  expect(isLargeText(text(5 * MB))).toBe(false);
  expect(isLargeText(text(10, 'not-utf8'))).toBe(false);
  expect(isLargeText({ kind: 'too-large', path: '/p/a.log', rel: 'a.log', size: 6 * MB })).toBe(false);
  expect(isLargeText(null)).toBe(false);
});

test('videos a tab plays by extension, any case; anything else is not one', () => {
  expect(videoMime('/p/reel.mp4')).toBe('video/mp4');
  expect(videoMime('/p/IMG_0042.MOV')).toBe('video/quicktime');
  expect(videoMime('/p/clip.m4v')).toBe('video/mp4');
  expect(videoMime('/p/clip.webm')).toBe('video/webm');
  expect(videoMime('/p/clip.ogv')).toBe('video/ogg');
  expect(videoMime('/p/reel #1 è?.mp4')).toBe('video/mp4');
  expect(videoMime('/p/movie.mkv')).toBeNull();
  expect(videoMime('/p/a.png')).toBeNull();
  expect(videoMime('/p/mp4')).toBeNull();
  expect(videoMime('/p/.mp4')).toBeNull();
});

test('images the app shows by extension (any case); SVG stays text, so does anything else', () => {
  expect(imageMime('/p/a.png')).toBe('image/png');
  expect(imageMime('/p/Screen Shot.JPG')).toBe('image/jpeg');
  expect(imageMime('/p/a.jpeg')).toBe('image/jpeg');
  expect(imageMime('/p/a.gif')).toBe('image/gif');
  expect(imageMime('/p/a.webp')).toBe('image/webp');
  expect(imageMime('/p/a.bmp')).toBe('image/bmp');
  expect(imageMime('/p/favicon.ico')).toBe('image/x-icon');
  expect(imageMime('/p/a.avif')).toBe('image/avif');
  expect(imageMime('/p/logo.svg')).toBeNull();
  expect(imageMime('/p/a.ts')).toBeNull();
  expect(imageMime('/p/png')).toBeNull();
  expect(imageMime('/p/.png')).toBeNull();
});
