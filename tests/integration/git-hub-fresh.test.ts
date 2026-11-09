// The status read Atelier asks for after one of its git writes always reaches the windows, even when it equals the
// last snapshot sent (the idle-work dedup): the Sync button lays what a pull or push left until a read from after it
// comes in (renderer git/sync-intents.ts), and a read that never came would keep a guess on screen. Other reads are
// still sent only when something changed.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import { IPC } from '../../src/shared/api';
import { posixTest } from '../support/platform';
import { GitHub } from '../../src/main/git-hub';
import { commit, git } from '../support/git-fixture';

const until = async (ok: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!ok()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)); }
};

// POSIX: POSIX path fixtures.
posixTest('requestStatus: its read is sent even when nothing changed; a read nobody asked for is not', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atl-ghf-')));
  git(root, 'init', '-q', '-b', 'main');
  commit(root, 'first', { 'a.ts': '1\n' });
  const client = { request: vi.fn(async () => ({})) };
  const h = new GitHub(client as never);
  const sent: unknown[] = [];
  const wc = { id: 1, isDestroyed: () => false, send: (ch: string, x: unknown) => { if (ch === IPC.evGit) sent.push(x); }, once: () => {} };
  h.open(root, wc as never);
  await until(() => sent.length > 0);
  await new Promise((r) => setTimeout(r, 1200));
  const first = sent.length;

  // Nothing changed: a read from a file event finds the same status and sends nothing.
  h.touched(join(root, 'a.ts'));
  await new Promise((r) => setTimeout(r, 1500));
  expect(sent.length).toBe(first);

  // After an Atelier write: the read it asks for is sent all the same.
  h.requestStatus(root);
  await until(() => sent.length > first);
  expect(sent.length).toBe(first + 1);
});
