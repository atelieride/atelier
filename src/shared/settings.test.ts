import { expect, test } from 'vitest';
import { setTestDefaultPlatform } from './platform';
import { DEFAULT_SETTINGS, OPEN_IN_APP_SETTING, applyPatch, normalizeSettings, opensInApp, trafficLights, WINDOW_BAR, windowButtons, zoomFactor } from './settings';
import { settingsPatchSchema } from '../main/ipc-schemas';
import { DEFAULT_TRIGGERS } from './triggers';
import { DEFAULT_ACCOUNTS } from './claude-accounts';

// Launch flags.
const accounts2 = { list: [{ id: 'default', name: 'Claude', dir: '', color: 1 }, { id: 'work', name: 'Work', dir: '/w', color: 2 }], newSession: 'default', dismissed: [] };
test('claudeFlags: normalized, and pruned against the accounts', () => {
  expect(DEFAULT_SETTINGS.claudeFlags).toEqual({ all: [], accounts: {} });
  const flags = { all: [['--verbose'], ['--model', 'x']], accounts: { work: { flags: [['--ide']], shared: false }, gone: { flags: [['--ide']], shared: true } } };
  const s = normalizeSettings({ claudeAccounts: accounts2, claudeFlags: flags });
  expect(s.claudeFlags).toEqual({ all: [['--verbose']], accounts: { work: { flags: [['--ide']], shared: false } } });
  // Removing the account drops its flags: a new account taking the id back starts with none.
  const removed = applyPatch(s, { claudeAccounts: { ...accounts2, list: [accounts2.list[0]!] } });
  expect(removed.claudeFlags.accounts).toEqual({});
  expect(normalizeSettings({ claudeFlags: 'x' }).claudeFlags).toEqual({ all: [], accounts: {} });
});
test('claudeFlags patch: strict and already normalized', () => {
  const ok = { all: [['--add-dir', '/a b']], accounts: { work: { flags: [], shared: false } } };
  expect(settingsPatchSchema.safeParse({ claudeFlags: ok }).success).toBe(true);
  for (const bad of [
    { all: [['--model', 'opus']], accounts: {} },
    { all: [['--verbose'], ['--verbose']], accounts: {} },
    { all: [], accounts: { work: { flags: [], shared: true } } },
    { all: [], accounts: {}, extra: 1 },
    { all: [['--x', 'a\nb']], accounts: {} },
    { all: [['--verbose', '--dangerously-skip-permissions']], accounts: {} },
    { all: [['--add-dir', '--settings', '/x']], accounts: {} },
    { all: [] }
  ]) expect(settingsPatchSchema.safeParse({ claudeFlags: bad }).success, JSON.stringify(bad)).toBe(false);
});

test('no file: the defaults', () => {
  expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  expect(normalizeSettings('garbage')).toEqual(DEFAULT_SETTINGS);
  expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
});

test('repoSearchDepth: 3 levels by default; 1–5 accepted, anything else back to the default', () => {
  expect(DEFAULT_SETTINGS.repoSearchDepth).toBe(3);
  for (const v of [1, 3, 5]) {
    expect(normalizeSettings({ repoSearchDepth: v }).repoSearchDepth).toBe(v);
    expect(settingsPatchSchema.safeParse({ repoSearchDepth: v }).success).toBe(true);
  }
  for (const v of [0, 6, 2.5, '3', null]) expect(normalizeSettings({ repoSearchDepth: v }).repoSearchDepth).toBe(3);
  expect(settingsPatchSchema.safeParse({ repoSearchDepth: 6 }).success).toBe(false);
});

test('autoFetch: "when viewing" by default; intervals and off accepted, anything else back to the default', () => {
  expect(DEFAULT_SETTINGS.autoFetch).toBe('viewing');
  for (const v of ['viewing', '15m', '30m', '60m', 'off'] as const) {
    expect(normalizeSettings({ autoFetch: v }).autoFetch).toBe(v);
    expect(settingsPatchSchema.safeParse({ autoFetch: v }).success).toBe(true);
  }
  expect(normalizeSettings({ autoFetch: '5m' }).autoFetch).toBe('viewing');
  expect(normalizeSettings({ autoFetch: true }).autoFetch).toBe('viewing');
  expect(settingsPatchSchema.safeParse({ autoFetch: '1m' }).success).toBe(false);
});

test('git writes: actions on, ✦ with Haiku, prompts used, like my commits, co-author on; anything else back to the default', () => {
  expect(DEFAULT_SETTINGS).toMatchObject({ gitActions: 'on', commitMessages: 'haiku', commitUsePrompts: true, commitLanguage: 'commits', commitCoAuthor: true });
  const accepted = { gitActions: ['on', 'read-only'], commitMessages: ['haiku', 'sonnet', 'off'], commitLanguage: ['commits', 'english'], commitUsePrompts: [true, false], commitCoAuthor: [true, false] } as const;
  for (const [key, values] of Object.entries(accepted)) {
    for (const v of values) {
      expect(normalizeSettings({ [key]: v })[key as keyof typeof accepted]).toBe(v);
      expect(settingsPatchSchema.safeParse({ [key]: v }).success).toBe(true);
    }
  }
  const bad = normalizeSettings({ gitActions: 'off', commitMessages: 'opus', commitLanguage: 'it', commitUsePrompts: 'yes', commitCoAuthor: 1 });
  expect(bad).toMatchObject({ gitActions: 'on', commitMessages: 'haiku', commitUsePrompts: true, commitLanguage: 'commits', commitCoAuthor: true });
  expect(settingsPatchSchema.safeParse({ gitActions: 'off' }).success).toBe(false);
  expect(settingsPatchSchema.safeParse({ commitMessages: 'opus' }).success).toBe(false);
});

test('commit with nothing staged: ask by default; stage-all and never kept; anything else asks', () => {
  expect(DEFAULT_SETTINGS.commitNothingStaged).toBe('ask');
  for (const v of ['ask', 'stage-all', 'never'] as const) {
    expect(normalizeSettings({ commitNothingStaged: v }).commitNothingStaged).toBe(v);
    expect(settingsPatchSchema.safeParse({ commitNothingStaged: v }).success).toBe(true);
  }
  expect(normalizeSettings({ commitNothingStaged: 'yes' }).commitNothingStaged).toBe('ask');
  expect(settingsPatchSchema.safeParse({ commitNothingStaged: 'always' }).success).toBe(false);
});

test('optionAsMeta: off by default, so ⌥ types @ # [ ] { } ~ on non-US layouts (Italian ⌥ò is @)', () => {
  expect(DEFAULT_SETTINGS.optionAsMeta).toBe(false);
  expect(normalizeSettings({ optionAsMeta: true }).optionAsMeta).toBe(true);
});

test('openTasksInApp: on by default (the desktop app when installed), a boolean the patch schema accepts', () => {
  expect(DEFAULT_SETTINGS.openTasksInApp).toBe(true);
  expect(normalizeSettings({ openTasksInApp: false }).openTasksInApp).toBe(false);
  expect(normalizeSettings({ openTasksInApp: 'yes' }).openTasksInApp).toBe(true);
  expect(settingsPatchSchema.safeParse({ openTasksInApp: false }).success).toBe(true);
});

test('openNotionTasksInApp: Notion has its own toggle, on by default; each source reads its own', () => {
  expect(DEFAULT_SETTINGS.openNotionTasksInApp).toBe(true);
  expect(normalizeSettings({ openNotionTasksInApp: false }).openNotionTasksInApp).toBe(false);
  expect(normalizeSettings({ openNotionTasksInApp: 1 }).openNotionTasksInApp).toBe(true);
  expect(settingsPatchSchema.safeParse({ openNotionTasksInApp: false }).success).toBe(true);
  // Jira has no desktop app: no toggle, never "in the app".
  expect(OPEN_IN_APP_SETTING).toEqual({ clickup: 'openTasksInApp', notion: 'openNotionTasksInApp', jira: null });
  expect(opensInApp(normalizeSettings({ openTasksInApp: true, openNotionTasksInApp: true }), 'jira')).toBe(false);
  const s = normalizeSettings({ openTasksInApp: true, openNotionTasksInApp: false });
  expect(opensInApp(s, 'clickup')).toBe(true);
  expect(opensInApp(s, 'notion')).toBe(false);
});

test('an invalid value goes back to default, the others stay', () => {
  const s = normalizeSettings({ terminalFontSize: 99, editorFontSize: 15, cursorStyle: 'triangle', claudeModel: 'sonnet' });
  expect(s.terminalFontSize).toBe(DEFAULT_SETTINGS.terminalFontSize);
  expect(s.editorFontSize).toBe(15);
  expect(s.cursorStyle).toBe(DEFAULT_SETTINGS.cursorStyle);
  expect(s.claudeModel).toBe('sonnet');
});

test('unknown keys discarded', () => {
  const s = normalizeSettings({ evil: 'rm -rf', terminalFontSize: 14 }) as unknown as Record<string, unknown>;
  expect(s.evil).toBeUndefined();
  expect(s.terminalFontSize).toBe(14);
});

test('numbers: integers where needed, line height in steps of 0.05', () => {
  expect(normalizeSettings({ terminalFontSize: 13.5 }).terminalFontSize).toBe(DEFAULT_SETTINGS.terminalFontSize);
  expect(normalizeSettings({ terminalLineHeight: 1.25 }).terminalLineHeight).toBe(1.25);
  expect(normalizeSettings({ terminalLineHeight: 1.234 }).terminalLineHeight).toBe(1.25);
  expect(normalizeSettings({ terminalLineHeight: 3 }).terminalLineHeight).toBe(DEFAULT_SETTINGS.terminalLineHeight);
  expect(normalizeSettings({ scrollback: 500 }).scrollback).toBe(DEFAULT_SETTINGS.scrollback);
  expect(normalizeSettings({ scrollback: Number.NaN }).scrollback).toBe(DEFAULT_SETTINGS.scrollback);
});

test('terminal font: JetBrains Mono by default, any plain family name, junk back to it', () => {
  expect(DEFAULT_SETTINGS.terminalFontFamily).toBe('JetBrains Mono');
  expect(normalizeSettings({ terminalFontFamily: 'Fira Code' }).terminalFontFamily).toBe('Fira Code');
  for (const bad of ['', 'a"b', 'a\\b', ' Menlo', 'a\nb', 'x'.repeat(101), 13]) {
    expect(normalizeSettings({ terminalFontFamily: bad }).terminalFontFamily).toBe('JetBrains Mono');
  }
  expect(settingsPatchSchema.safeParse({ terminalFontFamily: 'MesloLGS NF' }).success).toBe(true);
  for (const bad of ['', 'Menlo"; } body { x', 'a\\b', 'x'.repeat(101), null]) {
    expect(settingsPatchSchema.safeParse({ terminalFontFamily: bad }).success).toBe(false);
  }
});

test('the dangerous permission is not among the choices', () => {
  expect(normalizeSettings({ claudePermissionMode: 'bypassPermissions' }).claudePermissionMode).toBe('inherit');
  expect(settingsPatchSchema.safeParse({ claudePermissionMode: 'bypassPermissions' }).success).toBe(false);
});

test('patch: strict, every field optional', () => {
  expect(settingsPatchSchema.safeParse({}).success).toBe(true);
  expect(settingsPatchSchema.safeParse({ terminalFontSize: 14 }).success).toBe(true);
  expect(settingsPatchSchema.safeParse({ terminalFontSize: 30 }).success).toBe(false);
  expect(settingsPatchSchema.safeParse({ terminalFontSize: '14' }).success).toBe(false);
  expect(settingsPatchSchema.safeParse({ other: 1 }).success).toBe(false);
  expect(settingsPatchSchema.safeParse({ claudeModel: 'opus; rm -rf ~' }).success).toBe(false);
});

test('claudeAccounts: the default account alone by default; junk back to it', () => {
  expect(normalizeSettings({}).claudeAccounts).toEqual(DEFAULT_ACCOUNTS);
  expect(normalizeSettings({ claudeAccounts: 'x' }).claudeAccounts).toEqual(DEFAULT_ACCOUNTS);
  // A copy: nothing downstream can change the shared default.
  expect(normalizeSettings({}).claudeAccounts.list).not.toBe(DEFAULT_ACCOUNTS.list);
  const ops = { id: 'ops', name: 'Ops', dir: '/Users/x/.claude_ops', color: 2 };
  expect(normalizeSettings({ claudeAccounts: { list: [ops], newSession: 'ops' } }).claudeAccounts.list.map((a) => a.id)).toEqual(['default', 'ops']);
});

test('claudeAccounts patch: only already normal values, strictly shaped', () => {
  const ok = { list: [{ id: 'default', name: 'Claude', dir: '', color: 1 }, { id: 'ops', name: 'Ops', dir: '/Users/x/.claude_ops', color: 2 }], newSession: 'ops', dismissed: ['/Users/x/.c2'] };
  expect(settingsPatchSchema.safeParse({ claudeAccounts: ok }).success).toBe(true);
  const bad = [
    { ...ok, extra: 1 },
    { ...ok, list: [ok.list[0], { ...ok.list[1], dir: 'rel' }] },
    { ...ok, list: [ok.list[1], ok.list[0]] },
    { ...ok, list: [ok.list[0], { ...ok.list[1], evil: true }] },
    { ...ok, newSession: 'gone' },
    { ...ok, dismissed: ['rel'] },
    { ...ok, list: [ok.list[0], { ...ok.list[1], name: ' Ops ' }] }
  ];
  for (const b of bad) expect(settingsPatchSchema.safeParse({ claudeAccounts: b }).success, JSON.stringify(b)).toBe(false);
});

test('applyPatch merges and normalizes', () => {
  const s = applyPatch(DEFAULT_SETTINGS, { terminalFontSize: 16, notifyDone: true });
  expect(s.terminalFontSize).toBe(16);
  expect(s.notifyDone).toBe(true);
  expect(s.editorFontSize).toBe(DEFAULT_SETTINGS.editorFontSize);
});

test('zoomFactor for the interface size', () => {
  expect(zoomFactor('small')).toBe(0.9);
  expect(zoomFactor('default')).toBe(1);
  expect(zoomFactor('large')).toBe(1.1);
  expect(zoomFactor('larger')).toBe(1.25);
});

test('window traffic lights centered in the header at every interface size', () => {
  expect(trafficLights(1)).toEqual({ x: 16, y: 17 });
  expect(trafficLights(1.25)).toEqual({ x: 20, y: 23 });
  expect(trafficLights(0.9)).toEqual({ x: 14, y: 15 });
});

test('Windows: the caption buttons as tall as the one bar (46 px) of every window, at every interface size', () => {
  expect(WINDOW_BAR).toBe(46);
  expect(windowButtons(1, WINDOW_BAR, '#C9C7E6')).toEqual({ color: '#00000000', symbolColor: '#C9C7E6', height: 46 });
  expect(windowButtons(1.25, WINDOW_BAR, '#C9C7E6')).toEqual({ color: '#00000000', symbolColor: '#C9C7E6', height: 58 });
  expect(windowButtons(0.9, WINDOW_BAR, '#C9C7E6')).toEqual({ color: '#00000000', symbolColor: '#C9C7E6', height: 41 });
});

test('permission mode: by default the one from the Claude settings; Ask, Auto, Accept edits and Plan on choice', () => {
  expect(DEFAULT_SETTINGS.claudePermissionMode).toBe('inherit');
  for (const m of ['inherit', 'default', 'auto', 'acceptEdits', 'plan']) expect(normalizeSettings({ claudePermissionMode: m }).claudePermissionMode).toBe(m);
  expect(settingsPatchSchema.safeParse({ claudePermissionMode: 'auto' }).success).toBe(true);
  expect(settingsPatchSchema.safeParse({ claudePermissionMode: 'dontAsk' }).success).toBe(false);
});

test('dictation: off by default, ⌥Space shortcut, values outside the list rejected', () => {
  expect(DEFAULT_SETTINGS.dictationEnabled).toBe(false);
  expect(DEFAULT_SETTINGS.dictationShortcut).toBe('alt-space');
  expect(DEFAULT_SETTINGS.dictationPolish).toBe(true);
  expect(DEFAULT_SETTINGS.dictationAutoSend).toBe(false);
  expect(normalizeSettings({ dictationShortcut: 'cmd-q' }).dictationShortcut).toBe('alt-space');
  expect(normalizeSettings({ dictationKeepLoaded: 'always' }).dictationKeepLoaded).toBe('always');
  expect(settingsPatchSchema.safeParse({ dictationLanguage: 'fr' }).success).toBe(false);
  expect(settingsPatchSchema.safeParse({ dictationLanguage: 'it' }).success).toBe(true);
});

test('preview tabs: on by default, a boolean, validated by the patch schema', () => {
  expect(DEFAULT_SETTINGS.previewTabs).toBe(true);
  expect(normalizeSettings({ previewTabs: false }).previewTabs).toBe(false);
  expect(normalizeSettings({ previewTabs: 'no' }).previewTabs).toBe(true);
  expect(settingsPatchSchema.safeParse({ previewTabs: false }).success).toBe(true);
  expect(settingsPatchSchema.safeParse({ previewTabs: 0 }).success).toBe(false);
});

test('swapped side panels: off by default (sidebar left, Changes right), a boolean, validated by the patch schema', () => {
  expect(DEFAULT_SETTINGS.swapSidePanels).toBe(false);
  expect(normalizeSettings({ swapSidePanels: true }).swapSidePanels).toBe(true);
  expect(normalizeSettings({ swapSidePanels: 'yes' }).swapSidePanels).toBe(false);
  expect(settingsPatchSchema.safeParse({ swapSidePanels: true }).success).toBe(true);
  expect(settingsPatchSchema.safeParse({ swapSidePanels: 1 }).success).toBe(false);
});

test('session avatars: on by default (nothing changes for anyone), a boolean, validated by the patch schema', () => {
  expect(DEFAULT_SETTINGS.sessionAvatars).toBe(true);
  expect(normalizeSettings({ sessionAvatars: false }).sessionAvatars).toBe(false);
  expect(normalizeSettings({ sessionAvatars: 'no' }).sessionAvatars).toBe(true);
  expect(settingsPatchSchema.safeParse({ sessionAvatars: false }).success).toBe(true);
  expect(settingsPatchSchema.safeParse({ sessionAvatars: 0 }).success).toBe(false);
});

test('terminal profile: Atelier by default; zsh (your config) or a listed shell on choice; anything else falls back to Atelier', () => {
  expect(DEFAULT_SETTINGS.terminalProfile).toBe('atelier');
  expect(normalizeSettings({ terminalProfile: 'user' }).terminalProfile).toBe('user');
  const shells = ['/bin/bash', '/bin/sh'];
  expect(normalizeSettings({ terminalProfile: '/bin/bash' }, { shells }).terminalProfile).toBe('/bin/bash');
  expect(normalizeSettings({ terminalProfile: '/usr/local/bin/evil' }, { shells }).terminalProfile).toBe('atelier');
  expect(normalizeSettings({ terminalProfile: 'bash' }, { shells }).terminalProfile).toBe('atelier');
  expect(normalizeSettings({ terminalProfile: 42 }).terminalProfile).toBe('atelier');
  expect(applyPatch(DEFAULT_SETTINGS, { terminalProfile: '/bin/zsh-gone' }, { shells }).terminalProfile).toBe('atelier');
  // Without a list (renderer side) only the shape is checked.
  expect(normalizeSettings({ terminalProfile: '/opt/homebrew/bin/fish' }).terminalProfile).toBe('/opt/homebrew/bin/fish');
  expect(settingsPatchSchema.safeParse({ terminalProfile: 'atelier' }).success).toBe(true);
  expect(settingsPatchSchema.safeParse({ terminalProfile: '/bin/bash' }).success).toBe(true);
  expect(settingsPatchSchema.safeParse({ terminalProfile: 'bash' }).success).toBe(false);
  expect(settingsPatchSchema.safeParse({ terminalProfile: { shell: '/bin/bash' } }).success).toBe(false);
  expect(settingsPatchSchema.safeParse({ terminalProfile: '/' + 'a'.repeat(5000) }).success).toBe(false);
});

test('output triggers: two disabled examples on first run, an empty list kept, invalid rules dropped from the file', () => {
  expect(DEFAULT_SETTINGS.triggers).toEqual(DEFAULT_TRIGGERS);
  expect(normalizeSettings({}).triggers).toEqual(DEFAULT_TRIGGERS);
  expect(normalizeSettings({ triggers: 'x' }).triggers).toEqual(DEFAULT_TRIGGERS);
  expect(normalizeSettings({ triggers: [] }).triggers).toEqual([]);
  const ok = { id: 'a', pattern: '/fail(ed)?/i', action: 'notify', scope: 'sessions', enabled: true };
  expect(normalizeSettings({ triggers: [ok, { ...ok, id: 'b', pattern: '/(a+)+/' }] }).triggers).toEqual([ok]);
  // The defaults are a copy: editing the settings never changes them.
  expect(normalizeSettings({}).triggers).not.toBe(DEFAULT_TRIGGERS);
  expect(DEFAULT_SETTINGS.notifyTriggers).toBe(true);
});

test('output triggers: the patch schema is strict (shape, ids, pattern validity, size)', () => {
  const ok = { id: 'a', pattern: 'tests failed', action: 'notify', scope: 'all', enabled: true };
  expect(settingsPatchSchema.safeParse({ triggers: [ok] }).success).toBe(true);
  expect(settingsPatchSchema.safeParse({ triggers: [] }).success).toBe(true);
  for (const bad of [
    { ...ok, extra: 1 }, { ...ok, id: 'no spaces' }, { ...ok, pattern: '' }, { ...ok, pattern: '/(a+)+/' }, { ...ok, pattern: '/a(/' },
    { ...ok, pattern: 'x'.repeat(201) }, { ...ok, action: 'run' }, { ...ok, scope: 'mars' }, { ...ok, enabled: 1 }
  ]) expect(settingsPatchSchema.safeParse({ triggers: [bad] }).success, JSON.stringify(bad).slice(0, 80)).toBe(false);
  expect(settingsPatchSchema.safeParse({ triggers: [ok, ok] }).success).toBe(false);
  expect(settingsPatchSchema.safeParse({ triggers: Array.from({ length: 51 }, (_, i) => ({ ...ok, id: `r${i}` })) }).success).toBe(false);
  expect(settingsPatchSchema.safeParse({ notifyTriggers: false }).success).toBe(true);
});

test('session tray icons: on by default, a boolean, validated by the patch schema', () => {
  expect(DEFAULT_SETTINGS.trayIcons).toBe(true);
  expect(normalizeSettings({ trayIcons: false }).trayIcons).toBe(false);
  expect(normalizeSettings({ trayIcons: 'no' }).trayIcons).toBe(true);
  expect(settingsPatchSchema.safeParse({ trayIcons: false }).success).toBe(true);
  expect(settingsPatchSchema.safeParse({ trayIcons: 1 }).success).toBe(false);
});

test('command blocks: on by default, a boolean, validated by the patch schema', () => {
  expect(DEFAULT_SETTINGS.commandBlocks).toBe(true);
  expect(normalizeSettings({ commandBlocks: false }).commandBlocks).toBe(false);
  expect(normalizeSettings({ commandBlocks: 'no' }).commandBlocks).toBe(true);
  expect(settingsPatchSchema.safeParse({ commandBlocks: false }).success).toBe(true);
  expect(settingsPatchSchema.safeParse({ commandBlocks: 1 }).success).toBe(false);
});

test('click to move the cursor: on by default, a boolean, validated by the patch schema', () => {
  expect(DEFAULT_SETTINGS.clickMovesCursor).toBe(true);
  expect(normalizeSettings({ clickMovesCursor: false }).clickMovesCursor).toBe(false);
  expect(normalizeSettings({ clickMovesCursor: 'no' }).clickMovesCursor).toBe(true);
  expect(settingsPatchSchema.safeParse({ clickMovesCursor: false }).success).toBe(true);
  expect(settingsPatchSchema.safeParse({ clickMovesCursor: 1 }).success).toBe(false);
});

test('aliases from the user\'s shell: on by default, a boolean, validated by the patch schema', () => {
  expect(DEFAULT_SETTINGS.terminalAliases).toBe(true);
  expect(normalizeSettings({ terminalAliases: false }).terminalAliases).toBe(false);
  expect(normalizeSettings({ terminalAliases: 'no' }).terminalAliases).toBe(true);
  expect(settingsPatchSchema.safeParse({ terminalAliases: false }).success).toBe(true);
  expect(settingsPatchSchema.safeParse({ terminalAliases: 1 }).success).toBe(false);
});

test('listening ports: shown by default, a boolean, validated by the patch schema', () => {
  expect(DEFAULT_SETTINGS.showPorts).toBe(true);
  expect(normalizeSettings({ showPorts: false }).showPorts).toBe(false);
  expect(normalizeSettings({ showPorts: 'no' }).showPorts).toBe(true);
  expect(settingsPatchSchema.safeParse({ showPorts: false }).success).toBe(true);
  expect(settingsPatchSchema.safeParse({ showPorts: 1 }).success).toBe(false);
});

test('pull request and CI status: on by default, a boolean, validated by the patch schema', () => {
  expect(DEFAULT_SETTINGS.prStatus).toBe(true);
  expect(normalizeSettings({ prStatus: false }).prStatus).toBe(false);
  expect(normalizeSettings({ prStatus: 'no' }).prStatus).toBe(true);
  expect(settingsPatchSchema.safeParse({ prStatus: false }).success).toBe(true);
  expect(settingsPatchSchema.safeParse({ prStatus: 1 }).success).toBe(false);
});

test('update channel: "auto" (the build\'s own) by default, then off, stable or beta; nothing else', () => {
  expect(DEFAULT_SETTINGS.updateChannel).toBe('auto');
  expect(normalizeSettings({ updateChannel: 'beta' }).updateChannel).toBe('beta');
  expect(normalizeSettings({ updateChannel: 'nightly' }).updateChannel).toBe('auto');
  expect(settingsPatchSchema.safeParse({ updateChannel: 'off' }).success).toBe(true);
  expect(settingsPatchSchema.safeParse({ updateChannel: 'https://evil' }).success).toBe(false);
});

test('background work: counted as Working by default, ephemeral ports hidden by default', () => {
  expect(DEFAULT_SETTINGS.countBackgroundWork).toBe(true);
  expect(DEFAULT_SETTINGS.showEphemeralPorts).toBe(false);
  const s = normalizeSettings({ countBackgroundWork: false, showEphemeralPorts: true });
  expect([s.countBackgroundWork, s.showEphemeralPorts]).toEqual([false, true]);
  expect(normalizeSettings({ countBackgroundWork: 'no', showEphemeralPorts: 1 })).toMatchObject({ countBackgroundWork: true, showEphemeralPorts: false });
  expect(settingsPatchSchema.safeParse({ countBackgroundWork: false, showEphemeralPorts: true }).success).toBe(true);
  expect(settingsPatchSchema.safeParse({ showEphemeralPorts: 'yes' }).success).toBe(false);
});

test('closing a window: asks when busy by default; stop and keep are the others', () => {
  expect(DEFAULT_SETTINGS.closeWindowSessions).toBe('ask');
  expect(normalizeSettings({ closeWindowSessions: 'keep' }).closeWindowSessions).toBe('keep');
  expect(normalizeSettings({ closeWindowSessions: 'never' }).closeWindowSessions).toBe('ask');
  expect(settingsPatchSchema.safeParse({ closeWindowSessions: 'stop' }).success).toBe(true);
  expect(settingsPatchSchema.safeParse({ closeWindowSessions: 'kill' }).success).toBe(false);
});

test('keeping closed sessions under Resume: off by default, a boolean', () => {
  expect(DEFAULT_SETTINGS.keepClosedSessions).toBe(false);
  expect(normalizeSettings({ keepClosedSessions: true }).keepClosedSessions).toBe(true);
  expect(normalizeSettings({ keepClosedSessions: 'yes' }).keepClosedSessions).toBe(false);
  expect(settingsPatchSchema.safeParse({ keepClosedSessions: true }).success).toBe(true);
  expect(settingsPatchSchema.safeParse({ keepClosedSessions: 'yes' }).success).toBe(false);
});

test('⌘J follows sessions into other workspaces: on by default, a boolean', () => {
  expect(DEFAULT_SETTINGS.wsJumpFollows).toBe(true);
  expect(normalizeSettings({ wsJumpFollows: false }).wsJumpFollows).toBe(false);
  expect(normalizeSettings({ wsJumpFollows: 'no' }).wsJumpFollows).toBe(true);
  expect(settingsPatchSchema.safeParse({ wsJumpFollows: false }).success).toBe(true);
  expect(settingsPatchSchema.safeParse({ wsJumpFollows: 'no' }).success).toBe(false);
});

test('Services (tmux) and Automations: off until turned on in Settings (2026-11-02), booleans', () => {
  expect(DEFAULT_SETTINGS.showServices).toBe(false);
  expect(DEFAULT_SETTINGS.automationsEnabled).toBe(false);
  expect(normalizeSettings({ showServices: true, automationsEnabled: true })).toMatchObject({ showServices: true, automationsEnabled: true });
  expect(normalizeSettings({ showServices: 'yes', automationsEnabled: 1 })).toMatchObject({ showServices: false, automationsEnabled: false });
  expect(settingsPatchSchema.safeParse({ showServices: true, automationsEnabled: false }).success).toBe(true);
  expect(settingsPatchSchema.safeParse({ automationsEnabled: 'on' }).success).toBe(false);
});

test('workspaces in every project (2026-11-02): off by default (each project decides), a boolean', () => {
  expect(DEFAULT_SETTINGS.workspacesEverywhere).toBe(false);
  expect(normalizeSettings({ workspacesEverywhere: true }).workspacesEverywhere).toBe(true);
  expect(normalizeSettings({ workspacesEverywhere: 'yes' }).workspacesEverywhere).toBe(false);
  expect(settingsPatchSchema.safeParse({ workspacesEverywhere: true }).success).toBe(true);
});

test('shell environment auto-reload: on by default, a boolean', () => {
  expect(DEFAULT_SETTINGS.shellEnvAutoReload).toBe(true);
  expect(normalizeSettings({ shellEnvAutoReload: false }).shellEnvAutoReload).toBe(false);
  expect(normalizeSettings({ shellEnvAutoReload: 'no' }).shellEnvAutoReload).toBe(true);
  expect(settingsPatchSchema.safeParse({ shellEnvAutoReload: false }).success).toBe(true);
  expect(settingsPatchSchema.safeParse({ shellEnvAutoReload: 0 }).success).toBe(false);
});

test('checked files: absolute paths only, deduplicated, at most 20, invalid ones dropped from the file', () => {
  expect(DEFAULT_SETTINGS.shellEnvWatchFiles).toEqual([]);
  expect(normalizeSettings({}).shellEnvWatchFiles).toEqual([]);
  expect(normalizeSettings({ shellEnvWatchFiles: 'x' }).shellEnvWatchFiles).toEqual([]);
  expect(normalizeSettings({ shellEnvWatchFiles: ['/a/.aliases', 'rel/x', '', 3, '/a/.aliases', '/b\u0000c', '/' + 'x'.repeat(1024), '/b/x.zsh'] }).shellEnvWatchFiles)
    .toEqual(['/a/.aliases', '/b/x.zsh']);
  const many = Array.from({ length: 25 }, (_, i) => `/f/${i}`);
  expect(normalizeSettings({ shellEnvWatchFiles: many }).shellEnvWatchFiles).toEqual(many.slice(0, 20));
  // A list default is a copy, never the shared constant.
  expect(normalizeSettings({}).shellEnvWatchFiles).not.toBe(DEFAULT_SETTINGS.shellEnvWatchFiles);
  expect(settingsPatchSchema.safeParse({ shellEnvWatchFiles: ['/a', '/b'] }).success).toBe(true);
  expect(settingsPatchSchema.safeParse({ shellEnvWatchFiles: [] }).success).toBe(true);
  for (const bad of [['rel'], [''], ['/a', '/a'], ['/' + 'x'.repeat(1024)], [1], Array.from({ length: 21 }, (_, i) => `/f/${i}`), '/a'])
    expect(settingsPatchSchema.safeParse({ shellEnvWatchFiles: bad }).success, JSON.stringify(bad).slice(0, 60)).toBe(false);
});

test('Docker: Auto, a detected engine, others listed, notified, 5,000 lines', () => {
  expect(DEFAULT_SETTINGS).toMatchObject({ showDocker: 'auto', dockerSocket: '', dockerOthers: true, dockerNotify: true, dockerLogLines: 5000 });
  expect(normalizeSettings({ showDocker: 'never', dockerSocket: '/Users/me/.colima/x/docker.sock', dockerOthers: false, dockerNotify: false, dockerLogLines: 12000 }))
    .toMatchObject({ showDocker: 'never', dockerSocket: '/Users/me/.colima/x/docker.sock', dockerOthers: false, dockerNotify: false, dockerLogLines: 12000 });
  // A custom path is absolute or empty; the history a step of 1,000 between 1,000 and 20,000.
  expect(normalizeSettings({ dockerSocket: 'rel/docker.sock', dockerLogLines: 25000, showDocker: 'sometimes' })).toMatchObject({ dockerSocket: '', dockerLogLines: 5000, showDocker: 'auto' });
  expect(normalizeSettings({ dockerLogLines: 1499 }).dockerLogLines).toBe(1000);
  expect(normalizeSettings({ dockerSocket: '/a\u0000b' }).dockerSocket).toBe('');
  expect(settingsPatchSchema.safeParse({ dockerSocket: '' }).success).toBe(true);
  expect(settingsPatchSchema.safeParse({ dockerSocket: '/var/run/docker.sock' }).success).toBe(true);
  expect(settingsPatchSchema.safeParse({ dockerSocket: 'tcp://1.2.3.4:2375' }).success).toBe(false);
  expect(settingsPatchSchema.safeParse({ showDocker: 'always', dockerLogLines: 2000 }).success).toBe(true);
});

test('Redis: Auto, no custom instances, Ask first, monitor and queues on, notify off, 10,000 keys', () => {
  expect(DEFAULT_SETTINGS).toMatchObject({ showRedis: 'auto', redisInstances: [], redisEdits: 'ask', redisMonitor: true, redisQueues: true, redisNotify: false, redisScanKeys: 10000 });
  expect(normalizeSettings({ showRedis: 'never', redisEdits: 'readonly', redisMonitor: false, redisQueues: false, redisNotify: true, redisScanKeys: 50000 }))
    .toMatchObject({ showRedis: 'never', redisEdits: 'readonly', redisMonitor: false, redisQueues: false, redisNotify: true, redisScanKeys: 50000 });
  // Custom instances: loopback URLs and sockets, stored passwordless, deduplicated; remote hosts and TLS dropped.
  expect(normalizeSettings({ redisInstances: ['redis://:pw@localhost:6390', 'redis://127.0.0.1:6390', '/tmp/r.sock', 'redis://10.0.0.1:6379', 'rediss://127.0.0.1:1', 7] }).redisInstances)
    .toEqual(['redis://127.0.0.1:6390', '/tmp/r.sock']);
  expect(normalizeSettings({ redisScanKeys: 200000, redisEdits: 'yolo' })).toMatchObject({ redisScanKeys: 10000, redisEdits: 'ask' });
  expect(settingsPatchSchema.safeParse({ redisInstances: ['redis://127.0.0.1:6390', '/tmp/r.sock'] }).success).toBe(true);
  for (const bad of [['redis://:pw@127.0.0.1:6390'], ['redis://10.0.0.1:6379'], ['/a', '/a'], Array.from({ length: 17 }, (_, i) => `/s/${i}.sock`)])
    expect(settingsPatchSchema.safeParse({ redisInstances: bad }).success, JSON.stringify(bad).slice(0, 60)).toBe(false);
  expect(settingsPatchSchema.safeParse({ showRedis: 'always', redisScanKeys: 2000 }).success).toBe(true);
});

test('Databases: Auto, local times, 100 rows per fetch, a 15 s timeout; validated', () => {
  expect(DEFAULT_SETTINGS).toMatchObject({ showDatabases: 'auto', dbTimes: 'local', dbPageSize: '100', dbTimeoutSec: 15 });
  expect(normalizeSettings({ showDatabases: 'never', dbTimes: 'utc', dbPageSize: '500', dbTimeoutSec: 120 }))
    .toMatchObject({ showDatabases: 'never', dbTimes: 'utc', dbPageSize: '500', dbTimeoutSec: 120 });
  expect(normalizeSettings({ showDatabases: 'always', dbTimes: 'stored', dbPageSize: '50', dbTimeoutSec: 5 }))
    .toMatchObject({ showDatabases: 'always', dbTimes: 'stored', dbPageSize: '50', dbTimeoutSec: 5 });
  // Anything else falls back: a size that isn't offered (a number is not the string either), a timeout out of range.
  expect(normalizeSettings({ showDatabases: 'sometimes', dbTimes: 'gmt', dbPageSize: '77', dbTimeoutSec: 200 }))
    .toMatchObject({ showDatabases: 'auto', dbTimes: 'local', dbPageSize: '100', dbTimeoutSec: 15 });
  expect(normalizeSettings({ dbPageSize: 250, dbTimeoutSec: 2 })).toMatchObject({ dbPageSize: '100', dbTimeoutSec: 15 });
  // In steps of 5, like every stepper: the nearest step first, then the range (dockerLogLines 1499 → 1000).
  expect(normalizeSettings({ dbTimeoutSec: 3 }).dbTimeoutSec).toBe(5);
  expect(normalizeSettings({ dbTimeoutSec: 17 }).dbTimeoutSec).toBe(15);
  expect(normalizeSettings({ dbTimeoutSec: 'x' }).dbTimeoutSec).toBe(15);
  expect(settingsPatchSchema.safeParse({ showDatabases: 'never', dbTimes: 'utc', dbPageSize: '250', dbTimeoutSec: 30 }).success).toBe(true);
  for (const bad of [{ dbPageSize: '77' }, { dbPageSize: 100 }, { dbTimeoutSec: 3 }, { dbTimeoutSec: 121 }, { showDatabases: 'yes' }, { dbTimes: 'gmt' }])
    expect(settingsPatchSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
});

test('JSON navigation: Source, jq paths, the tree follows the cursor; validated', () => {
  expect(DEFAULT_SETTINGS.jsonView).toBe('source');
  expect(DEFAULT_SETTINGS.jsonPathFormat).toBe('jq');
  expect(DEFAULT_SETTINGS.jsonTreeFollowsCursor).toBe(true);
  expect(normalizeSettings({ jsonView: 'tree', jsonPathFormat: 'pointer', jsonTreeFollowsCursor: false })).toMatchObject({ jsonView: 'tree', jsonPathFormat: 'pointer', jsonTreeFollowsCursor: false });
  expect(normalizeSettings({ jsonView: 'split', jsonPathFormat: 'xpath' })).toMatchObject({ jsonView: 'source', jsonPathFormat: 'jq' });
  expect(settingsPatchSchema.safeParse({ jsonView: 'tree', jsonPathFormat: 'js', jsonTreeFollowsCursor: true }).success).toBe(true);
  expect(settingsPatchSchema.safeParse({ jsonView: 'preview' }).success).toBe(false);
  expect(settingsPatchSchema.safeParse({ jsonPathFormat: 'xpath' }).success).toBe(false);
});

test('CSV viewer: Source, the table follows the cursor, rainbow on, align and summaries off; validated', () => {
  expect(DEFAULT_SETTINGS).toMatchObject({ csvView: 'source', csvTableFollowsCursor: true, csvRainbow: true, csvAlign: false, csvSummaries: false });
  expect(normalizeSettings({ csvView: 'table', csvTableFollowsCursor: false, csvRainbow: false, csvAlign: true, csvSummaries: true }))
    .toMatchObject({ csvView: 'table', csvTableFollowsCursor: false, csvRainbow: false, csvAlign: true, csvSummaries: true });
  expect(normalizeSettings({ csvView: 'split', csvRainbow: 'yes' })).toMatchObject({ csvView: 'source', csvRainbow: true });
  expect(settingsPatchSchema.safeParse({ csvView: 'table', csvAlign: true }).success).toBe(true);
  expect(settingsPatchSchema.safeParse({ csvView: 'preview' }).success).toBe(false);
  expect(settingsPatchSchema.safeParse({ csvSummaries: 1 }).success).toBe(false);
});

test('Markdown preview: files open in Source, the outline is on; both validated', () => {
  expect(DEFAULT_SETTINGS.markdownView).toBe('source');
  expect(DEFAULT_SETTINGS.markdownOutline).toBe(true);
  expect(normalizeSettings({ markdownView: 'preview' }).markdownView).toBe('preview');
  expect(normalizeSettings({ markdownView: 'split' }).markdownView).toBe('source');
  expect(normalizeSettings({ markdownOutline: false }).markdownOutline).toBe(false);
  expect(settingsPatchSchema.safeParse({ markdownView: 'preview' }).success).toBe(true);
  expect(settingsPatchSchema.safeParse({ markdownView: 'split' }).success).toBe(false);
  expect(settingsPatchSchema.safeParse({ markdownOutline: 'yes' }).success).toBe(false);
});

test('Windows: the Docker engine is a named pipe (\\\\.\\pipe\\… or npipe://), never a Unix path', () => {
  setTestDefaultPlatform('win32');
  try {
    expect(normalizeSettings({ dockerSocket: '\\\\.\\pipe\\docker_engine' }).dockerSocket).toBe('\\\\.\\pipe\\docker_engine');
    expect(normalizeSettings({ dockerSocket: 'npipe:////./pipe/x' }).dockerSocket).toBe('npipe:////./pipe/x');
    expect(normalizeSettings({ dockerSocket: '/var/run/docker.sock' }).dockerSocket).toBe('');
    // A pipe on another machine is an SMB connection (and the user's credentials) to it: never.
    expect(normalizeSettings({ dockerSocket: '\\\\evil-host\\pipe\\docker_engine' }).dockerSocket).toBe('');
    expect(normalizeSettings({ dockerSocket: 'npipe:////evil-host/pipe/docker_engine' }).dockerSocket).toBe('');
    expect(normalizeSettings({ dockerSocket: `npipe:////./pipe/${'x'.repeat(2000)}` }).dockerSocket).toBe('');
  } finally {
    setTestDefaultPlatform('darwin');
  }
});

// Ask companion. Catch me up when opened is off by default: opening Ask
// shows its Catch me up button and starters; the automatic run is a Settings › Ask choice.
test('ask settings: defaults and validation', () => {
  const d = normalizeSettings({});
  expect([d.askModel, d.askAccount, d.askCatchUpOnOpen, d.askAnswers, d.askKnown]).toEqual(['sonnet', 'session', false, 'short', '']);
  expect(normalizeSettings({ askModel: 'gpt' }).askModel).toBe('sonnet');
  expect(normalizeSettings({ askModel: 'opus' }).askModel).toBe('opus');
  expect(normalizeSettings({ askAnswers: 'detailed' }).askAnswers).toBe('detailed');
  expect(normalizeSettings({ askCatchUpOnOpen: true }).askCatchUpOnOpen).toBe(true);
  expect(normalizeSettings({ askCatchUpOnOpen: 'yes' }).askCatchUpOnOpen).toBe(false);
});
test('askKnown: bounded text, newline and tab allowed, other control characters rejected', () => {
  expect(normalizeSettings({ askKnown: 'x'.repeat(2000) }).askKnown).toHaveLength(2000);
  expect(normalizeSettings({ askKnown: 'x'.repeat(2001) }).askKnown).toBe('');
  expect(normalizeSettings({ askKnown: 5 }).askKnown).toBe('');
  expect(normalizeSettings({ askKnown: 'a\nb\tc' }).askKnown).toBe('a\nb\tc');
  for (const c of ['\u0000', '\u001b', '\u007f', '\u0085', '\r']) expect(normalizeSettings({ askKnown: `a${c}b` }).askKnown).toBe('');
});
test('askAccount: session or an account id', () => {
  expect(normalizeSettings({ askAccount: 'work' }).askAccount).toBe('work');
  expect(normalizeSettings({ askAccount: 'session' }).askAccount).toBe('session');
  expect(normalizeSettings({ askAccount: 'Work!' }).askAccount).toBe('session');
});
test('ask settings patch: too long text falls back to empty, and the schema rejects it before', () => {
  const s = applyPatch(DEFAULT_SETTINGS, { askKnown: 'hello' });
  expect(applyPatch(s, { askKnown: 'x'.repeat(2001) }).askKnown).toBe('');
  expect(settingsPatchSchema.safeParse({ askKnown: 'x'.repeat(2001) }).success).toBe(false);
  expect(settingsPatchSchema.safeParse({ askKnown: 'a\u0000b' }).success).toBe(false);
  expect(settingsPatchSchema.safeParse({ askKnown: 'a\nb' }).success).toBe(true);
  expect(settingsPatchSchema.safeParse({ askAccount: 'Work!' }).success).toBe(false);
  expect(settingsPatchSchema.safeParse({ askAccount: 'session', askModel: 'haiku' }).success).toBe(true);
});
