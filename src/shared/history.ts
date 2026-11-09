/**
 * A Claude Code conversation of the project, read from Claude's own history (~/.claude/projects) by the main process.
 * Resumable with `claude --resume <sessionId>` in its folder.
 */
export interface ClaudeConversation {
  sessionId: string;
  /** Where the conversation ran (a real path inside the project). */
  cwd: string;
  /** One line, as Claude's /resume picker shows it: its name (custom or AI title) or summary, else the first prompt. */
  title: string;
  /** The first real prompt (one line, shortened), for the search. */
  prompt: string;
  branch: string | null;
  /** Last activity (ms). */
  at: number;
  /** Its file changed in the last minute: it may still be running outside Atelier (a hint, nothing more). */
  active?: boolean;
  /** The Claude account it belongs to; absent for the default account. */
  account?: string;
}

/** At most this many conversations are listed (the most recent), and all of them show in the palette. */
export const HISTORY_LIMIT = 200;
/** A conversation whose file changed this recently is shown as possibly running elsewhere. */
export const HISTORY_ACTIVE_MS = 60_000;

/** Claude Code session ids are UUIDs: anything else never reaches a command line. */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Claude Code's folder name for a cwd: every character other than a letter or a digit becomes a dash. */
export function encodeProjectPath(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}
