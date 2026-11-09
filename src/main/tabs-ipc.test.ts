import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { posixTest } from '../../tests/support/platform';
import type { IpcMainInvokeEvent } from 'electron';
import { GrantStore } from './fs/grants';
import { SenderRoots, openFilesOf, outsideOpenNow, readOnlyOf, restoreGrants } from './tabs-ipc';

// POSIX: Claude Code's /tmp/claude-<uid> folder (uid, mode checks).
posixTest('restore: every file in Claude\'s temp folder comes back read-only with its short label; other outside files as before', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'atl-trc-')));
  chmodSync(tmp, 0o700);
  const dir = join(tmp, '-p', 's', 'scratchpad');
  mkdirSync(dir, { recursive: true });
  const png = join(dir, 'a.png');
  const notes = join(dir, 'notes.md');
  writeFileSync(png, 'png');
  writeFileSync(notes, 'x');
  const out = realpathSync(mkdtempSync(join(tmpdir(), 'atl-tro-')));
  const x = join(out, 'x.json');
  writeFileSync(x, '{}');
  const g = new GrantStore();
  const { grant, label } = restoreGrants('/proj', g, { tmp: () => tmp, uid: process.getuid!(), grants: g });
  expect(grant(png)).toBe(png);
  expect(g.mode('/proj', png)).toBe('read');
  expect(label(png)).toBe('scratchpad/a.png');
  // A text file there may come from a terminal link: the saved tabs don't say which, so never editable.
  expect(grant(notes)).toBe(notes);
  expect(g.mode('/proj', notes)).toBe('read');
  expect(label(notes)).toBe('scratchpad/notes.md');
  // Elsewhere outside the project: only a gesture granted it, so it stays editable, with its ~ label.
  expect(grant(x)).toBe(x);
  expect(g.mode('/proj', x)).toBe('edit');
  expect(label(x)).toBeNull();
  // A folder is never taken for a file.
  expect(label(dir + '/')).toBeNull();
  expect(label(dir)).toBeNull();
});

// POSIX: Claude Code's /tmp/claude-<uid> folder (uid, mode checks).
posixTest('restore: a Claude temp file whose check now fails is dropped, never granted for editing', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'atl-trd-')));
  const dir = join(tmp, '-p', 's', 'scratchpad');
  mkdirSync(dir, { recursive: true });
  const png = join(dir, 'a.png');
  const notes = join(dir, 'notes.md');
  writeFileSync(png, 'png');
  writeFileSync(notes, 'x');
  // Writable by others since the tab was saved: no longer trusted.
  chmodSync(tmp, 0o777);
  const g = new GrantStore();
  const { grant } = restoreGrants('/proj', g, { tmp: () => tmp, uid: process.getuid!(), grants: g });
  expect(grant(png)).toBeNull();
  expect(grant(notes)).toBeNull();
  expect(g.list('/proj')).toEqual([]);
});

function outsidePair() {
  const out = realpathSync(mkdtempSync(join(tmpdir(), 'atl-trr-')));
  const plan = join(out, 'plan.md');
  const picked = join(out, 'picked.md');
  writeFileSync(plan, '# plan');
  writeFileSync(picked, '# picked');
  return { plan, picked };
}

test("a save's read-only outside files come from main's grants, never from the page", () => {
  const { plan, picked } = outsidePair();
  const g = new GrantStore();
  g.grant('/proj', plan, 'read');
  g.grant('/proj', picked);
  expect(readOnlyOf('/proj', g, ['/proj/src/a.ts', plan, picked, '/elsewhere/not-granted.md'])).toEqual([plan]);
});

test('restore: an outside file main saved as read-only comes back read-only; one it saved editable, editable', () => {
  const { plan, picked } = outsidePair();
  const g = new GrantStore();
  const { grant } = restoreGrants('/proj', g, null, [plan]);
  expect(grant(plan)).toBe(plan);
  expect(g.mode('/proj', plan)).toBe('read');
  expect(grant(picked)).toBe(picked);
  expect(g.mode('/proj', picked)).toBe('edit');
  // Saved before main kept the mode (no list): as a gesture made it, as before.
  const old = new GrantStore();
  expect(restoreGrants('/proj', old, null, null).grant(plan)).toBe(plan);
  expect(old.mode('/proj', plan)).toBe('edit');
});

test("the outside files open in a project: its main window's tabs plus its pop-outs' granted files", () => {
  const inside = (f: string) => f.startsWith('/p/');
  const granted = (f: string) => (f.startsWith('/out/') ? f : null);
  expect(outsideOpenNow(['/p/a.ts', '/out/x.json'], ['/out/popped.json', '/p/b.ts', '/etc/passwd', 'untitled:1', '/out/x.json'], inside, granted))
    .toEqual(['/out/x.json', '/out/popped.json']);
  expect(outsideOpenNow([], [], inside, granted)).toEqual([]);
});

test('what counts as open for a project: its file tabs and its shelf\'s files (watched, never the grants given up first)', () => {
  expect(openFilesOf({ files: ['/p/a.ts', '/h/x.json'], order: [], active: null, shelf: ['/h/dump.sql'] })).toEqual(['/p/a.ts', '/h/x.json', '/h/dump.sql']);
  expect(openFilesOf({ files: [{ path: '/h/x.json', rel: '~/x.json', external: true }], order: [], active: null, shelf: [{ path: '/h/dump.sql', rel: '~/dump.sql', external: true }] })).toEqual(['/h/x.json', '/h/dump.sql']);
  expect(openFilesOf({ files: ['/p/a.ts'], order: [], active: null })).toEqual(['/p/a.ts']);
});

const ev = (id: number, frame: boolean) => ({ sender: { id }, senderFrame: frame ? { url: 'app://x' } : null }) as unknown as IpcMainInvokeEvent;

test("a closing window's last save still finds its project (its frame is gone by then); never a stranger's", () => {
  const roots = new Map<number, string | null>([[1, '/p']]);
  const s = new SenderRoots((id) => roots.get(id) ?? null, (e) => e.senderFrame !== null);
  expect(s.of(ev(1, true))).toBe('/p');
  roots.delete(1);
  expect(s.of(ev(1, false))).toBe('/p');
  // Never seen trusted: nothing.
  expect(s.of(ev(2, false))).toBeNull();
  // A frame that is there but not an app page: refused even if known.
  expect(new SenderRoots(() => '/p', () => false).of(ev(1, true))).toBeNull();
});

test("a closing window's last save is stored, but its tabs no longer count as open once the window is gone", () => {
  const roots = new Map<number, string | null>([[1, '/p']]);
  const s = new SenderRoots((id) => roots.get(id) ?? null, (e) => e.senderFrame !== null);
  expect(s.of(ev(1, true))).toBe('/p');
  expect(s.stillOpen(ev(1, true))).toBe(true);
  roots.delete(1);
  expect(s.of(ev(1, false))).toBe('/p');
  expect(s.stillOpen(ev(1, false))).toBe(false);
});
