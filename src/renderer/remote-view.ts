/** A Remote Control session id as Claude Code gives it (`session_…`): the only thing its link is built from. */
const REMOTE_ID = /^session_[A-Za-z0-9]{1,80}$/;

/** Where a session with Remote Control on goes on: its page on claude.ai/code. Null for anything else. */
export function remoteUrl(id: string | null | undefined): string | null {
  return id && REMOTE_ID.test(id) ? `https://claude.ai/code/${id}` : null;
}
