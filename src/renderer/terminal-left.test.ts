import { expect, test } from 'vitest';
import { leftTheList } from './terminal-left';

// A terminal gone from this window's list (ended, or moved to another project's window): its xterm goes, so coming back
// it attaches anew instead of showing a frozen screen.

test('the ids the last list had and this one hasn\'t; none before a first list; one not listed yet (a create reply) never', () => {
  expect(leftTheList(null, [{ id: 'a' }])).toEqual([]);
  expect(leftTheList(new Set(['a', 'b']), [{ id: 'b' }, { id: 'c' }])).toEqual(['a']);
  expect(leftTheList(new Set(['a']), [{ id: 'a' }])).toEqual([]);
});
