// Ask companion: a session's transcript read into chat entries, from where the last read stopped. A
// week-long session's file runs to tens of MB: the first read goes through it once, in 4 MiB chunks; later ones read
// only what was appended. A line still being written stays in `partial` until its newline arrives, never half-parsed.
// What chat.md can never show again is pruned as it goes (pruneChat), so the cached cursor stays bounded.
import { chatEntries, cloneChatState, pruneChat, type ChatCursor, type ChatEntry, type ChatState } from '@shared/companion/chat';
import { READ_CHUNK, readJsonLines } from '../transcript-lines';

export { READ_CHUNK };

/**
 * The transcript's chat entries: from `cursor` on (null, or a file now shorter than the cursor: from the start), pruned
 * to what renderChat (default cap) can show. `projectRoot` makes tool paths relative. Never through a symlink; a
 * missing file or a folder rejects. The cursor given is left as it was: the caller keeps the one returned.
 */
export async function readChat(file: string, cursor: ChatCursor | null, projectRoot: string): Promise<ChatCursor> {
  let state: ChatState = { prompts: 0, tools: {} };
  let entries: ChatEntry[] = [];
  let before = 0;
  const end = await readJsonLines(
    file,
    cursor,
    (v) => { for (const e of chatEntries(v, projectRoot, state)) entries.push(e); },
    // Each chunk's lines, then a prune: a first read of tens of MB never holds more than about a chunk's entries.
    () => { if (entries.length > before) entries = pruneChat(entries); before = entries.length; },
    (fromStart) => {
      state = !fromStart && cursor ? cloneChatState(cursor.state) : { prompts: 0, tools: {} };
      entries = !fromStart && cursor ? cursor.entries.slice() : [];
      before = entries.length;
    },
  );
  return { offset: end.offset, size: end.size, partial: end.partial, state, entries };
}
