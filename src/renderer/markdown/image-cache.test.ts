import { expect, test } from 'vitest';
import { createImageCache } from './image-cache';

test('images are kept per path (the newest last) and bounded by count and by size', () => {
  const c = createImageCache(3, 100);
  c.set('/p/a.png', 'a'.repeat(10));
  c.set('/p/b.png', 'b'.repeat(10));
  c.set('/p/c.png', 'c'.repeat(10));
  expect(c.get('/p/a.png')).toBe('a'.repeat(10));
  // Reading a moves it to the newest end: the next one in pushes b out.
  c.set('/p/d.png', 'd'.repeat(10));
  expect(c.get('/p/b.png')).toBeUndefined();
  expect(c.get('/p/a.png')).toBeDefined();
  // Size: one big image pushes the older ones out; one bigger than the budget is not kept at all.
  c.set('/p/e.png', 'e'.repeat(90));
  expect(c.get('/p/c.png')).toBeUndefined();
  expect(c.get('/p/e.png')).toBeDefined();
  c.set('/p/huge.png', 'h'.repeat(101));
  expect(c.get('/p/huge.png')).toBeUndefined();
  expect(c.get('/p/e.png')).toBeDefined();
});
