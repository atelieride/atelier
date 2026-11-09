import { expect, test } from 'vitest';
// @ts-expect-error: .mjs script without types
import { daemonReach } from '../../scripts/daemon-reach.mjs';

// Every module atelierd bundles. A byte change in any of them changes atelierd's fingerprint and asks every user to
// restart it, which closes their sessions: Windows work outside the one batched daemon release
// must leave these alone. A new entry here means an import dragged one more shared module into atelierd: check that
// it is meant to.
const SHARED = [
  'src/shared/attribution.ts',
  // The Claude Code signals notebook: atelierd notes what it doesn't recognize.
  'src/shared/claude-signals.ts',
  'src/shared/clean-path.ts',
  // Scheduled prompts: atelierd follows drafts and decides when to send.
  'src/shared/drafts.ts',
  'src/shared/env.ts',
  'src/shared/history.ts',
  'src/shared/hook-paths.ts',
  // Claude Code's usage-limit pause: atelierd arms and ends it.
  'src/shared/limit-pause.ts',
  'src/shared/paths.node.ts',
  'src/shared/paths.ts',
  'src/shared/platform.ts',
  'src/shared/protocol.ts',
  'src/shared/scheduled-prompts.ts',
  'src/shared/session-name.ts',
  'src/shared/session-view.ts',
  'src/shared/session.ts',
  'src/shared/shell-kind.ts',
  'src/shared/shell.ts',
  'src/shared/shells.ts',
  'src/shared/tool-calls.ts',
  'src/shared/version.ts',
  'src/shared/windows-pty.ts'
];

test('atelierd bundles its own modules and exactly these shared ones', () => {
  const reach = daemonReach(process.cwd()) as string[];
  expect(reach.filter((f) => !f.startsWith('src/daemon/'))).toEqual(SHARED);
  expect(reach).toContain('src/daemon/index.ts');
  expect(reach.every((f) => f.startsWith('src/daemon/') || f.startsWith('src/shared/'))).toBe(true);
});
