/**
 * Where Claude Code keeps what a session's background work writes: a task's output in
 * its temp root, a subagent's transcript in its projects folder. Pure: main resolves real paths and checks them.
 */
import { SESSION_ID, encodeProjectPath } from './history';
import { isAbsPath, isCleanAbsPath, isInside as pathInside, trimTrailingSep } from './paths';

/** A background task's or subagent's id as Claude Code makes them ("by72ms8dl", "a93775ef2f6dc2f6c"). */
export const ITEM_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * `tmp`: Claude Code's temp root (`<tmp>/claude-<uid>`); `projects`: the default config dir's projects root
 * (`$CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects`, a fixture in tests); `configDir`: that default config dir, so a
 * session reporting it reads `projects`, and only another account's reads `<its dir>/projects`.
 */
export interface ClaudeRoots { tmp: string; projects: string; configDir: string }

const joinPath = (...parts: string[]) => parts.join('/').replace(/\/{2,}/g, '/');
const valid = (cwd: string, sessionId: string, id: string) => isAbsPath(cwd) && SESSION_ID.test(sessionId) && ITEM_ID.test(id);

/** `<tmp>/<encoded cwd>/<sessionId>/tasks/<id>.output` (observed), or null for bad input. */
export function outputPath(roots: ClaudeRoots, cwd: string, sessionId: string, itemId: string): string | null {
  return valid(cwd, sessionId, itemId) ? joinPath(roots.tmp, encodeProjectPath(cwd), sessionId, 'tasks', `${itemId}.output`) : null;
}

/** `<projects>/<encoded cwd>/<sessionId>/subagents/agent-<id>.jsonl` (documented), or null for bad input. */
export function transcriptPath(roots: ClaudeRoots, cwd: string, sessionId: string, agentId: string): string | null {
  return valid(cwd, sessionId, agentId) ? joinPath(roots.projects, encodeProjectPath(cwd), sessionId, 'subagents', `agent-${agentId}.jsonl`) : null;
}

/** `<projects>/<encoded cwd>/<sessionId>.jsonl`: the session's own transcript (its loop's wake-ups), or null for bad input. */
export function sessionTranscriptPath(roots: ClaudeRoots, cwd: string, sessionId: string): string | null {
  return isAbsPath(cwd) && SESSION_ID.test(sessionId) ? joinPath(roots.projects, encodeProjectPath(cwd), `${sessionId}.jsonl`) : null;
}

/**
 * `<configDir>/projects` for a session that runs with another Claude config dir (`CLAUDE_CONFIG_DIR`), or null when
 * there is none or it is not a clean absolute path: the dir comes from hook data, so the caller falls back to its root.
 */
export function projectsRootOf(configDir: unknown): string | null {
  return isCleanAbsPath(configDir) ? `${configDir}/projects` : null;
}

/** `path` is `root` or below it (both already real paths; trailing separators on `root` ignored). */
export function isInside(root: string, path: string): boolean {
  return pathInside(trimTrailingSep(root), path);
}
