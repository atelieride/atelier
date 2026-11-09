import { expect, test } from 'vitest';
import { autoReloadToast } from './shell-env-auto';

test('auto-reload toasts: the changed file by name, several counted, a failure says the previous environment stays', () => {
  expect(autoReloadToast({ phase: 'reloading', files: ['/Users/u/.zshrc'] })).toEqual({ text: 'Reloading the shell environment: .zshrc changed…', tone: 'info' });
  expect(autoReloadToast({ phase: 'reloading', files: ['/Users/u/.zshrc', '/Users/u/aliases.zsh'] })).toEqual({ text: 'Reloading the shell environment: 2 files changed…', tone: 'info' });
  expect(autoReloadToast({ phase: 'failed', error: 'timed out' })).toEqual({ text: 'Could not reload the shell environment: timed out. New terminals keep the previous one.', tone: undefined });
});
