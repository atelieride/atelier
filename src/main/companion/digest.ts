// Ask companion: a session's transcript read into chat entries, from where the last read stopped. A
// week-long session's file runs to tens of MB: the first read goes through it once, in 4 MiB chunks; later ones read
// only what was appended. A line still being written stays in `partial` until its newline arrives, never half-parsed.
// What chat.md can never show again is pruned as it goes (pruneChat), so the cached cursor stays bounded.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { chatEntries, cloneChatState, pruneChat, type ChatCursor, type ChatEntry } from '@shared/companion/chat';

export const READ_CHUNK = 4 * 1024 * 1024;

/** How many bytes of `b` end on a whole UTF-8 character (a character cut by the writer is read again next time). */
function wholeChars(b: Buffer): number {
  for (let i = b.length - 1; i >= 0 && i >= b.length - 4; i--) {
    const c = b[i]!;
    if ((c & 0xc0) === 0x80) continue;
    const need = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 1;
    return b.length - i >= need ? b.length : i;
  }
  return b.length;
}

/**
 * The transcript's chat entries: from `cursor` on (null, or a file now shorter than the cursor: from the start), pruned
 * to what renderChat (default cap) can show. `projectRoot` makes tool paths relative. Never through a symlink; a
 * missing file or a folder rejects. The cursor given is left as it was: the caller keeps the one returned.
 */
export async function readChat(file: string, cursor: ChatCursor | null, projectRoot: string): Promise<ChatCursor> {
  const fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error('not a regular file');
    const from = cursor && st.size >= cursor.offset ? cursor : null;
    const state = from ? cloneChatState(from.state) : { prompts: 0, tools: {} };
    let entries: ChatEntry[] = from ? from.entries.slice() : [];
    let pos = from ? from.offset : 0;
    const parts: Buffer[] = from?.partial ? [Buffer.from(from.partial, 'utf8')] : [];
    // Each chunk's lines, then a prune: a first read of tens of MB never holds more than about a chunk's entries.
    const take = (text: string) => {
      const before = entries.length;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let v: unknown;
        try { v = JSON.parse(line); } catch { continue; }
        for (const e of chatEntries(v, projectRoot, state)) entries.push(e);
      }
      if (entries.length > before) entries = pruneChat(entries);
    };
    if (pos < st.size) {
      const buf = Buffer.allocUnsafe(Math.min(READ_CHUNK, st.size - pos));
      while (pos < st.size) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, st.size - pos), pos);
        if (bytesRead === 0) break;
        pos += bytesRead;
        const data = buf.subarray(0, bytesRead);
        const nl = data.lastIndexOf(10);
        // A line longer than a chunk (an inline screenshot) builds up until its newline.
        if (nl < 0) { parts.push(Buffer.from(data)); continue; }
        parts.push(data.subarray(0, nl));
        take(Buffer.concat(parts).toString('utf8'));
        parts.length = 0;
        parts.push(Buffer.from(data.subarray(nl + 1)));
      }
    }
    const rest = Buffer.concat(parts);
    const whole = wholeChars(rest);
    return { offset: pos - (rest.length - whole), size: st.size, partial: rest.subarray(0, whole).toString('utf8'), state, entries };
  } finally {
    await fh.close();
  }
}
