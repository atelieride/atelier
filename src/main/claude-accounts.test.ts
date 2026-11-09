import { describe, expect, test } from 'vitest';
import { posixTest } from '../../tests/support/platform';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import { normalizeAccounts, type ClaudeAccounts } from '@shared/claude-accounts';
import { encodeProjectPath } from '@shared/history';
import type { Resumable } from '@shared/protocol';
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings';
import { accountDirOf, accountsOf, defaultConfigDir, historyResume, historyRoots, launchFlags, restartCommand, resumeConfigDir, resumeFields, sessionCommand } from './claude-accounts';

const D = '/Users/x/.claude';
const OPS = '/Users/x/.claude_ops';
const SID = '0b5c8f0e-1111-4222-8333-944455556666';
const accs = (over: Partial<ClaudeAccounts> = {}) => normalizeAccounts({ list: [{ id: 'default', name: 'Claude', dir: '', color: 1 }, { id: 'ops', name: 'Ops', dir: OPS, color: 2 }], ...over })!;
const settings = (a: ClaudeAccounts = accs(), over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, claudeAccounts: a, ...over });
const resumable = (over: Partial<Resumable> = {}): Resumable => ({ id: 'r1', projectRoot: '/p', cwd: '/p/app', title: 'T', color: '#fff', sessionId: SID, endedAt: 1, ...over });
const files = (...paths: string[]) => async (p: string) => paths.includes(p);
const convo = (dir: string) => `${dir}/projects/${encodeProjectPath('/p/app')}/${SID}.jsonl`;

describe('main: Claude accounts', () => {
  // POSIX: POSIX config-dir fixtures through node:path.
  test('defaultConfigDir on Windows: canonical, as the dirs sessions report (C:/Users/x/.claude)', () => {
    initPlatform('win32');
    try {
      expect(defaultConfigDir({}, 'C:\\Users\\x')).toBe('C:/Users/x/.claude');
      expect(defaultConfigDir({ CLAUDE_CONFIG_DIR: 'D:\\claude' }, 'C:\\Users\\x')).toBe('D:/claude');
    } finally { resetPlatformForTests(); }
  });

  posixTest('defaultConfigDir: CLAUDE_CONFIG_DIR of main, else ~/.claude', () => {
    expect(defaultConfigDir({}, '/Users/x')).toBe(D);
    expect(defaultConfigDir({ CLAUDE_CONFIG_DIR: '/c' }, '/Users/x')).toBe('/c');
  });
  test('accountsOf: the settings as they apply here (an account at the default dir is the default)', () => {
    expect(accountsOf(settings(accs({ list: [{ id: 'default', name: 'C', dir: '', color: 1 }, { id: 'x', name: 'X', dir: D, color: 1 }] })), D).list).toHaveLength(1);
  });
  test('sessionCommand: the default account byte-identical to before; another with its dir', () => {
    expect(sessionCommand(settings(), D, undefined, 'x')).toBe(`claude --name='x'`);
    expect(sessionCommand(settings(accs(), { claudeModel: 'opus' }), D, 'ops', 'x')).toBe(`CLAUDE_CONFIG_DIR='${OPS}' claude --name='x' --model opus`);
  });
  posixTest('sessionCommand: the launch flags of the account it starts with, ~ expanded; none with noFlags', () => {
    const claudeFlags = { all: [['--add-dir', '~/notes']], accounts: { ops: { flags: [['--dangerously-skip-permissions']], shared: true } } };
    const s = settings(accs(), { claudePermissionMode: 'auto', claudeFlags });
    expect(sessionCommand(s, D, undefined, 'x', { home: '/Users/x' })).toBe(`claude --name='x' --permission-mode auto '--add-dir' '/Users/x/notes'`);
    expect(sessionCommand(s, D, 'ops', 'x', { home: '/Users/x' })).toBe(`CLAUDE_CONFIG_DIR='${OPS}' claude --name='x' '--add-dir' '/Users/x/notes' '--dangerously-skip-permissions'`);
    expect(sessionCommand(settings(accs({ newSession: 'ops' }), { claudeFlags }), D, undefined, 'x', { home: '/Users/x' })).toContain(`'--dangerously-skip-permissions'`);
    expect(sessionCommand(s, D, 'ops', 'x', { home: '/Users/x', noFlags: true })).toBe(`CLAUDE_CONFIG_DIR='${OPS}' claude --name='x' --permission-mode auto`);
    const solo = settings(accs(), { claudeFlags: { all: [['--ide']], accounts: { ops: { flags: [], shared: false } } } });
    expect(sessionCommand(solo, D, 'ops', 'x')).toBe(`CLAUDE_CONFIG_DIR='${OPS}' claude --name='x'`);
  });
  test('launchFlags: a flag the home folder made invalid is left out (Windows: a home with ! in it)', () => {
    initPlatform('win32');
    try {
      const s = settings(accs(), { claudeFlags: { all: [['--add-dir', '~/notes'], ['--ide']], accounts: {} } });
      expect(launchFlags(s, 'default', 'C:\\Users\\Hi!')).toEqual([['--ide']]);
      expect(launchFlags(s, 'default', 'C:\\Users\\me')).toEqual([['--add-dir', 'C:\\Users\\me/notes'], ['--ide']]);
    } finally { resetPlatformForTests(); }
  });
  test('resumeConfigDir: the stored dir when it is an account\'s; null for the default', async () => {
    expect(await resumeConfigDir(resumable({ configDir: OPS }), accs(), D, files())).toBe(OPS);
    expect(await resumeConfigDir(resumable({ configDir: D }), accs(), D, files())).toBeNull();
  });
  test('resumeConfigDir: a removed account\'s dir resumes with the default (Review Focus 2)', async () => {
    expect(await resumeConfigDir(resumable({ configDir: '/Users/x/.claude_gone' }), accs(), D, files(convo('/Users/x/.claude_gone')))).toBeNull();
  });
  // POSIX: POSIX config-dir fixtures through node:path.
  posixTest('resumeConfigDir: no stored dir (older atelierd) → the account whose folder has the conversation, the default first', async () => {
    expect(await resumeConfigDir(resumable(), accs(), D, files(convo(OPS)))).toBe(OPS);
    expect(await resumeConfigDir(resumable(), accs(), D, files(convo(D), convo(OPS)))).toBeNull();
    expect(await resumeConfigDir(resumable(), accs(), D, files())).toBeNull();
  });
  // POSIX: POSIX config-dir fixtures through node:path.
  posixTest('historyRoots: the default projects folder first, then each account\'s', () => {
    expect(historyRoots(accs(), '/fake/projects')).toEqual([{ account: 'default', dir: '/fake/projects' }, { account: 'ops', dir: `${OPS}/projects` }]);
  });
  test('historyResume: a conversation of the default account resumes with it, even when new sessions start elsewhere', () => {
    expect(historyResume(accs({ newSession: 'ops' }), undefined)).toEqual({ account: 'default', dir: undefined });
    expect(historyResume(accs(), 'ops')).toEqual({ account: 'ops', dir: OPS });
    expect(() => historyResume(accs(), 'gone')).toThrow(/account/);
  });
  posixTest('restartCommand: the session\'s account and its current launch flags, no model or mode', () => {
    const claudeFlags = { all: [['--ide']], accounts: { ops: { flags: [['--dangerously-skip-permissions']], shared: true } } };
    const s = settings(accs(), { claudeModel: 'opus', claudePermissionMode: 'plan', claudeFlags });
    expect(restartCommand(s, D, D, SID)).toBe(`claude --resume '${SID}' '--ide'`);
    expect(restartCommand(s, D, undefined, SID)).toBe(`claude --resume '${SID}' '--ide'`);
    expect(restartCommand(s, D, OPS, SID)).toBe(`CLAUDE_CONFIG_DIR='${OPS}' claude --resume '${SID}' '--ide' '--dangerously-skip-permissions'`);
    // A dir no account has any more (removed): the default account, as a resume does.
    expect(restartCommand(s, D, '/Users/x/.claude_gone', SID)).toBe(`claude --resume '${SID}' '--ide'`);
    expect(() => restartCommand(s, D, D, 'not an id; rm -rf ~')).toThrow(/session id/);
  });
  test('restartCommand on Windows: PowerShell quoting, another account\'s dir set for the command only (review 14)', () => {
    initPlatform('win32');
    try {
      const W = 'C:/Users/x/.claude';
      const WD = 'C:/Users/x/.claude_ops';
      const a = normalizeAccounts({ list: [{ id: 'default', name: 'Claude', dir: '', color: 1 }, { id: 'ops', name: 'Ops', dir: WD, color: 2 }] })!;
      const s = settings(a, { claudeFlags: { all: [['--ide']], accounts: {} } });
      expect(restartCommand(s, W, W, SID)).toBe(`claude --resume '${SID}' '--ide'`);
      expect(restartCommand(s, W, WD, SID)).toBe(`& { $p = $env:CLAUDE_CONFIG_DIR; $env:CLAUDE_CONFIG_DIR = '${WD}'; try { claude --resume '${SID}' '--ide' } finally { $env:CLAUDE_CONFIG_DIR = $p } }`);
    } finally { resetPlatformForTests(); }
  });
  test('accountDirOf: a session\'s dir only when it is a configured account\'s; the default, unknown or none → undefined', () => {
    expect(accountDirOf(OPS, accs(), D)).toBe(OPS);
    expect(accountDirOf(D, accs(), D)).toBeUndefined();
    expect(accountDirOf('/Users/x/.claude_qa', accs(), D)).toBeUndefined();
    expect(accountDirOf(undefined, accs(), D)).toBeUndefined();
  });
  test('resumeFields: the dir (or null) only for an atelierd with resume-config-dir; an older one gets today\'s message', () => {
    expect(resumeFields(true, OPS)).toEqual({ configDir: OPS });
    expect(resumeFields(true, null)).toEqual({ configDir: null });
    expect(resumeFields(false, OPS)).toEqual({});
    expect(resumeFields(false, null)).toEqual({});
  });
  test('resumeConfigDir: a lookup that throws counts as not found', async () => {
    expect(await resumeConfigDir(resumable(), accs(), D, async () => { throw new Error('EACCES'); })).toBeNull();
  });
});
