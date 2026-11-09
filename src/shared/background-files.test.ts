import { describe, expect, test } from 'vitest';
import { ITEM_ID, isInside, outputPath, projectsRootOf, sessionTranscriptPath, transcriptPath } from './background-files';
import { encodeProjectPath } from './history';

const SID = '89fcf8ea-a6ad-4f29-a390-922953c50a6c';
const roots = { tmp: '/private/tmp/claude-501', projects: '/Users/x/.claude/projects', configDir: '/Users/x/.claude' };

describe('background files', () => {
  test('encodes a cwd as Claude Code does', () => {
    expect(encodeProjectPath('/Users/x/repos/my.app')).toBe('-Users-x-repos-my-app');
  });
  test('a task output path', () => {
    expect(outputPath(roots, '/Users/x/repos/atelier', SID, 'by72ms8dl'))
      .toBe(`/private/tmp/claude-501/-Users-x-repos-atelier/${SID}/tasks/by72ms8dl.output`);
  });
  test('a subagent transcript path (documented layout)', () => {
    expect(transcriptPath(roots, '/Users/x/repos/atelier', SID, 'a93775ef2f6dc2f6c'))
      .toBe(`/Users/x/.claude/projects/-Users-x-repos-atelier/${SID}/subagents/agent-a93775ef2f6dc2f6c.jsonl`);
  });
  test("a session's own transcript path (a self-paced loop's wake-ups)", () => {
    expect(sessionTranscriptPath(roots, '/Users/x/repos/atelier', SID)).toBe(`/Users/x/.claude/projects/-Users-x-repos-atelier/${SID}.jsonl`);
    expect(sessionTranscriptPath(roots, '/p', 'fake-123')).toBeNull();
    expect(sessionTranscriptPath(roots, 'relative/dir', SID)).toBeNull();
  });
  test('hostile ids, session ids and cwds give no path', () => {
    for (const id of ['', '../x', 'a/b', 'a b', 'x'.repeat(129), 'é']) expect(outputPath(roots, '/p', SID, id), id).toBeNull();
    expect(outputPath(roots, '/p', 'fake-123', 'b1')).toBeNull();
    expect(outputPath(roots, 'relative/dir', SID, 'b1')).toBeNull();
    expect(transcriptPath(roots, '/p', SID, '..')).toBeNull();
    expect(ITEM_ID.test('a1xxxx')).toBe(true);
  });
  test("another config dir's projects root, and nothing for a dir that is not a clean absolute path", () => {
    expect(projectsRootOf('/Users/x/.claude_ops')).toBe('/Users/x/.claude_ops/projects');
    // C1 controls too: a dir is typed into the terminal, where U+009B would be a CSI.
    for (const d of [undefined, null, 42, '', 'rel/dir', '/a/../b', '/a/./b', '/a//b', '/a/', '/a\nb', '/a\u009bb', '/a\u0085b', `/${'x'.repeat(4096)}`]) expect(projectsRootOf(d), String(d)).toBeNull();
  });
  test('isInside: the root itself and below, never a sibling with the same prefix', () => {
    expect(isInside('/private/tmp/claude-501', '/private/tmp/claude-501/a/b')).toBe(true);
    expect(isInside('/private/tmp/claude-501/', '/private/tmp/claude-501')).toBe(true);
    expect(isInside('/private/tmp/claude-501', '/private/tmp/claude-5010/a')).toBe(false);
    expect(isInside('/private/tmp/claude-501', '/private/tmp')).toBe(false);
  });
});
