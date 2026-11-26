import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { THEME_BLOCKS } from '../theme-chrome';
import { remoteLook } from './look';
import type { HostMessage } from './messages';

const FILE = join(__dirname, '../../../tests/fixtures/remote-look-vectors.json');

// The `look` message the iPhone app's tests decode: the default settings with a light theme in use and its terminals
// kept dark, so both of a light theme's color sets are exercised. It holds every theme's colors, so a change to a
// theme's tokens changes it too: written again with ATELIER_WRITE_REMOTE_VECTORS=1, then copied to the iPhone app.
test('the look vector the iPhone app checks is exactly the message this code sends', () => {
  const built: HostMessage = { t: 'look', ...remoteLook({ ...DEFAULT_SETTINGS, theme: 'daylight', terminalColors: 'dark' }, THEME_BLOCKS) };
  if (process.env.ATELIER_WRITE_REMOTE_VECTORS === '1') writeFileSync(FILE, JSON.stringify(built, null, 1) + '\n');
  expect(JSON.parse(readFileSync(FILE, 'utf8')), 'a theme or the look changed: rerun with ATELIER_WRITE_REMOTE_VECTORS=1 and copy tests/fixtures/remote-look-vectors.json to the iPhone app').toEqual(built);
});
