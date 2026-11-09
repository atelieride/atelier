import { expect, test } from 'vitest';
import { SENSITIVE, SHOTS_ONLY, findBanned } from './banned-strings';

test('real paths, names and companies are caught, case-insensitively where it matters', () => {
  expect(findBanned('cwd=/Users/someone/code', SENSITIVE)).toEqual(['/Users/']);
  expect(findBanned('DOCSY ops', SENSITIVE)).toEqual(['DOCSY']);
  expect(findBanned('/var/folders/x/T/atl-run-AbC123/acme', SENSITIVE)).toEqual(['/var/folders', 'atl-run-']);
  expect(findBanned(['someone.musso', 'gmail.com'].join('@'), [...SENSITIVE, ...SHOTS_ONLY])).toEqual(['gmail', 'musso']);
  expect(findBanned('Made by Francesco Musso', SENSITIVE)).toEqual([]);
  expect(findBanned('Made by Francesco Musso', SHOTS_ONLY)).toHaveLength(2);
});

test('every test temp folder is caught, whatever its prefix (atl-shots-home-, atl-tour-…)', () => {
  expect(findBanned('~/x/atl-shots-home-Ab12Cd/code', SENSITIVE)).toEqual(['atl-shots-home-']);
  expect(findBanned('atl-tour-xyz', SENSITIVE)).toEqual(['atl-tour-']);
});

test('the app\'s animation names in the site CSS are not temp folders', () => {
  expect(findBanned('@keyframes atl-pulse-dot{} .x{animation:atl-fade-target 1s}', SENSITIVE)).toEqual([]);
});

test('fictional demo content passes', () => {
  expect(findBanned('~/code/acme-store · auth-refactor · Ada Lovelace <ada@example.com>', [...SENSITIVE, ...SHOTS_ONLY])).toEqual([]);
});
