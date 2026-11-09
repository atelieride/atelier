import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { SettingsStore } from './settings-store';
import { expectMode } from '../../tests/support/platform';

const tmp = () => mkdtempSync(join(tmpdir(), 'atl-set-'));

test('missing or broken file: defaults, and no file written until something changes', () => {
  const dir = tmp();
  expect(new SettingsStore(join(dir, 'p.json')).get()).toEqual(DEFAULT_SETTINGS);
  writeFileSync(join(dir, 'bad.json'), '{');
  expect(new SettingsStore(join(dir, 'bad.json')).get()).toEqual(DEFAULT_SETTINGS);
  expect(() => statSync(join(dir, 'p.json'))).toThrow();
});

test('a valid change is saved (0600), re-read and announced', () => {
  const file = join(tmp(), 'p.json');
  const s = new SettingsStore(file);
  const seen: number[] = [];
  s.onChange((x) => seen.push(x.terminalFontSize));
  expect(s.set({ terminalFontSize: 15 })?.terminalFontSize).toBe(15);
  expect(seen).toEqual([15]);
  expectMode(file, 0o600);
  expect(JSON.parse(readFileSync(file, 'utf8')).terminalFontSize).toBe(15);
  expect(new SettingsStore(file).get().terminalFontSize).toBe(15);
});

test('an invalid change is rejected and changes nothing', () => {
  const file = join(tmp(), 'p.json');
  const s = new SettingsStore(file);
  let calls = 0;
  s.onChange(() => calls++);
  expect(s.set({ terminalFontSize: 99 })).toBeNull();
  expect(s.set({ claudePermissionMode: 'bypassPermissions' })).toBeNull();
  expect(s.set('x')).toBeNull();
  expect(s.set({ nope: true })).toBeNull();
  expect(calls).toBe(0);
  expect(s.get()).toEqual(DEFAULT_SETTINGS);
});

test('reset: all defaults', () => {
  const s = new SettingsStore(join(tmp(), 'p.json'));
  s.set({ editorFontSize: 18, wordWrap: true });
  expect(s.reset()).toEqual(DEFAULT_SETTINGS);
});

test('if saving fails the in-memory value does not change (main and windows stay in sync)', () => {
  const dir = tmp();
  const s = new SettingsStore(join(dir, 'missing-dir', 'sub', 'p.json'));
  // A folder in place of the file: the atomic write fails.
  const blocked = new SettingsStore(dir);
  let calls = 0;
  blocked.onChange(() => calls++);
  expect(() => blocked.set({ terminalFontSize: 15 })).toThrow();
  expect(blocked.get().terminalFontSize).toBe(DEFAULT_SETTINGS.terminalFontSize);
  expect(calls).toBe(0);
  expect(s.get()).toEqual(DEFAULT_SETTINGS);
});

test('terminal profile: only shells listed in /etc/shells; an unlisted one in the file falls back to Atelier', () => {
  const file = join(tmp(), 'p.json');
  const shells = ['/bin/bash', '/bin/sh'];
  const s = new SettingsStore(file, { shells: () => shells });
  expect(s.set({ terminalProfile: '/bin/bash' })?.terminalProfile).toBe('/bin/bash');
  expect(s.set({ terminalProfile: '/usr/bin/python3' })).toBeNull();
  expect(s.get().terminalProfile).toBe('/bin/bash');
  expect(new SettingsStore(file, { shells: () => shells }).get().terminalProfile).toBe('/bin/bash');
  // The shell was uninstalled (or removed from /etc/shells) since: Atelier.
  expect(new SettingsStore(file, { shells: () => ['/bin/sh'] }).get().terminalProfile).toBe('atelier');
  // No list given: no shell is accepted.
  expect(new SettingsStore(file).get().terminalProfile).toBe('atelier');
});

test('a file that cannot be read as settings is set aside (never overwritten by the next change) and logged', () => {
  const dir = tmp();
  const file = join(dir, 'preferences.json');
  writeFileSync(file, '{"terminalFontSize": 15,');
  const logged: string[] = [];
  const s = new SettingsStore(file, { log: (m) => logged.push(m) });
  expect(s.get()).toEqual(DEFAULT_SETTINGS);
  const aside = readdirSync(dir).filter((n) => n.startsWith('preferences.json.bad-'));
  expect(aside).toHaveLength(1);
  expect(readFileSync(join(dir, aside[0]!), 'utf8')).toBe('{"terminalFontSize": 15,');
  expect(logged).toEqual([expect.stringContaining(aside[0]!)]);
  s.set({ editorFontSize: 18 });
  expect(readFileSync(join(dir, aside[0]!), 'utf8')).toBe('{"terminalFontSize": 15,');
  // Not settings at all (an array, a string): set aside too.
  writeFileSync(file, '[1]');
  new SettingsStore(file, { log: () => {} });
  expect(readdirSync(dir).filter((n) => n.startsWith('preferences.json.bad-'))).toHaveLength(2);
});

test('a missing file is nothing to set aside', () => {
  const dir = tmp();
  const logged: string[] = [];
  new SettingsStore(join(dir, 'preferences.json'), { log: (m) => logged.push(m) });
  expect(readdirSync(dir)).toEqual([]);
  expect(logged).toEqual([]);
});

test('absent: the keys the file did not have when Atelier started (a missing file has none), for one-time migrations', () => {
  const dir = tmp();
  expect(new SettingsStore(join(dir, 'none.json')).absent('automationsEnabled')).toBe(true);
  writeFileSync(join(dir, 'old.json'), JSON.stringify({ theme: 'aurora' }));
  const old = new SettingsStore(join(dir, 'old.json'));
  expect(old.absent('automationsEnabled')).toBe(true);
  expect(old.absent('theme')).toBe(false);
  // Still the file as Atelier found it: a change saved since doesn't count.
  old.set({ automationsEnabled: true });
  expect(old.absent('automationsEnabled')).toBe(true);
  writeFileSync(join(dir, 'new.json'), JSON.stringify({ automationsEnabled: false }));
  expect(new SettingsStore(join(dir, 'new.json')).absent('automationsEnabled')).toBe(false);
});
