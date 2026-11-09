import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { describe, expect, test } from 'vitest';
import { encodeProjectPath } from '@shared/history';
import { useMachinePlatform } from '../../../tests/support/platform';
import { realHubFs } from '../background-fs';
import { toOut } from '../cpath';
import { readDecisions, DECISIONS_TAIL_BYTES } from './decisions';

// A run's decisions from its session's own transcript (its tail, bounded), inside the account's
// projects root only.

// Real files: the machine's platform (Windows: canonical C:/ paths, as main has them).
useMachinePlatform();

const SID = '0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0';
const line = (text: string) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

function world(body: string) {
  const base = toOut(realpathSync(mkdtempSync(join(tmpdir(), 'atl-decisions-'))));
  const projects = posix.join(base, 'projects');
  const cwd = posix.join(base, 'acme', '.claude', 'worktrees', 'auto-cu-1');
  mkdirSync(posix.join(projects, encodeProjectPath(cwd)), { recursive: true });
  writeFileSync(posix.join(projects, encodeProjectPath(cwd), `${SID}.jsonl`), body);
  return { projects, cwd };
}

describe('readDecisions', () => {
  test('the list under "Decisions I made" in Claude\'s last message', async () => {
    const w = world([line('Looking.'), line('Done.\n\nDecisions I made\n- Round half-even.\n- Kept the PDF rounding.')].join('\n'));
    expect(await readDecisions({ projects: w.projects, cwd: w.cwd, sessionId: SID, fs: realHubFs })).toEqual(['Round half-even.', 'Kept the PDF rounding.']);
  });

  test('only the tail is read: a long transcript costs at most the tail', async () => {
    const filler = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(4096) } });
    const w = world([...Array.from({ length: 200 }, () => filler), line('Decisions I made\n- Last one.')].join('\n'));
    expect(DECISIONS_TAIL_BYTES).toBeLessThanOrEqual(512 * 1024);
    expect(await readDecisions({ projects: w.projects, cwd: w.cwd, sessionId: SID, fs: realHubFs })).toEqual(['Last one.']);
  });

  test('no section, no file, a bad id or a path outside the root: null', async () => {
    const w = world(line('All done.'));
    expect(await readDecisions({ projects: w.projects, cwd: w.cwd, sessionId: SID, fs: realHubFs })).toBeNull();
    expect(await readDecisions({ projects: w.projects, cwd: join(w.cwd, 'nope'), sessionId: SID, fs: realHubFs })).toBeNull();
    expect(await readDecisions({ projects: w.projects, cwd: w.cwd, sessionId: '../x', fs: realHubFs })).toBeNull();
  });
});
