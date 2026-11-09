import { expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ResumeNote } from './InlineConfirm';

// The close question's last line: where the session comes back from. A scheduled prompt
// of a closed session waits only until its time (plus the grace): the note never promises more.

// Sunday 25 Oct 2026, 12:48 local.
const NOW = new Date(2026, 9, 25, 12, 48).getTime();
const text = (props: Parameters<typeof ResumeNote>[0]) => renderToStaticMarkup(createElement(ResumeNote, props)).replace(/<[^>]+>/g, '');

test('not kept: the palette, as before', () => {
  expect(text({ note: 'history' })).toBe('Resume it later from ⌘K › Resume a session…');
});

test('kept: it waits under Resume', () => {
  expect(text({ note: 'resume' })).toBe('It waits under Resume.');
});

test('kept with a prompt to come: sent only if resumed by its time', () => {
  expect(text({ note: 'resume-scheduled', promptAt: new Date(2026, 9, 26, 3, 0).getTime(), now: NOW }))
    .toBe('It waits under Resume. Its prompt scheduled tomorrow at 03:00 is sent only if you resume it by then.');
});

test('kept with a prompt already due (waiting for Claude): only if resumed right away', () => {
  expect(text({ note: 'resume-scheduled', promptAt: NOW - 60_000, now: NOW }))
    .toBe('It waits under Resume. Its due prompt is sent only if you resume it right away.');
});
