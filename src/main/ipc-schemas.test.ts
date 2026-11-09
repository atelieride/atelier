import { describe, expect, test } from 'vitest';
import { bindingSchema, companionAskSchema, companionCatchUpSchema, companionSessionSchema } from './ipc-schemas';
import {
  dbDdlSchema, dbEditSchema, dbFilteredSchema, dbFullSchema, dbIdSchema, dbMaskSchema, dbPageSchema, dbPasswordSchema, dbPeekSchema, dbRefsSchema,
  dbSchemaPickSchema, dbSelectSchema, dbTableRefSchema, dbTestSchema
} from './ipc-schemas';
import { sourceSearchSchema, dockRequestSchema, editorHandoffSchema, popoutFocusSchema, popoutForwardSchema, popoutKeySchema, popoutOpenInMainSchema, popoutOpenSchema, popoutTearStartSchema, popoutRekeySchema, popoutShowInMainSchema, termCreateSchema, termInputSchema, termResizeSchema, idSchema, attributionResolveSchema, attributionUndoSchema, backgroundLoopSchema, backgroundWatchSchema } from './ipc-schemas';

test('resolving unsure files: 1..200 absolute paths, a terminal id or null (outside Claude); undo by token', () => {
  expect(attributionResolveSchema.safeParse({ paths: ['/p/a.ts'], terminalId: 't1' }).success).toBe(true);
  expect(attributionResolveSchema.safeParse({ paths: ['/p/a.ts', '/p/b.ts'], terminalId: null }).success).toBe(true);
  expect(attributionResolveSchema.safeParse({ paths: [], terminalId: 't1' }).success).toBe(false);
  expect(attributionResolveSchema.safeParse({ paths: ['rel.ts'], terminalId: 't1' }).success).toBe(false);
  expect(attributionResolveSchema.safeParse({ paths: Array.from({ length: 201 }, (_, i) => `/p/${i}`), terminalId: 't1' }).success).toBe(false);
  expect(attributionResolveSchema.safeParse({ paths: ['/p/a.ts'] }).success).toBe(false);
  expect(attributionResolveSchema.safeParse({ paths: ['/p/a.ts'], terminalId: 't1', extra: 1 }).success).toBe(false);
  expect(attributionUndoSchema.safeParse({ token: '12' }).success).toBe(true);
  expect(attributionUndoSchema.safeParse({ token: '' }).success).toBe(false);
  expect(attributionUndoSchema.safeParse({ token: '1', x: 1 }).success).toBe(false);
});

test('dropped paths: up to 1000 absolute paths', async () => {
  const { filesOpenDroppedSchema } = await import('./ipc-schemas');
  expect(filesOpenDroppedSchema.safeParse(['/a', '/b c']).success).toBe(true);
  expect(filesOpenDroppedSchema.safeParse([]).success).toBe(true);
  expect(filesOpenDroppedSchema.safeParse(['rel']).success).toBe(false);
  expect(filesOpenDroppedSchema.safeParse(['/' + 'x'.repeat(5000)]).success).toBe(false);
  // A huge drop still opens (the router opens 20 and says how many there were): cut, never refused.
  expect(filesOpenDroppedSchema.parse(Array.from({ length: 1500 }, (_, i) => `/p/${i}`))).toHaveLength(1000);
  expect(filesOpenDroppedSchema.safeParse('/a').success).toBe(false);
});

test('tabs to save: absolute files, keys and an active key, bounded, nothing else', async () => {
  const { tabsSaveSchema } = await import('./ipc-schemas');
  expect(tabsSaveSchema.safeParse({ files: ['/p/a.ts'], order: ['t:1', 'f:/p/a.ts'], active: 't:1' }).success).toBe(true);
  expect(tabsSaveSchema.safeParse({ files: [], order: [], active: null }).success).toBe(true);
  expect(tabsSaveSchema.safeParse({ files: ['a.ts'], order: [], active: null }).success).toBe(false);
  expect(tabsSaveSchema.safeParse({ files: [], order: [], active: null, extra: 1 }).success).toBe(false);
  // The Shelf's outside files: absolute, at most 50.
  expect(tabsSaveSchema.safeParse({ files: [], order: [], active: null, shelf: ['/h/x.sql'] }).success).toBe(true);
  expect(tabsSaveSchema.safeParse({ files: [], order: [], active: null, shelf: ['x.sql'] }).success).toBe(false);
  expect(tabsSaveSchema.safeParse({ files: [], order: [], active: null, shelf: Array.from({ length: 51 }, (_, i) => `/h/${i}`) }).success).toBe(false);
  // The Databases space's tab in front: a key or null, optional.
  expect(tabsSaveSchema.safeParse({ files: [], order: ['db:c0123456789ab'], active: null, dbActive: 'db:c0123456789ab' }).success).toBe(true);
  expect(tabsSaveSchema.safeParse({ files: [], order: [], active: null, dbActive: null }).success).toBe(true);
  expect(tabsSaveSchema.safeParse({ files: [], order: [], active: null, dbActive: 7 }).success).toBe(false);
  expect(tabsSaveSchema.safeParse({ files: Array.from({ length: 101 }, (_, i) => `/p/${i}`), order: [], active: null }).success).toBe(false);
  expect(tabsSaveSchema.safeParse({ files: [], order: Array.from({ length: 401 }, (_, i) => `t:${i}`), active: null }).success).toBe(false);
});

test('create: optional absolute cwd, limited dimensions', () => {
  expect(termCreateSchema.safeParse({ cols: 80, rows: 24 }).success).toBe(true);
  expect(termCreateSchema.safeParse({ cols: 80, rows: 24, cwd: 'rel' }).success).toBe(false);
  expect(termCreateSchema.safeParse({ cols: 80, rows: 24, extra: 1 }).success).toBe(false);
});
import { rendererErrorSchema } from './ipc-schemas';
test('renderer errors for the app log: known kinds, bounded texts, nothing else', () => {
  expect(rendererErrorSchema.safeParse({ kind: 'boundary', message: 'x', stack: 'at f', panel: 'Sidebar' }).success).toBe(true);
  expect(rendererErrorSchema.safeParse({ kind: 'error', message: 'x' }).success).toBe(true);
  expect(rendererErrorSchema.safeParse({ kind: 'other', message: 'x' }).success).toBe(false);
  expect(rendererErrorSchema.safeParse({ kind: 'error', message: 'x'.repeat(5000) }).success).toBe(false);
  expect(rendererErrorSchema.safeParse({ kind: 'error', message: 'x', path: '/etc/passwd' }).success).toBe(false);
});
test('input and resize', () => {
  expect(termInputSchema.safeParse({ id: 'a', data: 'ls\r' }).success).toBe(true);
  expect(termResizeSchema.safeParse({ id: 'a', cols: 1, rows: 1 }).success).toBe(false);
  expect(idSchema.safeParse('').success).toBe(false);
});

import { claudeLaunchPreviewSchema, termRenameSchema, termCreateSessionSchema } from './ipc-schemas';

test('rename: name or null, limited length', () => {
  expect(termRenameSchema.safeParse({ id: 'a', name: 'X' }).success).toBe(true);
  expect(termRenameSchema.safeParse({ id: 'a', name: null }).success).toBe(true);
  expect(termRenameSchema.safeParse({ id: 'a', name: 'x'.repeat(201) }).success).toBe(false);
});
test('a hand-typed name loses its control characters (they would show up in titles and the shell)', () => {
  expect(termRenameSchema.parse({ id: 'a', name: 'Fix\x1b[31m it\x07' }).name).toBe('Fix[31m it');
  expect(termRenameSchema.parse({ id: 'a', name: 'two\nlines\tand tab' }).name).toBe('two lines and tab');
  // Nothing left: no name (the title falls back to the session's).
  expect(termRenameSchema.parse({ id: 'a', name: '\x1b\x7f ' }).name).toBeNull();
  expect(termCreateSessionSchema.parse({ cols: 80, rows: 24, name: 'Al\x9bfa\x00' }).name).toBe('Alfa');
});
test('create-session: an account by id only, never a dir', () => {
  expect(termCreateSessionSchema.safeParse({ cols: 80, rows: 24, account: 'ops' }).success).toBe(true);
  for (const account of ['../x', '/Users/x/.claude_ops', 'Ops', 'x'.repeat(33), '', 3]) expect(termCreateSessionSchema.safeParse({ cols: 80, rows: 24, account }).success, String(account)).toBe(false);
});
test('launch preview: an account by id and a sample name only', () => {
  expect(claudeLaunchPreviewSchema.safeParse({ account: 'work', name: 'Fix the login bug' }).success).toBe(true);
  expect(claudeLaunchPreviewSchema.safeParse({ name: 'x' }).success).toBe(true);
  for (const bad of [{ account: '/Users/x/.claude', name: 'x' }, { name: 'x', flags: [['--verbose']] }, { account: 'work' }]) expect(claudeLaunchPreviewSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
});
test('create-session: noFlags is only ever true (New Session ⌥↵); flags never come from the renderer', () => {
  expect(termCreateSessionSchema.safeParse({ cols: 80, rows: 24, noFlags: true }).success).toBe(true);
  for (const noFlags of [false, 'yes', 1]) expect(termCreateSessionSchema.safeParse({ cols: 80, rows: 24, noFlags }).success, String(noFlags)).toBe(false);
  expect(termCreateSessionSchema.safeParse({ cols: 80, rows: 24, flags: [['--verbose']] }).success).toBe(false);
});
test('resume from Claude history: the conversation\'s account by id only', () => {
  const sessionId = '0b5c8f0e-1111-4222-8333-944455556666';
  expect(claudeResumeSchema.safeParse({ sessionId, cols: 80, rows: 24 }).success).toBe(true);
  expect(claudeResumeSchema.safeParse({ sessionId, cols: 80, rows: 24, account: 'ops' }).success).toBe(true);
  expect(claudeResumeSchema.safeParse({ sessionId, cols: 80, rows: 24, account: '/Users/x/.claude_ops' }).success).toBe(false);
});
test('create-session: no command from the renderer', () => {
  expect(termCreateSessionSchema.safeParse({ cols: 80, rows: 24, name: 'S' }).success).toBe(true);
  expect(termCreateSessionSchema.safeParse({ cols: 80, rows: 24, command: 'rm -rf ~' }).success).toBe(false);
});
test('create-session: optional absolute cwd (the main process checks it is inside the project)', () => {
  expect(termCreateSessionSchema.safeParse({ cols: 80, rows: 24, cwd: '/p/api' }).success).toBe(true);
  expect(termCreateSessionSchema.safeParse({ cols: 80, rows: 24, cwd: 'api' }).success).toBe(false);
  expect(termCreateSessionSchema.safeParse({ cols: 80, rows: 24, cwd: '/' + 'x'.repeat(5000) }).success).toBe(false);
});

import { filesListSchema, filesReadSchema, filesResolveSchema, urlSchema } from './ipc-schemas';
test('files: absolute paths, limits', () => {
  expect(filesListSchema.safeParse({ dir: '/p', showHidden: false }).success).toBe(true);
  expect(filesListSchema.safeParse({ dir: 'rel', showHidden: false }).success).toBe(false);
  expect(filesReadSchema.safeParse('/p/a.ts').success).toBe(true);
  expect(filesResolveSchema.safeParse({ candidate: 'src/a.ts', cwd: '/p' }).success).toBe(true);
  expect(filesResolveSchema.safeParse({ candidate: 'x'.repeat(5000), cwd: '/p' }).success).toBe(false);
  expect(urlSchema.safeParse('https://a.b').success).toBe(true);
  expect(urlSchema.safeParse('x'.repeat(9000)).success).toBe(false);
});

import { filesClaudeTempSchema } from './ipc-schemas';
test('Claude temp images: one absolute path, nothing else', () => {
  expect(filesClaudeTempSchema.safeParse('/private/tmp/claude-501/p/s/scratchpad/a.png').success).toBe(true);
  expect(filesClaudeTempSchema.safeParse('scratchpad/a.png').success).toBe(false);
  expect(filesClaudeTempSchema.safeParse('/' + 'x'.repeat(5000)).success).toBe(false);
  expect(filesClaudeTempSchema.safeParse({ path: '/a.png' }).success).toBe(false);
  expect(filesClaudeTempSchema.safeParse('').success).toBe(false);
});

test('any path in the terminal: an absolute or a home path, at most 4096, nothing else', async () => {
  const { filesOutsideSchema } = await import('./ipc-schemas');
  expect(filesOutsideSchema.safeParse('/tmp/report.md').success).toBe(true);
  expect(filesOutsideSchema.safeParse('~/.claude/plans/fuzzy-otter.md').success).toBe(true);
  expect(filesOutsideSchema.safeParse('.claude/plans/x.md').success).toBe(false);
  expect(filesOutsideSchema.safeParse('~other/x.md').success).toBe(false);
  expect(filesOutsideSchema.safeParse('/' + 'x'.repeat(5000)).success).toBe(false);
  expect(filesOutsideSchema.safeParse({ path: '/a.md' }).success).toBe(false);
  expect(filesOutsideSchema.safeParse('').success).toBe(false);
});

test('git base content (review): an absolute path and HEAD or a full commit id, nothing else', async () => {
  const { gitBaseSchema } = await import('./ipc-schemas');
  const oid = 'a'.repeat(40);
  expect(gitBaseSchema.safeParse({ path: '/p/a.ts', rev: 'HEAD' }).success).toBe(true);
  expect(gitBaseSchema.safeParse({ path: '/p/a.ts', rev: oid }).success).toBe(true);
  expect(gitBaseSchema.safeParse({ path: '/p/a.ts', rev: 'b'.repeat(64) }).success).toBe(true);
  for (const rev of ['main', 'HEAD~1', '--output=/tmp/x', oid.slice(1), oid.toUpperCase(), `${oid}:x`]) {
    expect(gitBaseSchema.safeParse({ path: '/p/a.ts', rev }).success, rev).toBe(false);
  }
  expect(gitBaseSchema.safeParse({ path: 'a.ts', rev: 'HEAD' }).success).toBe(false);
  expect(gitBaseSchema.safeParse({ path: '/p/a.ts', rev: 'HEAD', extra: 1 }).success).toBe(false);
});

import { servicesWatchSchema, paneIdSchema } from './ipc-schemas';
test('services: pane ids only in the %N form', () => {
  expect(paneIdSchema.safeParse('%3').success).toBe(true);
  expect(paneIdSchema.safeParse('acme:0').success).toBe(false);
  expect(servicesWatchSchema.safeParse(['%1', '%2']).success).toBe(true);
  expect(servicesWatchSchema.safeParse(['%1', 'x']).success).toBe(false);
});

test('file editing schemas', async () => {
  const { filesSaveSchema, filesCreateSchema, filesRenameSchema } = await import('./ipc-schemas');
  const base = { mtimeMs: 1, size: 2, hash: 'a'.repeat(64) };
  expect(filesSaveSchema.safeParse({ path: '/p/a.ts', text: 'x', base, eol: 'lf' }).success).toBe(true);
  expect(filesSaveSchema.safeParse({ path: '/p/a.ts', text: 'x', base: null, eol: 'crlf', create: true }).success).toBe(true);
  // Nothing skips the conflict check any more (Keep Mine sends the conflict's stamp): the old flag is refused.
  expect(filesSaveSchema.safeParse({ path: '/p/a.ts', text: 'x', base: null, eol: 'crlf', force: true }).success).toBe(false);
  expect(filesSaveSchema.safeParse({ path: '/p/a.ts', text: 'x'.repeat(5 * 1024 * 1024 + 1), base, eol: 'lf' }).success).toBe(false);
  expect(filesSaveSchema.safeParse({ path: '/p/a.ts', text: 'x', base, eol: 'cr' }).success).toBe(false);
  expect(filesSaveSchema.safeParse({ path: 'rel.ts', text: 'x', base, eol: 'lf' }).success).toBe(false);
  expect(filesSaveSchema.safeParse({ path: '/p/a.ts', text: 'x', base: { ...base, hash: 'zz' }, eol: 'lf' }).success).toBe(false);
  expect(filesCreateSchema.safeParse({ dir: '/p', name: 'a.ts', kind: 'file' }).success).toBe(true);
  expect(filesCreateSchema.safeParse({ dir: '/p', name: 'n'.repeat(256), kind: 'file' }).success).toBe(false);
  expect(filesCreateSchema.safeParse({ dir: '/p', name: 'a', kind: 'link' }).success).toBe(false);
  expect(filesRenameSchema.safeParse({ path: '/p/a', name: 'b' }).success).toBe(true);
});

test('dictation: 16-bit PCM audio with a limit, vocabulary ingredients with limits, nothing else', async () => {
  const { dictationTranscribeSchema } = await import('./ipc-schemas');
  const ok = { pcm: new Uint8Array(32000), raw: false, context: { sessions: ['Fix'], branch: 'main', files: ['src/a.ts'], identifiers: ['parseLine'] } };
  expect(dictationTranscribeSchema.safeParse(ok).success).toBe(true);
  expect(dictationTranscribeSchema.safeParse({ ...ok, pcm: new Uint8Array(3) }).success).toBe(false);
  expect(dictationTranscribeSchema.safeParse({ ...ok, pcm: new Uint8Array(301 * 16000 * 2 + 2) }).success).toBe(false);
  expect(dictationTranscribeSchema.safeParse({ ...ok, pcm: [1, 2] }).success).toBe(false);
  expect(dictationTranscribeSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  expect(dictationTranscribeSchema.safeParse({ ...ok, context: { ...ok.context, files: Array(201).fill('a') } }).success).toBe(false);
  expect(dictationTranscribeSchema.safeParse({ ...ok, context: { ...ok.context, sessions: ['x'.repeat(201)] } }).success).toBe(false);
  // The terminal the text goes to: main maps its account, never a dir from the renderer.
  expect(dictationTranscribeSchema.safeParse({ ...ok, terminalId: 't-1' }).success).toBe(true);
  expect(dictationTranscribeSchema.safeParse({ ...ok, terminalId: '' }).success).toBe(false);
  expect(dictationTranscribeSchema.safeParse({ ...ok, configDir: '/x' }).success).toBe(false);
});

test('dictation: a full 5 minutes (with the one-second margin) pass, more does not', async () => {
  const { dictationTranscribeSchema } = await import('./ipc-schemas');
  const ctx = { sessions: [], branch: null, files: [], identifiers: [] };
  expect(dictationTranscribeSchema.safeParse({ pcm: new Uint8Array(300 * 16000 * 2 + 16000), raw: false, context: ctx }).success).toBe(true);
  expect(dictationTranscribeSchema.safeParse({ pcm: new Uint8Array(301 * 16000 * 2 + 2), raw: false, context: ctx }).success).toBe(false);
});

import { filesSaveAsSchema } from './ipc-schemas';
test('Save as: a relative path and the text, strict', () => {
  expect(filesSaveAsSchema.safeParse({ rel: 'notes/todo.md', text: 'x' }).success).toBe(true);
  expect(filesSaveAsSchema.safeParse({ rel: '', text: 'x' }).success).toBe(false);
  expect(filesSaveAsSchema.safeParse({ rel: 'a', text: 'x', extra: 1 }).success).toBe(false);
  expect(filesSaveAsSchema.safeParse({ rel: 'a', text: 1 }).success).toBe(false);
  expect(filesSaveAsSchema.safeParse({ rel: 'x'.repeat(4097), text: '' }).success).toBe(false);
  expect(filesSaveAsSchema.safeParse({ rel: 'a', text: 'x'.repeat(5 * 1024 * 1024 + 1) }).success).toBe(false);
});

import { filesSaveAsOutsideSchema } from './ipc-schemas';
test('Save as outside the project: only the name the panel suggests (never a path), the text and the unsaved tabs, strict', () => {
  expect(filesSaveAsOutsideSchema.safeParse({ name: 'todo.md', text: 'x', unsaved: ['/p/a.ts'] }).success).toBe(true);
  expect(filesSaveAsOutsideSchema.safeParse({ name: '', text: '', unsaved: [] }).success).toBe(true);
  expect(filesSaveAsOutsideSchema.safeParse({ name: 'a', text: 'x' }).success).toBe(false);
  expect(filesSaveAsOutsideSchema.safeParse({ name: 'x'.repeat(256), text: '', unsaved: [] }).success).toBe(false);
  expect(filesSaveAsOutsideSchema.safeParse({ name: 'a', text: 'x', unsaved: [], path: '/etc/hosts' }).success).toBe(false);
  expect(filesSaveAsOutsideSchema.safeParse({ name: 'a', text: 'x'.repeat(5 * 1024 * 1024 + 1), unsaved: [] }).success).toBe(false);
  expect(filesSaveAsOutsideSchema.safeParse({ name: 'a', text: '', unsaved: Array(501).fill('/p/a') }).success).toBe(false);
});

import { claudeResumeSchema } from './ipc-schemas';

test('claude resume: a UUID session id and dimensions only (the cwd comes from the main process history)', () => {
  const sessionId = '0b5c8f0e-1111-4222-8333-944455556666';
  expect(claudeResumeSchema.safeParse({ sessionId, cols: 80, rows: 24 }).success).toBe(true);
  expect(claudeResumeSchema.safeParse({ sessionId: 'abc', cols: 80, rows: 24 }).success).toBe(false);
  expect(claudeResumeSchema.safeParse({ sessionId: `${sessionId}; rm -rf ~`, cols: 80, rows: 24 }).success).toBe(false);
  expect(claudeResumeSchema.safeParse({ sessionId, cols: 80, rows: 24, cwd: '/tmp' }).success).toBe(false);
});

import { triggerNotifySchema } from './ipc-schemas';
import { automationCatchUpSchema, automationPausedSchema, automationRefSchema, automationSaveSchema, automationTurnOnSchema, runRefSchema } from './ipc-schemas';
import { normalizeAutomation } from '@shared/automations';
test('trigger notify: a terminal id, the rule and the line, bounded and strict', () => {
  expect(triggerNotifySchema.safeParse({ id: 't', rule: 'tests failed', line: '3 tests failed' }).success).toBe(true);
  expect(triggerNotifySchema.safeParse({ id: 't', rule: '', line: 'x' }).success).toBe(false);
  expect(triggerNotifySchema.safeParse({ id: 't', rule: 'x'.repeat(201), line: 'x' }).success).toBe(false);
  expect(triggerNotifySchema.safeParse({ id: 't', rule: 'r', line: 'x'.repeat(2049) }).success).toBe(false);
  expect(triggerNotifySchema.safeParse({ id: 't', rule: 'r', line: 'x', title: 'spoof' }).success).toBe(false);
});

test('ports:open: a terminal id and an integer port 1–65535, nothing else', async () => {
  const { portsOpenSchema } = await import('./ipc-schemas');
  expect(portsOpenSchema.safeParse({ id: 't1', port: 3000 }).success).toBe(true);
  expect(portsOpenSchema.safeParse({ id: 't1', port: 1 }).success).toBe(true);
  expect(portsOpenSchema.safeParse({ id: 't1', port: 65535 }).success).toBe(true);
  for (const port of [0, 65536, -1, 3000.5, '3000', null]) expect(portsOpenSchema.safeParse({ id: 't1', port }).success, String(port)).toBe(false);
  expect(portsOpenSchema.safeParse({ id: '', port: 3000 }).success).toBe(false);
  expect(portsOpenSchema.safeParse({ id: 't1', port: 3000, url: 'http://evil/' }).success).toBe(false);
  expect(portsOpenSchema.safeParse({ port: 3000 }).success).toBe(false);
});

test('pr:open: an absolute repo root, a bounded branch and whether to open the checks; never a URL', async () => {
  const { prOpenSchema } = await import('./ipc-schemas');
  expect(prOpenSchema.safeParse({ root: '/r', branch: 'feature/x', checks: false }).success).toBe(true);
  expect(prOpenSchema.safeParse({ root: '/r', branch: 'feature/x', checks: true }).success).toBe(true);
  expect(prOpenSchema.safeParse({ root: 'r', branch: 'feature/x', checks: false }).success).toBe(false);
  expect(prOpenSchema.safeParse({ root: '/r', branch: '', checks: false }).success).toBe(false);
  expect(prOpenSchema.safeParse({ root: '/r', branch: 'x'.repeat(201), checks: false }).success).toBe(false);
  expect(prOpenSchema.safeParse({ root: '/r', branch: 'feature/x', checks: 'yes' }).success).toBe(false);
  expect(prOpenSchema.safeParse({ root: '/r', branch: 'feature/x' }).success).toBe(false);
  expect(prOpenSchema.safeParse({ root: '/r', branch: 'feature/x', checks: false, url: 'https://evil/' }).success).toBe(false);
});

test('claude:config (Session panel): only an absolute folder; never a config dir or a file from the renderer', async () => {
  const { claudeConfigSchema } = await import('./ipc-schemas');
  expect(claudeConfigSchema.safeParse({ cwd: '/p/app' }).success).toBe(true);
  for (const cwd of ['', 'p/app', '~/x', 'x'.repeat(10), '/' + 'x'.repeat(4096), 3, null]) expect(claudeConfigSchema.safeParse({ cwd }).success, String(cwd).slice(0, 20)).toBe(false);
  expect(claudeConfigSchema.safeParse({ cwd: '/p', configDir: '/etc' }).success).toBe(false);
  expect(claudeConfigSchema.safeParse({ cwd: '/p', CLAUDE_CONFIG_DIR: '/etc' }).success).toBe(false);
  // The session's terminal: main maps its account, the renderer names no dir.
  expect(claudeConfigSchema.safeParse({ cwd: '/p', terminalId: 't-1' }).success).toBe(true);
  expect(claudeConfigSchema.safeParse({ cwd: '/p', terminalId: 'x'.repeat(500) }).success).toBe(false);
  expect(claudeConfigSchema.safeParse({}).success).toBe(false);
});

test('claude:restartCommand: a terminal and a session id, nothing that reaches the command', async () => {
  const { claudeRestartSchema } = await import('./ipc-schemas');
  const SID = '0b5c8f0e-1111-4222-8333-944455556666';
  expect(claudeRestartSchema.safeParse({ terminalId: 't-1', sessionId: SID }).success).toBe(true);
  for (const sessionId of ['', 'x', `${SID}; rm -rf ~`, `'${SID}'`, 3, null]) expect(claudeRestartSchema.safeParse({ terminalId: 't-1', sessionId }).success, String(sessionId)).toBe(false);
  expect(claudeRestartSchema.safeParse({ terminalId: 'x'.repeat(500), sessionId: SID }).success).toBe(false);
  expect(claudeRestartSchema.safeParse({ terminalId: 't-1', sessionId: SID, configDir: '/etc' }).success).toBe(false);
  expect(claudeRestartSchema.safeParse({ terminalId: 't-1', sessionId: SID, flags: ['--x'] }).success).toBe(false);
});

test('context usage: a terminal id, and an absolute path to open; nothing else', async () => {
  const { claudeContextSchema, claudeContextOpenSchema } = await import('./ipc-schemas');
  expect(claudeContextSchema.safeParse({ terminalId: 't-1' }).success).toBe(true);
  for (const bad of [{}, { terminalId: '' }, { terminalId: 'x'.repeat(500) }, { terminalId: 't-1', cwd: '/etc' }, { terminalId: 't-1', args: ['--x'] }]) {
    expect(claudeContextSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  }
  expect(claudeContextOpenSchema.safeParse({ terminalId: 't-1', path: '/Users/dev/.claude/CLAUDE.md' }).success).toBe(true);
  for (const path of ['', 'relative/CLAUDE.md', '../x', 3, null, `/${'x'.repeat(5000)}`]) {
    expect(claudeContextOpenSchema.safeParse({ terminalId: 't-1', path }).success, String(path)).toBe(false);
  }
  expect(claudeContextOpenSchema.safeParse({ terminalId: 't-1', path: '/x', mode: 'edit' }).success).toBe(false);
});

import { scmAheadBehindSchema, scmCommitSchema, scmFileSchema, scmLocateSchema, scmLogSchema, scmResolveSchema, scmRootSchema } from './ipc-schemas';
test('source control: roots, scopes, refnames, oids, bounded filters and repo-relative paths only', () => {
  const O = 'a'.repeat(40);
  const all = { kind: 'refs', refs: 'all', firstParent: false };
  const log = (extra: Record<string, unknown>) => scmLogSchema.safeParse({ root: '/p', scope: all, skip: 0, count: 400, ...extra }).success;
  expect(scmRootSchema.safeParse({ root: '/p' }).success).toBe(true);
  expect(scmRootSchema.safeParse({ root: 'p' }).success).toBe(false);
  expect(log({})).toBe(true);
  expect(log({ filter: 'fix @ada path:src', view: 'history' })).toBe(true);
  expect(log({ count: 4001 })).toBe(false);
  expect(log({ skip: -1 })).toBe(false);
  expect(log({ filter: 'a\0b' })).toBe(false);
  expect(log({ filter: 'x'.repeat(201) })).toBe(false);
  expect(log({ extra: 1 })).toBe(false);
  for (const refs of ['refs/heads/feat/x', 'refs/remotes/origin/main', 'refs/tags/v1.0', 'HEAD', 'refs/heads/-n']) expect(log({ scope: { kind: 'refs', refs, firstParent: true } }), refs).toBe(true);
  for (const refs of ['--all', 'HEAD~1', 'refs/notes/x', 'refs/heads/a b', 'refs/heads/x:y', 'main', 'refs/heads/a..b', 'refs/stash']) expect(log({ scope: { kind: 'refs', refs, firstParent: false } }), refs).toBe(false);
  expect(log({ scope: { kind: 'compare', base: O, head: 'refs/heads/x' } })).toBe(true);
  expect(log({ scope: { kind: 'compare', base: 'main', head: 'refs/heads/x' } })).toBe(false);
  expect(scmLocateSchema.safeParse({ root: '/p', scope: all, oid: O }).success).toBe(true);
  expect(scmLocateSchema.safeParse({ root: '/p', scope: all, oid: 'abc' }).success).toBe(false);
  expect(scmResolveSchema.safeParse({ root: '/p', prefix: 'f0d6' }).success).toBe(true);
  expect(scmResolveSchema.safeParse({ root: '/p', prefix: 'F0D6' }).success).toBe(false);
  expect(scmResolveSchema.safeParse({ root: '/p', prefix: 'f0d' }).success).toBe(false);
  expect(scmCommitSchema.safeParse({ root: '/p', oid: O }).success).toBe(true);
  expect(scmCommitSchema.safeParse({ root: '/p', oid: O, against: 'b'.repeat(64) }).success).toBe(true);
  expect(scmCommitSchema.safeParse({ root: '/p', oid: O, against: 'HEAD' }).success).toBe(false);
  expect(scmFileSchema.safeParse({ root: '/p', oid: O, rel: 'src/a b/è.ts' }).success).toBe(true);
  for (const rel of ['../x', '/etc/passwd', 'a/../../x', 'a\0b', '']) expect(scmFileSchema.safeParse({ root: '/p', oid: O, rel }).success, rel).toBe(false);
  expect(scmAheadBehindSchema.safeParse({ root: '/p', a: 'refs/heads/main', b: O }).success).toBe(true);
  expect(scmAheadBehindSchema.safeParse({ root: '/p', a: '--all', b: O }).success).toBe(false);
});

import { scmFetchSchema } from './ipc-schemas';
test('source control fetch: a root and a reason, nothing else', () => {
  expect(scmFetchSchema.safeParse({ root: '/p', reason: 'view' }).success).toBe(true);
  expect(scmFetchSchema.safeParse({ root: '/p', reason: 'manual' }).success).toBe(true);
  expect(scmFetchSchema.safeParse({ root: '/p', reason: 'periodic' }).success).toBe(false);
  expect(scmFetchSchema.safeParse({ root: 'p', reason: 'view' }).success).toBe(false);
  expect(scmFetchSchema.safeParse({ root: '/p' }).success).toBe(false);
  expect(scmFetchSchema.safeParse({ root: '/p', reason: 'view', args: ['--upload-pack=x'] }).success).toBe(false);
});

test('backgroundWatchSchema: a terminal id and an item id, nothing else', () => {
  expect(backgroundWatchSchema.parse({ terminalId: 't1', itemId: 'by72ms8dl' })).toEqual({ terminalId: 't1', itemId: 'by72ms8dl' });
  for (const bad of [{ terminalId: 't1', itemId: '../x' }, { terminalId: 't1', itemId: 'b1', path: '/etc/passwd' }, { terminalId: '', itemId: 'b1' }, { itemId: 'b1' }])
    expect(backgroundWatchSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
});

test('backgroundLoopSchema: a terminal id and a cron id, nothing else', () => {
  expect(backgroundLoopSchema.parse({ terminalId: 't1', cronId: '3f193c39' })).toEqual({ terminalId: 't1', cronId: '3f193c39' });
  for (const bad of [{ terminalId: 't1', cronId: '../x' }, { terminalId: 't1', cronId: 'c1', path: '/etc/passwd' }, { terminalId: '', cronId: 'c1' }, { cronId: 'c1' }, { terminalId: 't1' }])
    expect(backgroundLoopSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
});

describe('pop-out schemas', () => {
  const handoff = { path: '/p/a.ts', state: { doc: 'x', selection: { ranges: [{ anchor: 0, head: 0 }], main: 0 }, history: { done: [], undone: [] } }, saved: 'x', stamp: { mtimeMs: 1, size: 1, hash: 'h' }, eol: 'lf', scrollTop: 0 };
  test('open: a valid tab key, size and placement; payload and handoff optional', () => {
    expect(popoutOpenSchema.safeParse({ key: 't:a', size: { width: 800, height: 600 }, at: 'cascade' }).success).toBe(true);
    expect(popoutOpenSchema.safeParse({ key: 'f:/p/a.ts', payload: { kind: 'file', rel: 'a.ts', mode: 'margin' }, handoff, size: { width: 800, height: 600 }, at: 'cursor' }).success).toBe(true);
    expect(popoutOpenSchema.safeParse({ key: 'nope', size: { width: 800, height: 600 }, at: 'cascade' }).success).toBe(false);
    expect(popoutOpenSchema.safeParse({ key: 't:a', size: { width: -1, height: 600 }, at: 'cascade' }).success).toBe(false);
    expect(popoutOpenSchema.safeParse({ key: 't:a', size: { width: 800, height: 600 }, at: 'elsewhere' }).success).toBe(false);
    expect(popoutOpenSchema.safeParse({ key: 't:a', size: { width: 800, height: 600 }, at: 'cascade', extra: 1 }).success).toBe(false);
  });
  test('payload kinds are closed; JSON over 64 KiB is refused', () => {
    expect(dockRequestSchema.safeParse({ payload: { kind: 'review', scope: 'all' } }).success).toBe(true);
    expect(dockRequestSchema.safeParse({ payload: { kind: 'evil' } }).success).toBe(false);
    expect(dockRequestSchema.safeParse({ payload: { kind: 'history', repo: '/p', scope: { s: 'x'.repeat(70_000) } } }).success).toBe(false);
  });
  test('a table tab: its key and its payload, strict — a connection id, names as the catalog spells them, a view', () => {
    const key = 'db:c0123456789ab/public/orders';
    const payload = { kind: 'db', connId: 'c0123456789ab', schema: 'public', name: 'orders', view: 'structure' };
    expect(popoutOpenSchema.safeParse({ key, payload, size: { width: 800, height: 600 }, at: 'cascade' }).success).toBe(true);
    expect(popoutShowInMainSchema.safeParse({ key, payload: { ...payload, rel: 'matview' } }).success).toBe(true);
    // The overview: the connection's own key, no schema or name.
    expect(popoutShowInMainSchema.safeParse({ key: 'db:c0123456789ab', payload: { ...payload, schema: '', name: '', view: 'data' } }).success).toBe(true);
    expect(popoutKeySchema.safeParse('db:c0123456789ab/public').success).toBe(false);
    expect(popoutKeySchema.safeParse('db:x/public/orders').success).toBe(false);
    for (const bad of [
      { ...payload, connId: 'x0123456789ab' }, { ...payload, connId: 'c0123456789ab0' }, { ...payload, schema: 'x'.repeat(129) }, { ...payload, name: 'a\0b' },
      { ...payload, view: 'sql' }, { ...payload, rel: 'function' }, { ...payload, extra: 1 }, { ...payload, view: undefined }
    ]) expect(dockRequestSchema.safeParse({ payload: bad }).success, JSON.stringify(bad)).toBe(false);
  });
  test('a table opened from a pop-out: preview or not, whether a view was asked, a key\'s filters — strict, bounded as a page\'s', () => {
    const key = 'db:c0123456789ab/public/customers';
    const payload = { kind: 'db', connId: 'c0123456789ab', schema: 'public', name: 'customers', view: 'data' };
    const filters = [{ column: 'id', op: 'eq', values: ['2041'] }, { column: 'plan', op: 'in', values: ['pro'] }];
    expect(popoutShowInMainSchema.safeParse({ key, payload: { ...payload, open: { preview: true, view: false } } }).success).toBe(true);
    expect(popoutShowInMainSchema.safeParse({ key, payload: { ...payload, open: { preview: false, view: true, filters, inspector: true } } }).success).toBe(true);
    for (const open of [
      { preview: true }, { preview: 'yes', view: false }, { preview: true, view: false, extra: 1 }, { preview: true, view: false, inspector: 1 },
      { preview: true, view: false, filters: [{ column: 'id', op: 'eq', values: [] }] }, { preview: true, view: false, filters: [{ column: 'id', op: 'drop', values: ['1'] }] },
      { preview: true, view: false, filters: [{ column: 'a\0', op: 'eq', values: ['1'] }] },
      { preview: true, view: false, filters: Array.from({ length: 31 }, () => filters[0]) }
    ]) expect(popoutShowInMainSchema.safeParse({ key, payload: { ...payload, open } }).success, JSON.stringify(open)).toBe(false);
  });
  test('a terminal carries whether its Ask is open (it moves with its pane), nothing else', () => {
    expect(popoutOpenSchema.safeParse({ key: 't:a', payload: { kind: 'terminal', ask: true }, size: { width: 800, height: 600 }, at: 'cascade' }).success).toBe(true);
    expect(dockRequestSchema.safeParse({ payload: { kind: 'terminal', ask: false } }).success).toBe(true);
    expect(dockRequestSchema.safeParse({ payload: { kind: 'terminal', ask: 'yes' } }).success).toBe(false);
    expect(dockRequestSchema.safeParse({ payload: { kind: 'terminal', ask: true, binding: {} } }).success).toBe(false);
  });
  test('handoff: bounded text, LF/CRLF only', () => {
    expect(editorHandoffSchema.safeParse(handoff).success).toBe(true);
    expect(editorHandoffSchema.safeParse({ ...handoff, eol: 'cr' }).success).toBe(false);
    expect(editorHandoffSchema.safeParse({ ...handoff, path: '' }).success).toBe(false);
  });
  test('focus, recall, forward', () => {
    expect(popoutFocusSchema.safeParse({ key: 'f:/p/a.ts', reveal: { line: 12 } }).success).toBe(true);
    expect(popoutFocusSchema.safeParse({ key: 'f:/p/a.ts', reveal: { line: 0 } }).success).toBe(false);
    expect(popoutKeySchema.safeParse('t:a').success).toBe(true);
    expect(popoutKeySchema.safeParse('x'.repeat(5000)).success).toBe(false);
    expect(popoutForwardSchema.safeParse('open-palette').success).toBe(true);
    expect(popoutForwardSchema.safeParse('rm -rf').success).toBe(false);
  });
  test('show in main: a known tab key and a payload of a known kind, nothing else', () => {
    expect(popoutShowInMainSchema.safeParse({ key: 't:a' }).success).toBe(true);
    expect(popoutShowInMainSchema.safeParse({ key: 'rev:abc:a.ts', payload: { kind: 'rev', root: '/p', oid: 'abc', rel: 'a.ts' } }).success).toBe(true);
    expect(popoutShowInMainSchema.safeParse({ key: 'nope' }).success).toBe(false);
    expect(popoutShowInMainSchema.safeParse({ key: 'review', payload: { kind: 'evil' } }).success).toBe(false);
    expect(popoutShowInMainSchema.safeParse({ key: 't:a', extra: 1 }).success).toBe(false);
    expect(popoutShowInMainSchema.safeParse('t:a').success).toBe(false);
  });
  test('open in main: an absolute path, a positive line at most', () => {
    expect(popoutOpenInMainSchema.safeParse({ path: '/p/a.ts' }).success).toBe(true);
    expect(popoutOpenInMainSchema.safeParse({ path: '/p/a.ts', line: 12 }).success).toBe(true);
    expect(popoutOpenInMainSchema.safeParse({ path: 'untitled:1' }).success).toBe(false);
    expect(popoutOpenInMainSchema.safeParse({ path: 'a.ts' }).success).toBe(false);
    expect(popoutOpenInMainSchema.safeParse({ path: '/p/a\0.ts' }).success).toBe(false);
    expect(popoutOpenInMainSchema.safeParse({ path: '/' + 'x'.repeat(5000) }).success).toBe(false);
    expect(popoutOpenInMainSchema.safeParse({ path: '/p/a.ts', line: 0 }).success).toBe(false);
    expect(popoutOpenInMainSchema.safeParse({ path: '/p/a.ts', line: 1.5 }).success).toBe(false);
    expect(popoutOpenInMainSchema.safeParse({ path: '/p/a.ts', extra: 1 }).success).toBe(false);
  });
  test('rekey: an untitled buffer saved as an absolute file, nothing else', () => {
    expect(popoutRekeySchema.safeParse({ from: 'f:untitled:1', to: 'f:/p/notes.md' }).success).toBe(true);
    expect(popoutRekeySchema.safeParse({ from: 'f:/p/a.ts', to: 'f:/p/b.ts' }).success).toBe(false);
    expect(popoutRekeySchema.safeParse({ from: 't:a', to: 'f:/p/b.ts' }).success).toBe(false);
    expect(popoutRekeySchema.safeParse({ from: 'f:untitled:1', to: 't:a' }).success).toBe(false);
    expect(popoutRekeySchema.safeParse({ from: 'f:untitled:1', to: 'f:untitled:2' }).success).toBe(false);
    expect(popoutRekeySchema.safeParse({ from: 'f:untitled:1', to: 'f:/p/a\0.ts' }).success).toBe(false);
    expect(popoutRekeySchema.safeParse({ from: 'f:untitled:1', to: 'f:/' + 'x'.repeat(5000) }).success).toBe(false);
    expect(popoutRekeySchema.safeParse({ from: 'f:untitled:1', to: 'f:/p/n.md', extra: 1 }).success).toBe(false);
    expect(popoutRekeySchema.safeParse('f:/p/n.md').success).toBe(false);
  });
  test('a payload, a reveal or a handoff with an extra key inside is refused (strict all the way down)', () => {
    expect(dockRequestSchema.safeParse({ payload: { kind: 'file', rel: 'a.ts', mode: 'margin', extra: 1 } }).success).toBe(false);
    expect(popoutFocusSchema.safeParse({ key: 't:a', reveal: { line: 2, extra: 1 } }).success).toBe(false);
    expect(dockRequestSchema.safeParse({ handoff: { ...handoff, state: { ...handoff.state, extra: 1 } } }).success).toBe(false);
    expect(dockRequestSchema.safeParse({ handoff: { ...handoff, stamp: { ...handoff.stamp, extra: 1 } } }).success).toBe(false);
    expect(popoutOpenSchema.safeParse({ key: 't:a', size: { width: 800, height: 600, extra: 1 }, at: 'cascade' }).success).toBe(false);
  });
  test('forward: tab-N and the account/profile commands take the regex branch; anything near them is refused', () => {
    expect(popoutForwardSchema.safeParse('tab-1').success).toBe(true);
    expect(popoutForwardSchema.safeParse('tab-9').success).toBe(true);
    expect(popoutForwardSchema.safeParse('tab-0').success).toBe(false);
    expect(popoutForwardSchema.safeParse('tab-10').success).toBe(false);
    expect(popoutForwardSchema.safeParse('new-session-account:work').success).toBe(true);
    expect(popoutForwardSchema.safeParse('new-session-account:').success).toBe(false);
    expect(popoutForwardSchema.safeParse('new-terminal-profile:fish').success).toBe(true);
    // A connector's details page: only a known connector.
    expect(popoutForwardSchema.safeParse('open-connector:clickup').success).toBe(true);
    expect(popoutForwardSchema.safeParse('open-connector:notion').success).toBe(true);
    expect(popoutForwardSchema.safeParse('open-connector:linear').success).toBe(false);
    expect(popoutForwardSchema.safeParse('open-connector:').success).toBe(false);
    expect(popoutForwardSchema.safeParse('new-terminal-profile:').success).toBe(false);
    expect(popoutForwardSchema.safeParse('x-new-session-account:work').success).toBe(false);
    expect(popoutForwardSchema.safeParse('new-session-account:' + 'x'.repeat(300)).success).toBe(false);
  });
  test('handoff: the selection and the undo history are bounded too (16 MiB of JSON each)', () => {
    const big = { ranges: [{ anchor: 0, head: 0 }], main: 0, pad: 'x'.repeat(16 * 1024 * 1024) };
    expect(editorHandoffSchema.safeParse({ ...handoff, state: { ...handoff.state, selection: big } }).success).toBe(false);
    expect(editorHandoffSchema.safeParse({ ...handoff, state: { ...handoff.state, history: { done: [big] } } }).success).toBe(false);
    expect(editorHandoffSchema.safeParse({ ...handoff, state: { ...handoff.state, history: { done: ['x'.repeat(1024 * 1024)] } } }).success).toBe(true);
  });
});

describe('git writes: strict objects, bounded, never a free-form argument', async () => {
  const s = await import('./ipc-schemas');
  const O = 'a'.repeat(40);
  const ok = (schema: { safeParse(v: unknown): { success: boolean } }, v: unknown) => schema.safeParse(v).success;

  test('paths: a listed root, relative paths (no .., no leading /, no NUL, ≤ 4096) or "all", at most 100 000', () => {
    expect(ok(s.gitPathsSchema, { root: '/p', rels: ['a.ts', 'dir/b c.ts', 'è.ts'] })).toBe(true);
    expect(ok(s.gitPathsSchema, { root: '/p', rels: 'all' })).toBe(true);
    for (const bad of [[], ['../x'], ['a/../../x'], ['/abs'], ['a\0b'], [''], ['a//b'], ['x'.repeat(4097)], 'ALL', [1]]) {
      expect(ok(s.gitPathsSchema, { root: '/p', rels: bad })).toBe(false);
    }
    expect(ok(s.gitPathsSchema, { root: '/p', rels: Array.from({ length: 100_001 }, (_, i) => `f${i}`) })).toBe(false);
    expect(ok(s.gitPathsSchema, { root: 'p', rels: ['a'] })).toBe(false);
    expect(ok(s.gitPathsSchema, { root: '/p', rels: ['a'], extra: 1 })).toBe(false);
  });

  test('commit: message ≤ 64 KB without NUL, three booleans', () => {
    const c = { root: '/p', message: 'feat: x\n\n#123 kept', amend: false, coAuthor: true, noVerify: false };
    expect(ok(s.gitCommitSchema, c)).toBe(true);
    expect(ok(s.gitCommitSchema, { ...c, message: 'é'.repeat(32 * 1024 + 1) })).toBe(false);
    expect(ok(s.gitCommitSchema, { ...c, message: 'a\0b' })).toBe(false);
    expect(ok(s.gitCommitSchema, { ...c, amend: 'yes' })).toBe(false);
    expect(ok(s.gitCommitSchema, { ...c, args: ['--force'] })).toBe(false);
    const { noVerify: _n, ...missing } = c;
    expect(ok(s.gitCommitSchema, missing)).toBe(false);
    // expectHead: the HEAD the drawer showed, a full oid when given.
    expect(ok(s.gitCommitSchema, { ...c, amend: true, expectHead: O })).toBe(true);
    for (const bad of ['HEAD', 'abc', `${O}^`, null]) expect(ok(s.gitCommitSchema, { ...c, expectHead: bad })).toBe(false);
  });

  test('sync all: nothing, or the roots to skip (absolute, bounded)', () => {
    expect(ok(s.gitSyncAllSchema, undefined)).toBe(true);
    expect(ok(s.gitSyncAllSchema, { skip: [] })).toBe(true);
    expect(ok(s.gitSyncAllSchema, { skip: ['/p/api', '/p/web'] })).toBe(true);
    for (const bad of [{ skip: ['rel'] }, { skip: '/p' }, { skip: ['/p'], extra: 1 }, {}, { skip: Array.from({ length: 1001 }, (_, i) => `/p/${i}`) }, null]) {
      expect(ok(s.gitSyncAllSchema, bad)).toBe(false);
    }
  });

  test('oids are full hex ids (40 or 64), lowercase', () => {
    expect(ok(s.gitUndoCommitSchema, { root: '/p', oid: O })).toBe(true);
    expect(ok(s.gitUndoCommitSchema, { root: '/p', oid: 'b'.repeat(64) })).toBe(true);
    for (const bad of ['abc', 'A'.repeat(40), 'HEAD', 'a'.repeat(41), `${O}~1`]) expect(ok(s.gitUndoCommitSchema, { root: '/p', oid: bad })).toBe(false);
  });

  test('push, pull, sync: optional publish remote and lease oid; booleans; stash only as true', () => {
    expect(ok(s.gitPushSchema, { root: '/p' })).toBe(true);
    expect(ok(s.gitPushSchema, { root: '/p', publish: { remote: 'origin' } })).toBe(true);
    expect(ok(s.gitPushSchema, { root: '/p', lease: { oid: O } })).toBe(true);
    expect(ok(s.gitPushSchema, { root: '/p', lease: { oid: 'x' } })).toBe(false);
    expect(ok(s.gitPushSchema, { root: '/p', lease: { oid: O, ref: 'main' } })).toBe(false);
    expect(ok(s.gitPushSchema, { root: '/p', publish: { remote: 'x'.repeat(101) } })).toBe(false);
    expect(ok(s.gitPushSchema, { root: '/p', force: true })).toBe(false);
    expect(ok(s.gitPullSchema, { root: '/p', rebase: false })).toBe(true);
    expect(ok(s.gitPullSchema, { root: '/p', rebase: true, stash: true })).toBe(true);
    expect(ok(s.gitPullSchema, { root: '/p', rebase: true, stash: false })).toBe(false);
    expect(ok(s.gitSyncSchema, { root: '/p', rebase: false })).toBe(true);
    expect(ok(s.gitSyncSchema, { root: '/p' })).toBe(false);
  });

  test('switch and branches: full refnames from the refs read, names ≤ 255, carry enum', () => {
    expect(ok(s.gitSwitchSchema, { root: '/p', ref: 'refs/heads/feat/x', carry: 'none' })).toBe(true);
    expect(ok(s.gitSwitchSchema, { root: '/p', ref: 'refs/remotes/origin/x', carry: 'stash' })).toBe(true);
    expect(ok(s.gitSwitchSchema, { root: '/p', ref: 'feat/x', carry: 'bring' })).toBe(false);
    expect(ok(s.gitSwitchSchema, { root: '/p', ref: 'refs/heads/x', carry: 'discard' })).toBe(false);
    expect(ok(s.gitSwitchSchema, { root: '/p', ref: 'refs/heads/a..b', carry: 'none' })).toBe(false);
    expect(ok(s.gitBranchCreateSchema, { root: '/p', name: 'feat/y', switch: true })).toBe(true);
    expect(ok(s.gitBranchCreateSchema, { root: '/p', name: 'feat/y', from: 'refs/tags/v1', switch: false })).toBe(true);
    expect(ok(s.gitBranchCreateSchema, { root: '/p', name: 'x'.repeat(256), switch: true })).toBe(false);
    expect(ok(s.gitBranchCreateSchema, { root: '/p', name: '', switch: true })).toBe(false);
    expect(ok(s.gitBranchCreateSchema, { root: '/p', name: 'a\0b', switch: true })).toBe(false);
    expect(ok(s.gitCheckBranchNameSchema, { root: '/p', name: 'feat/y' })).toBe(true);
    expect(ok(s.gitBranchRenameSchema, { root: '/p', ref: 'refs/heads/x', name: 'y' })).toBe(true);
    expect(ok(s.gitBranchDeleteSchema, { root: '/p', ref: 'refs/heads/x', force: true })).toBe(true);
    expect(ok(s.gitBranchDeleteSchema, { root: '/p', ref: 'refs/heads/x' })).toBe(false);
    expect(ok(s.gitBranchRestoreSchema, { root: '/p', name: 'x', oid: O })).toBe(true);
    expect(ok(s.gitBranchRestoreSchema, { root: '/p', name: 'x', oid: 'HEAD' })).toBe(false);
  });

  test('worktrees: an absolute path, a ref and/or a new name', () => {
    expect(ok(s.gitWorktreeCheckSchema, { root: '/p', path: '/p/.claude/worktrees/x' })).toBe(true);
    expect(ok(s.gitWorktreeCheckSchema, { root: '/p', path: 'rel/x' })).toBe(false);
    expect(ok(s.gitWorktreeAddSchema, { root: '/p', path: '/p/w', ref: 'refs/heads/x' })).toBe(true);
    expect(ok(s.gitWorktreeAddSchema, { root: '/p', path: '/p/w', newName: 'y' })).toBe(true);
    expect(ok(s.gitWorktreeAddSchema, { root: '/p', path: '/p/w', newName: 'y', ref: 'refs/remotes/origin/y' })).toBe(true);
    expect(ok(s.gitWorktreeAddSchema, { root: '/p', path: '/p/w' })).toBe(false);
  });

  test('stashes: index 0..999 with the oid seen, a one-line message', () => {
    expect(ok(s.gitStashPushSchema, { root: '/p', message: 'wip', untracked: true, staged: false })).toBe(true);
    expect(ok(s.gitStashPushSchema, { root: '/p', message: 'a\nb', untracked: true, staged: false })).toBe(false);
    expect(ok(s.gitStashPushSchema, { root: '/p', message: 'x'.repeat(1025), untracked: true, staged: false })).toBe(false);
    expect(ok(s.gitStashApplySchema, { root: '/p', index: 0, oid: O, pop: true })).toBe(true);
    for (const index of [-1, 1000, 1.5, '0']) expect(ok(s.gitStashApplySchema, { root: '/p', index, oid: O, pop: true })).toBe(false);
    expect(ok(s.gitStashDropSchema, { root: '/p', index: 3, oid: O })).toBe(true);
    expect(ok(s.gitStashRestoreSchema, { root: '/p', oid: O, message: 'On main: wip' })).toBe(true);
  });

  test('cancel, remote commits, ✦: bounded ids, 1..20 commits, tweak enum with the current text ≤ 64 KB', () => {
    expect(ok(s.gitIdSchema, { id: 'x'.repeat(64) })).toBe(true);
    expect(ok(s.gitIdSchema, { id: 'x'.repeat(65) })).toBe(false);
    expect(ok(s.gitRemoteCommitsSchema, { root: '/p', n: 3 })).toBe(true);
    for (const n of [0, 21, 2.5]) expect(ok(s.gitRemoteCommitsSchema, { root: '/p', n })).toBe(false);
    expect(ok(s.scmMessageSchema, { root: '/p' })).toBe(true);
    expect(ok(s.scmMessageSchema, { root: '/p', tweak: { kind: 'shorter', current: 'feat: x' } })).toBe(true);
    expect(ok(s.scmMessageSchema, { root: '/p', tweak: { kind: 'poem', current: 'x' } })).toBe(false);
    expect(ok(s.scmMessageSchema, { root: '/p', tweak: { kind: 'detail', current: 'x'.repeat(64 * 1024 + 1) } })).toBe(false);
    expect(ok(s.scmMessageSchema, { root: '/p', model: 'opus' })).toBe(false);
  });
});

describe('automations: strict shapes, values validated again by normalizeAutomation', () => {
  const valid = normalizeAutomation({ id: 'a1', name: 'Bug fixes', project: '/p/acme', source: { connector: 'clickup', scopes: ['901500000301'] }, conditions: [{ field: 'status', values: ['Ready for AI'] }] })!;
  test('a whole automation passes; an extra field, a wrong type or an oversized value doesn\'t', () => {
    expect(automationSaveSchema.safeParse({ automation: valid }).success).toBe(true);
    // People chips carry their names.
    expect(automationSaveSchema.safeParse({ automation: { ...valid, conditions: [{ field: 'createdBy', values: ['me', '81000002'], labels: ['Me', 'Grace'] }] } }).success).toBe(true);
    for (const bad of [
      { ...valid, conditions: [{ field: 'createdBy', values: ['me'], labels: ['x'.repeat(101)] }] },
      { ...valid, conditions: [{ field: 'createdBy', values: ['me'], labels: Array.from({ length: 21 }, () => 'x') }] },
      { ...valid, command: 'echo hi' }, { ...valid, id: '../x' }, { ...valid, source: { ...valid.source, url: 'https://x' } },
      { ...valid, conditions: [{ field: 'status', values: ['x'], extra: 1 }] }, { ...valid, instructions: 'x'.repeat(40_000) },
      { ...valid, claude: { ...valid.claude, flags: '--some-flag' } },
      { ...valid, isolation: { worktree: true, base: { branch: 'x', start: 'HEAD' } } }
    ]) expect(automationSaveSchema.safeParse({ automation: bad }).success, JSON.stringify(bad).slice(0, 80)).toBe(false);
  });

  test('refs and switches: plain ids and booleans only', () => {
    expect(automationRefSchema.safeParse({ id: 'a1' }).success).toBe(true);
    expect(automationRefSchema.safeParse({ id: 'a/1' }).success).toBe(false);
    expect(runRefSchema.safeParse({ runId: 'r1' }).success).toBe(true);
    expect(runRefSchema.safeParse({ runId: 'r1', extra: 1 }).success).toBe(false);
    expect(automationTurnOnSchema.safeParse({ id: 'a1', startMatching: true }).success).toBe(true);
    expect(automationTurnOnSchema.safeParse({ id: 'a1', startMatching: 'yes' }).success).toBe(false);
    expect(automationCatchUpSchema.safeParse({ id: 'a1', action: 'start' }).success).toBe(true);
    expect(automationCatchUpSchema.safeParse({ id: 'a1', action: 'run' }).success).toBe(false);
    expect(automationPausedSchema.safeParse({ paused: true }).success).toBe(true);
  });
});

test('a source search: 1..200 characters; Jira alone may send an empty one (its picker lists the first projects)', () => {
  expect(sourceSearchSchema.safeParse({ id: 'jira', query: '' }).success).toBe(true);
  expect(sourceSearchSchema.safeParse({ id: 'jira', query: 'atl' }).success).toBe(true);
  expect(sourceSearchSchema.safeParse({ id: 'notion', query: '' }).success).toBe(false);
  expect(sourceSearchSchema.safeParse({ id: 'clickup', query: '' }).success).toBe(false);
  expect(sourceSearchSchema.safeParse({ id: 'jira', query: 'x'.repeat(201) }).success).toBe(false);
  expect(sourceSearchSchema.safeParse({ id: 'jira', query: '', extra: 1 }).success).toBe(false);
});

test('tab tear-off: the theme on screen, one of the themes or nothing', () => {
  const base = { key: 't:a', title: 'A', icon: 'session', size: { width: 600, height: 400 } };
  expect(popoutTearStartSchema.safeParse({ ...base, theme: 'paper' }).success).toBe(true);
  expect(popoutTearStartSchema.safeParse({ ...base, theme: 'neon' }).success).toBe(false);
});

test('tab tear-off: a session with avatars off sends the session tile; an unknown icon is refused', () => {
  const base = { key: 't:a', title: 'A', size: { width: 600, height: 400 } };
  expect(popoutTearStartSchema.safeParse({ ...base, icon: 'session-tile' }).success).toBe(true);
  expect(popoutTearStartSchema.safeParse({ ...base, icon: 'session' }).success).toBe(true);
  expect(popoutTearStartSchema.safeParse({ ...base, icon: 'avatar' }).success).toBe(false);
});

describe('Ask companion: a binding, a question, a catch-up and a session id, strictly shaped', () => {
  const SID = '0b5c8f0e-1111-4222-8333-944455556666';
  const binding = { terminalId: 't-1', sessionId: SID, cwd: '/p/acme', configDir: null, title: 'Fix the login' };
  const ask = (o: Record<string, unknown>) => companionAskSchema.safeParse({ binding, text: 'Is it done?', ...o }).success;

  test('a binding: a terminal id, a session uuid, a clean absolute cwd, a clean absolute config dir or null, a title', () => {
    expect(bindingSchema.safeParse(binding).success).toBe(true);
    expect(bindingSchema.safeParse({ ...binding, configDir: '/Users/x/.claude-work' }).success).toBe(true);
    expect(bindingSchema.safeParse({ ...binding, extra: 1 }).success).toBe(false);
    for (const sessionId of ['', 'x', `${SID}x`, `../${SID}`, 3, null]) expect(bindingSchema.safeParse({ ...binding, sessionId }).success, String(sessionId)).toBe(false);
    for (const cwd of ['p/acme', '', '/p/../etc', '/p/./a', '/p//a']) expect(bindingSchema.safeParse({ ...binding, cwd }).success, cwd).toBe(false);
    for (const configDir of ['.claude', '/a/../b', '', undefined]) expect(bindingSchema.safeParse({ ...binding, configDir }).success, String(configDir)).toBe(false);
    expect(bindingSchema.safeParse({ ...binding, terminalId: '' }).success).toBe(false);
    expect(bindingSchema.safeParse({ ...binding, terminalId: 'x'.repeat(65) }).success).toBe(false);
    expect(bindingSchema.safeParse({ ...binding, title: 'x'.repeat(1001) }).success).toBe(false);
    const { title: _t, ...noTitle } = binding;
    expect(bindingSchema.safeParse(noTitle).success).toBe(false);
  });

  test('a question: 1..8000 characters, a known model, the session or an account id; nothing else', () => {
    expect(ask({})).toBe(true);
    expect(ask({ model: 'haiku', account: 'session' })).toBe(true);
    expect(ask({ model: 'opus', account: 'work-2' })).toBe(true);
    expect(ask({ text: 'x'.repeat(8000) })).toBe(true);
    expect(ask({ text: '' })).toBe(false);
    expect(ask({ text: 'x'.repeat(8001) })).toBe(false);
    expect(ask({ model: 'gpt' })).toBe(false);
    for (const account of ['', 'Work', '-x', 'a'.repeat(33), '../x', 3]) expect(ask({ account }), String(account)).toBe(false);
    expect(ask({ extra: 1 })).toBe(false);
    expect(ask({ binding: { ...binding, sessionId: 'nope' } })).toBe(false);
    expect(ask({ binding: { ...binding, cwd: 'relative' } })).toBe(false);
  });

  test("a catch-up: a binding and final, the thread's picked model and account as a question takes them; a session id alone for the rest", () => {
    const catchUp = (o: Record<string, unknown>) => companionCatchUpSchema.safeParse({ binding, final: false, ...o }).success;
    expect(catchUp({})).toBe(true);
    expect(catchUp({ final: 'yes' })).toBe(false);
    expect(companionCatchUpSchema.safeParse({ binding }).success).toBe(false);
    expect(catchUp({ final: true, model: 'haiku' })).toBe(true);
    expect(catchUp({ model: 'opus', account: 'work-2' })).toBe(true);
    expect(catchUp({ account: 'session' })).toBe(true);
    expect(catchUp({ model: 'gpt' })).toBe(false);
    for (const account of ['', 'Work', '-x', 'a'.repeat(33), '../x', 3]) expect(catchUp({ account }), String(account)).toBe(false);
    expect(catchUp({ text: 'Is it done?' })).toBe(false);
    expect(catchUp({ extra: 1 })).toBe(false);
    expect(companionSessionSchema.safeParse({ sessionId: SID }).success).toBe(true);
    expect(companionSessionSchema.safeParse({ sessionId: 'not-a-uuid' }).success).toBe(false);
    expect(companionSessionSchema.safeParse({ sessionId: SID, extra: 1 }).success).toBe(false);
    expect(companionSessionSchema.safeParse(SID).success).toBe(false);
  });
});

describe('databases: strict shapes, every list and text bounded, identifiers without NUL', () => {
  const ID = 'c0123456789ab';
  const ref = { connId: ID, schema: 'public', name: 'Order "Items"' };
  const page = {
    ref, columns: ['id', 'meta'], derived: [{ column: 'meta', path: ['a', 0] }],
    filters: [
      { column: 'status', op: 'in', values: ['paid', 'shipped'] }, { column: 'meta', path: ['tags', 1], op: 'pathEq', values: ['x'] },
      { column: 'deleted_at', op: 'null', values: [] }, { column: 'total', op: 'between', values: ['1', '9'] }, { column: 'note', path: [], op: 'eq', values: ['a'] }
    ],
    sort: [{ column: 'id', dir: 'desc' }, { column: 'meta', path: ['n'], dir: 'asc' }], page: 3, size: 250
  };
  const pageOk = (o: Record<string, unknown>) => dbPageSchema.safeParse({ ...page, ...o }).success;
  const filter = (f: Record<string, unknown>) => pageOk({ filters: [{ column: 'c', op: 'eq', values: ['1'], ...f }] });
  const n = <T>(k: number, f: (i: number) => T): T[] => Array.from({ length: k }, (_, i) => f(i));

  test('a full page request is accepted as it is', () => {
    expect(dbPageSchema.parse(page)).toEqual(page);
    expect(pageOk({ columns: [], derived: [], filters: [], sort: [], page: 0, size: 50 })).toBe(true);
    for (const size of [50, 100, 250, 500]) expect(pageOk({ size }), String(size)).toBe(true);
    expect(pageOk({ page: 1_000_000 })).toBe(true);
    expect(pageOk({ columns: n(200, (i) => `c${i}`), filters: n(30, () => page.filters[0]), sort: n(10, () => page.sort[0]), derived: n(20, () => page.derived[0]) })).toBe(true);
  });

  test('a page request: no unknown key anywhere, a size of 50/100/250/500, a page 0–1,000,000, bounded lists', () => {
    expect(pageOk({ extra: 1 })).toBe(false);
    expect(pageOk({ ref: { ...ref, extra: 1 } })).toBe(false);
    expect(pageOk({ derived: [{ column: 'meta', path: ['a'], extra: 1 }] })).toBe(false);
    expect(pageOk({ sort: [{ column: 'id', dir: 'desc', extra: 1 }] })).toBe(false);
    expect(filter({ extra: 1 })).toBe(false);
    for (const size of [77, 0, 1, 499, 1000, '100']) expect(pageOk({ size }), String(size)).toBe(false);
    for (const p of [-1, 1_000_001, 1.5, '3', NaN]) expect(pageOk({ page: p }), String(p)).toBe(false);
    expect(pageOk({ columns: n(201, (i) => `c${i}`) })).toBe(false);
    expect(pageOk({ filters: n(31, () => page.filters[0]) })).toBe(false);
    expect(pageOk({ sort: n(11, () => page.sort[0]) })).toBe(false);
    expect(pageOk({ derived: n(21, () => page.derived[0]) })).toBe(false);
    expect(pageOk({ sort: [{ column: 'id', dir: 'up' }] })).toBe(false);
    for (const k of ['ref', 'columns', 'derived', 'filters', 'sort', 'page', 'size']) {
      const { [k]: _gone, ...rest } = page as Record<string, unknown>;
      expect(dbPageSchema.safeParse(rest).success, k).toBe(false);
    }
  });

  test('identifiers (schema, table, column, key names): 1–128 characters, never a NUL', () => {
    const long = 'x'.repeat(129);
    expect(pageOk({ ref: { ...ref, name: 'x'.repeat(128) } })).toBe(true);
    for (const bad of [long, '', 'a\0b']) {
      expect(pageOk({ ref: { ...ref, schema: bad } }), `schema ${bad}`).toBe(false);
      expect(pageOk({ ref: { ...ref, name: bad } }), `name ${bad}`).toBe(false);
      expect(pageOk({ columns: [bad] }), `column ${bad}`).toBe(false);
      expect(pageOk({ derived: [{ column: bad, path: ['a'] }] }), `derived ${bad}`).toBe(false);
      expect(pageOk({ sort: [{ column: bad, dir: 'asc' }] }), `sort ${bad}`).toBe(false);
      expect(filter({ column: bad }), `filter ${bad}`).toBe(false);
      expect(dbRefsSchema.safeParse({ ref, key: { [bad]: '1' } }).success, `refs key ${bad}`).toBe(false);
      expect(dbFullSchema.safeParse({ ref, key: { id: '1' }, column: bad }).success, `full column ${bad}`).toBe(false);
      expect(dbSchemaPickSchema.safeParse({ id: ID, schema: bad }).success, `schema chip ${bad}`).toBe(false);
    }
    for (const connId of ['c0123456789AB', 'c0123456789a', 's0123456789ab', '']) expect(pageOk({ ref: { ...ref, connId } }), connId).toBe(false);
  });

  test('JSON paths: at most 16 elements, keys of at most 256 characters without a NUL, whole indexes from 0', () => {
    const at = (path: unknown[]) => pageOk({ derived: [{ column: 'meta', path }] });
    expect(at(n(16, (i) => (i % 2 ? i : `k${i}`)))).toBe(true);
    expect(at(['', 'x'.repeat(256), 0, 2_147_483_647])).toBe(true);
    expect(at(n(17, (i) => `k${i}`))).toBe(false);
    expect(at([])).toBe(false);
    expect(at(['x'.repeat(257)])).toBe(false);
    expect(at(['a\0b'])).toBe(false);
    for (const bad of [-1, 1.5, NaN, Infinity, null, true, {}]) expect(at([bad]), String(bad)).toBe(false);
    expect(filter({ column: 'meta', op: 'pathEq', path: n(17, (i) => `k${i}`) })).toBe(false);
    expect(pageOk({ sort: [{ column: 'meta', path: n(17, (i) => `k${i}`), dir: 'asc' }] })).toBe(false);
    expect(dbFullSchema.safeParse({ ref, key: { id: '1' }, column: 'meta', path: n(17, (i) => `k${i}`) }).success).toBe(false);
  });

  test('filters: an operator of the union, its number of values, bounded values, a path only on a JSON operator (which needs one)', () => {
    for (const op of ['like', 'ilike', 'raw', '', 'EQ']) expect(filter({ op }), op).toBe(false);
    expect(filter({ op: 'eq', values: ['1', '2'] })).toBe(false);
    expect(filter({ op: 'eq', values: [] })).toBe(false);
    expect(filter({ op: 'between', values: ['1'] })).toBe(false);
    expect(filter({ op: 'null', values: ['1'] })).toBe(false);
    expect(filter({ op: 'in', values: [] })).toBe(false);
    expect(filter({ op: 'in', values: n(100, String) })).toBe(true);
    expect(filter({ op: 'in', values: n(101, String) })).toBe(false);
    expect(filter({ values: ['x'.repeat(10_000)] })).toBe(true);
    expect(filter({ values: ['x'.repeat(10_001)] })).toBe(false);
    expect(filter({ values: [1] })).toBe(false);
    // Postgres text can't hold a NUL.
    expect(filter({ values: ['a\0b'] })).toBe(false);
    expect(filter({ op: 'in', values: ['a', '\0'] })).toBe(false);
    expect(filter({ op: 'eq', path: ['a'] })).toBe(false);
    expect(filter({ op: 'pathEq' })).toBe(false);
    expect(filter({ op: 'pathExists', path: ['a'], values: [] })).toBe(true);
    expect(filter({ op: 'pathExists', path: [], values: [] })).toBe(false);
    expect(filter({ op: 'pathNull', path: ['a'], values: [] })).toBe(true);
    expect(filter({ op: 'pathNull', path: [], values: [] })).toBe(false);
    expect(filter({ op: 'pathNull', path: ['a'], values: ['x'] })).toBe(false);
  });

  test('estimate and count: a table and its filters; structure, relations, DDL: a table', () => {
    expect(dbFilteredSchema.safeParse({ ref, filters: page.filters }).success).toBe(true);
    expect(dbFilteredSchema.safeParse({ ref, filters: n(31, () => page.filters[0]) }).success).toBe(false);
    expect(dbFilteredSchema.safeParse({ ref, filters: [], extra: 1 }).success).toBe(false);
    expect(dbFilteredSchema.safeParse({ ref }).success).toBe(false);
    expect(dbTableRefSchema.safeParse(ref).success).toBe(true);
    expect(dbTableRefSchema.safeParse({ ...ref, extra: 1 }).success).toBe(false);
    expect(dbTableRefSchema.safeParse({ connId: ID, schema: 'public' }).success).toBe(false);
  });

  test('DDL: a table, or a function by its identity arguments — each shape strict, the arguments bounded text', () => {
    const fn = { connId: ID, schema: 'public', name: 'order_total', args: 'bigint' };
    expect(dbDdlSchema.parse(ref)).toEqual(ref);
    expect(dbDdlSchema.parse(fn)).toEqual(fn);
    expect(dbDdlSchema.safeParse({ ...fn, args: '' }).success).toBe(true);
    expect(dbDdlSchema.safeParse({ ...fn, args: 'integer, text, timestamp with time zone[]' }).success).toBe(true);
    expect(dbDdlSchema.safeParse({ ...fn, args: 'x'.repeat(16_384) }).success).toBe(true);
    expect(dbDdlSchema.safeParse({ ...fn, args: 'x'.repeat(16_385) }).success).toBe(false);
    expect(dbDdlSchema.safeParse({ ...fn, args: 'int\0' }).success).toBe(false);
    for (const args of [null, 7, ['bigint'], true]) expect(dbDdlSchema.safeParse({ ...fn, args }).success, String(args)).toBe(false);
    expect(dbDdlSchema.safeParse({ ...fn, extra: 1 }).success).toBe(false);
    expect(dbDdlSchema.safeParse({ ...ref, extra: 1 }).success).toBe(false);
    for (const bad of ['', 'x'.repeat(129), 'a\0b']) {
      expect(dbDdlSchema.safeParse({ ...fn, schema: bad }).success, `schema ${bad}`).toBe(false);
      expect(dbDdlSchema.safeParse({ ...fn, name: bad }).success, `name ${bad}`).toBe(false);
    }
    expect(dbDdlSchema.safeParse({ ...fn, connId: 'c0123456789AB' }).success).toBe(false);
  });

  test('peek, references and full value: key columns with text values (NULL only where a reference may hold one)', () => {
    expect(dbPeekSchema.safeParse({ ref, cols: ['a', 'b'], values: ['1', 'x'] }).success).toBe(true);
    expect(dbPeekSchema.safeParse({ ref, cols: ['a', 'b'], values: ['1'] }).success).toBe(false);
    expect(dbPeekSchema.safeParse({ ref, cols: ['a'], values: [null] }).success).toBe(false);
    expect(dbPeekSchema.safeParse({ ref, cols: n(201, (i) => `c${i}`), values: n(201, String) }).success).toBe(false);
    expect(dbPeekSchema.safeParse({ ref, cols: ['a'], values: ['x'.repeat(10_001)] }).success).toBe(false);
    expect(dbPeekSchema.safeParse({ ref, cols: ['a'], values: ['1'], extra: 1 }).success).toBe(false);
    // The row itself by its key (main checks the key names one row): only `row: true`.
    expect(dbPeekSchema.safeParse({ ref, cols: ['a'], values: ['1'], row: true }).success).toBe(true);
    expect(dbPeekSchema.safeParse({ ref, cols: ['a'], values: ['1'], row: false }).success).toBe(false);
    expect(dbPeekSchema.safeParse({ ref, cols: ['a'], values: ['1'], row: 'yes' }).success).toBe(false);
    expect(dbRefsSchema.safeParse({ ref, key: { id: '7', tenant: null } }).success).toBe(true);
    expect(dbRefsSchema.safeParse({ ref, key: { id: 7 } }).success).toBe(false);
    expect(dbRefsSchema.safeParse({ ref, key: Object.fromEntries(n(201, (i) => [`c${i}`, '1'])) }).success).toBe(false);
    expect(dbRefsSchema.safeParse({ ref, key: { id: '7' }, extra: 1 }).success).toBe(false);
    expect(dbFullSchema.safeParse({ ref, key: { id: '7' }, column: 'doc' }).success).toBe(true);
    expect(dbFullSchema.safeParse({ ref, key: { id: '7' }, column: 'doc', path: ['a', 0] }).success).toBe(true);
    expect(dbFullSchema.safeParse({ ref, key: { id: null }, column: 'doc' }).success).toBe(false);
    expect(dbFullSchema.safeParse({ ref, key: { id: '7' }, column: 'doc', extra: 1 }).success).toBe(false);
    // Key values are text Postgres compares: never a NUL.
    expect(dbPeekSchema.safeParse({ ref, cols: ['a'], values: ['1\0'] }).success).toBe(false);
    expect(dbRefsSchema.safeParse({ ref, key: { id: '7\0', tenant: null } }).success).toBe(false);
    expect(dbFullSchema.safeParse({ ref, key: { id: '\0' }, column: 'doc' }).success).toBe(false);
  });

  test('connection ids; select takes one or null; mask and schema chip', () => {
    expect(dbIdSchema.safeParse(ID).success).toBe(true);
    for (const id of ['c0123456789AB', 'c0123456789a', 'c0123456789abc', 's0123456789ab', 'c-123456789ab', '', 7, null]) expect(dbIdSchema.safeParse(id).success, String(id)).toBe(false);
    expect(dbSelectSchema.safeParse(null).success).toBe(true);
    expect(dbSelectSchema.safeParse(ID).success).toBe(true);
    expect(dbSelectSchema.safeParse(undefined).success).toBe(false);
    expect(dbSelectSchema.safeParse('s0123456789ab').success).toBe(false);
    expect(dbMaskSchema.safeParse({ id: ID, on: true }).success).toBe(true);
    expect(dbMaskSchema.safeParse({ id: ID, on: 'yes' }).success).toBe(false);
    expect(dbMaskSchema.safeParse({ id: ID, on: true, extra: 1 }).success).toBe(false);
    expect(dbSchemaPickSchema.safeParse({ id: ID, schema: 'billing' }).success).toBe(true);
    expect(dbSchemaPickSchema.safeParse({ id: ID, schema: 'billing', extra: 1 }).success).toBe(false);
  });

  test('a typed password: at most 1024 characters, with whether to keep it', () => {
    expect(dbPasswordSchema.safeParse({ connId: ID, password: 'pw', save: true }).success).toBe(true);
    expect(dbPasswordSchema.safeParse({ connId: ID, password: 'x'.repeat(1024), save: false }).success).toBe(true);
    expect(dbPasswordSchema.safeParse({ connId: ID, password: 'x'.repeat(1025), save: false }).success).toBe(false);
    expect(dbPasswordSchema.safeParse({ connId: ID, password: 'pw' }).success).toBe(false);
    expect(dbPasswordSchema.safeParse({ connId: ID, password: 'pw', save: true, extra: 1 }).success).toBe(false);
    expect(dbPasswordSchema.safeParse({ connId: 'nope', password: 'pw', save: true }).success).toBe(false);
  });

  test('Test Connection and Save: the form as the connections file keeps it (no id, mask, note, schema or time), a password or none', () => {
    const form = { name: 'acme_dev', engine: 'postgres', env: 'local', host: '127.0.0.1', port: 5432, database: 'acme_dev', user: 'acme', tls: 'prefer', ssh: null, scope: { kind: 'project', root: '/code/acme' } };
    const edit = (o: Record<string, unknown>, f: Record<string, unknown> = {}) => dbEditSchema.safeParse({ form: { ...form, ...f }, password: 'pw', id: null, ...o }).success;
    expect(edit({})).toBe(true);
    // Editing with the field left empty keeps the saved one: '' and null both say so.
    expect(edit({ id: ID, password: '' })).toBe(true);
    expect(edit({ id: ID, password: null })).toBe(true);
    expect(edit({ password: 'x'.repeat(1024) })).toBe(true);
    expect(edit({ password: 'x'.repeat(1025) })).toBe(false);
    expect(edit({ id: 's0123456789ab' })).toBe(false);
    expect(edit({ extra: 1 })).toBe(false);
    expect(dbEditSchema.safeParse({ form, password: 'pw' }).success).toBe(false);
    expect(edit({}, { socket: '/tmp', host: '' })).toBe(true);
    expect(edit({}, { ssh: { host: 'bastion', port: 22, user: 'me' }, scope: { kind: 'all' }, env: 'prod', tls: 'verify' })).toBe(true);
    for (const [k, v] of [['password', 'pw'], ['id', ID], ['mask', true], ['writeNoted', true], ['schema', 'public'], ['createdAt', 1], ['extra', 1]] as const) {
      expect(edit({}, { [k]: v }), k).toBe(false);
    }
    expect(edit({}, { host: '' })).toBe(false);
    expect(edit({}, { port: 0 })).toBe(false);
    expect(edit({}, { port: 65536 })).toBe(false);
    expect(edit({}, { engine: 'mysql' })).toBe(false);
    expect(edit({}, { env: 'test' })).toBe(false);
    expect(edit({}, { tls: 'on' })).toBe(false);
    expect(edit({}, { name: '' })).toBe(false);
    expect(edit({}, { name: 'x'.repeat(121) })).toBe(false);
    expect(edit({}, { database: 'a\nb' })).toBe(false);
    expect(edit({}, { socket: 'tmp' })).toBe(false);
    expect(edit({}, { scope: { kind: 'project', root: 'code/acme' } })).toBe(false);
    expect(edit({}, { ssh: { host: 'bastion', port: 22 } })).toBe(false);
    // Nothing ssh would read as an option or split, and no tunnel for a socket (it forwards TCP).
    expect(edit({}, { ssh: { host: '-oProxyCommand=x', port: 22, user: 'me' } })).toBe(false);
    expect(edit({}, { ssh: { host: 'bastion', port: 22, user: '-l' } })).toBe(false);
    expect(edit({}, { ssh: { host: 'bastion host', port: 22, user: 'me' } })).toBe(false);
    expect(edit({}, { ssh: { host: 'bastion', port: 22, user: 'me\n' } })).toBe(false);
    expect(edit({}, { ssh: { host: 'bastion', port: 22, user: 'me' }, socket: '/tmp' })).toBe(false);
    expect(edit({}, { ssh: { host: 'bastion', port: 22, user: 'me' }, socket: '/tmp', host: '' })).toBe(false);
    // With ssh on, both hosts are names or IP literals, the user [A-Za-z0-9._-].
    for (const h of ['me@bastion', 'a;b', '$(x)', '`x`', "a'b", '${HOME}', 'a/b', 'a\\b']) {
      expect(edit({}, { ssh: { host: h, port: 22, user: 'me' } }), h).toBe(false);
      expect(edit({}, { ssh: { host: 'bastion', port: 22, user: 'me' }, host: h }), h).toBe(false);
      expect(edit({}, { ssh: { host: 'bastion', port: 22, user: h } }), h).toBe(false);
    }
    // Port and user optional (~/.ssh/config decides).
    expect(edit({}, { ssh: { host: 'prod-bastion', port: null, user: '' } })).toBe(true);
    // '_' in an alias and in a compose service name behind the bastion.
    expect(edit({}, { ssh: { host: 'prod_bastion', port: null, user: '' }, host: 'postgres_db' })).toBe(true);
    expect(edit({}, { ssh: { host: 'prod-bastion', user: '' } })).toBe(false);
  });

  test('Test Connection takes Save\'s request, nothing more: no suggestion to name', () => {
    const form = { name: 'acme_dev', engine: 'postgres', env: 'local', host: '127.0.0.1', port: 5432, database: 'acme_dev', user: 'acme', tls: 'prefer', ssh: null, scope: { kind: 'project', root: '/code/acme' } };
    const probe = (o: Record<string, unknown>) => dbTestSchema.safeParse({ form, password: null, id: null, ...o }).success;
    expect(probe({})).toBe(true);
    expect(probe({ password: 'typed', id: ID })).toBe(true);
    for (const s of ['s0123456789ab', ID, '', null]) expect(probe({ suggestion: s }), String(s)).toBe(false);
    expect(probe({ extra: 1 })).toBe(false);
    expect(probe({ form: { ...form, password: 'pw' } })).toBe(false);
    expect(dbEditSchema.safeParse({ form, password: null, id: null, suggestion: 's0123456789ab' }).success).toBe(false);
  });
});
