import { expect, test } from 'vitest';
import { changelogDot } from '../../src/lib/changelog-dot';

test('first visit: no dot, the latest version is remembered', () => {
  expect(changelogDot(null, '0.2.0-beta.8', false)).toEqual({ show: false, store: '0.2.0-beta.8' });
});

test('nothing new since the last visit to the changelog: no dot, nothing to store', () => {
  expect(changelogDot('0.2.0-beta.8', '0.2.0-beta.8', false)).toEqual({ show: false, store: null });
});

test('a version came out since: the dot shows until the changelog is opened', () => {
  expect(changelogDot('0.2.0-beta.7', '0.2.0-beta.8', false)).toEqual({ show: true, store: null });
  expect(changelogDot('0.2.0-beta.7', '0.2.0-beta.8', true)).toEqual({ show: false, store: '0.2.0-beta.8' });
});

test('on the changelog with nothing new: nothing to store', () => {
  expect(changelogDot('0.2.0-beta.8', '0.2.0-beta.8', true)).toEqual({ show: false, store: null });
});
