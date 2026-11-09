// A run's decisions: read once its session reached review, from the session's own transcript —
// its tail only, inside the account's projects root (the Background inspector's rules) — then parsed.
import { isInside, sessionTranscriptPath } from '@shared/background-files';
import { lastAssistantText, parseDecisions } from '@shared/automation-run';
import type { HubFs } from '../background-hub';

/** Claude's last message sits at the end: this much of the file is enough, and bounds the read. */
export const DECISIONS_TAIL_BYTES = 256 * 1024;

export async function readDecisions(o: { projects: string; cwd: string; sessionId: string; fs: HubFs }): Promise<string[] | null> {
  const path = sessionTranscriptPath({ tmp: '', projects: o.projects, configDir: '' }, o.cwd, o.sessionId);
  if (!path) return null;
  try {
    const [real, root] = await Promise.all([o.fs.realpath(path), o.fs.realpath(o.projects)]);
    if (!real || !root || real === root || !isInside(root, real)) return null;
    const st = await o.fs.stat(real);
    if (!st) return null;
    const start = Math.max(0, st.size - DECISIONS_TAIL_BYTES);
    const text = new TextDecoder().decode(await o.fs.read(real, start, st.size - start));
    const last = lastAssistantText(text);
    return last ? parseDecisions(last) : null;
  } catch {
    return null;
  }
}
