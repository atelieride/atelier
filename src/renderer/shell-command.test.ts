import { expect, test } from 'vitest';
import { shellCommandToast } from './shell-command';

test('every outcome of Install / Uninstall says what happened; a cancelled password prompt says nothing', () => {
  expect(shellCommandToast({ ok: 'installed' })).toBe('Installed: run “atelier <file>” in any terminal.');
  expect(shellCommandToast({ ok: 'already' })).toBe('The atelier command is already installed.');
  expect(shellCommandToast({ ok: 'uninstalled' })).toBe('The atelier command was removed.');
  expect(shellCommandToast({ error: 'dev' })).toBe('Only the installed Atelier can change the atelier command.');
  expect(shellCommandToast({ error: 'foreign', detail: '/usr/local/bin/atelier' })).toBe('Something else is at /usr/local/bin/atelier: left as it is.');
  expect(shellCommandToast({ error: 'not-installed' })).toBe("The atelier command isn't installed.");
  expect(shellCommandToast({ error: 'failed', detail: 'EROFS' })).toBe("Couldn't change the atelier command: EROFS.");
  expect(shellCommandToast({ error: 'cancelled' })).toBeNull();
});
