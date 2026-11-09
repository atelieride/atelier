import { expect, test } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import { portsNeedRestart, restartNotice } from './daemon-notice';
import { t } from './i18n/en';

const term = (pid?: number) => ({ id: 'x', pid } as TerminalInfo);

test('ports need a restart only when there are terminals and none carries a pid (an atelierd older than v2.1)', () => {
  expect(portsNeedRestart([], true)).toBe(false);
  expect(portsNeedRestart([term(), term()], true)).toBe(true);
  expect(portsNeedRestart([term(), term(42)], true)).toBe(false);
  expect(portsNeedRestart([term(42)], true)).toBe(false);
  // With the chips turned off there is nothing to restart for.
  expect(portsNeedRestart([term()], false)).toBe(false);
});

test('one notice: the v2.0 texts unchanged without ports; ports joined into the same sentence', () => {
  const all = { profiles: true, states2: true, ports: true };
  expect(restartNotice(all)).toBeNull();
  expect(restartNotice({ ...all, profiles: false, states2: false })).toBe(t.set.bothNeedRestart);
  expect(restartNotice({ ...all, profiles: false })).toBe(t.set.profilesNeedRestart);
  expect(restartNotice({ ...all, states2: false })).toBe(t.set.states2NeedRestart);
  expect(restartNotice({ ...all, ports: false })).toBe('Restart atelierd to show listening ports (closes running terminals; Claude sessions can be resumed).');
  expect(restartNotice({ profiles: true, states2: false, ports: false })).toBe('Restart atelierd to get richer session states, command blocks and listening ports (closes running terminals; Claude sessions can be resumed).');
  expect(restartNotice({ profiles: false, states2: false, ports: false })).toBe('Terminal profiles, richer session states, command blocks and listening ports need a newer atelierd. Restart atelierd (closes running terminals; Claude sessions can be resumed).');
  expect(restartNotice({ profiles: false, states2: true, ports: false })).toBe('Terminal profiles and listening ports need a newer atelierd. Restart atelierd (closes running terminals; Claude sessions can be resumed).');
});

test('background work: its own notice when it is the only thing missing; otherwise the same one notice', () => {
  const all = { profiles: true, states2: true, ports: true, background: true };
  expect(restartNotice(all)).toBeNull();
  expect(restartNotice({ ...all, background: false })).toBe('Restart atelierd to see background work (closes running terminals; Claude sessions can be resumed).');
  // Something else missing too: the existing sentence (one notice, one restart button); the restart brings both.
  expect(restartNotice({ ...all, states2: false, background: false })).toBe(t.set.states2NeedRestart);
  expect(restartNotice({ ...all, ports: false, background: false })).toBe(t.set.portsNeedRestart);
});

test('aliases from the user\'s shell: their own notice when only they are missing, with background work when both are', () => {
  const all = { profiles: true, states2: true, ports: true, background: true, aliases: true };
  expect(restartNotice(all)).toBeNull();
  expect(restartNotice({ ...all, aliases: false })).toBe('Restart atelierd to get your shell\'s aliases in Atelier terminals (closes running terminals; Claude sessions can be resumed).');
  expect(restartNotice({ ...all, background: false, aliases: false })).toBe('Restart atelierd to see background work and get your shell\'s aliases in Atelier terminals (closes running terminals; Claude sessions can be resumed).');
  expect(restartNotice({ ...all, states2: false, aliases: false })).toBe(t.set.states2NeedRestart);
});

test('session name sync: its own notice when it is the only thing missing; any other restart brings it too', () => {
  const all = { profiles: true, states2: true, ports: true, background: true, aliases: true, names: true };
  expect(restartNotice(all)).toBeNull();
  expect(restartNotice({ ...all, names: false })).toBe('Restart atelierd to keep session names in step with Claude (closes running terminals; Claude sessions can be resumed).');
  expect(restartNotice({ ...all, aliases: false, names: false })).toBe(t.set.aliasesNeedRestart);
  expect(restartNotice({ ...all, ports: false, names: false })).toBe(t.set.portsNeedRestart);
});
