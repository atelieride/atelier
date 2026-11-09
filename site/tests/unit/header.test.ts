import { expect, test } from 'vitest';
import { activePage, pathSegment } from '../../src/lib/header';

// The header in one row, as a path.

test('the page the header marks: Features and Changelog only (the home is the path itself)', () => {
  expect(activePage('/features')).toBe('features');
  expect(activePage('/features.html')).toBe('features');
  expect(activePage('/changelog')).toBe('changelog');
  expect(activePage('/changelog/')).toBe('changelog');
  expect(activePage('/')).toBe(null);
  expect(activePage('/index.html')).toBe(null);
  expect(activePage('/download')).toBe(null); // the download is the header's button, not a page link
  expect(activePage('/nope')).toBe(null);
});

test('the path\'s last segment: the page, none on the home or the 404', () => {
  expect(pathSegment('/')).toBe(null);
  expect(pathSegment('/index.html')).toBe(null);
  expect(pathSegment('/features')).toBe('features');
  expect(pathSegment('/features.html')).toBe('features');
  expect(pathSegment('/privacy/')).toBe('privacy');
  expect(pathSegment('/changelog')).toBe('changelog');
  expect(pathSegment('/404')).toBe(null);
  expect(pathSegment('/404.html')).toBe(null);
});
