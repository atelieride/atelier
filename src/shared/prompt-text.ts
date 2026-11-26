// What a person typed in Claude Code's transcript (~/.claude/projects/<encoded cwd>/<id>.jsonl). Pure: main's history
// (claude-history.ts) and Ask's chat digest (companion/chat.ts) both read it. Not in src/shared/history.ts, which
// atelierd bundles (a byte change there asks every user to restart it).

type Entry = Record<string, unknown>;
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const PROMPT_MAX = 300;

/** Messages Claude Code submits itself (commands, their output, bash mode, caveats, interruptions): never a prompt. */
export const PROMPT_SKIP_PREFIXES: readonly string[] = ['<command-', '<local-command-', '<bash-input>', '<bash-stdout>', '<bash-stderr>', 'Caveat:', '[Request interrupted by user'];

const REMINDER_OPEN = '<system-reminder>', REMINDER_CLOSE = '</system-reminder>';

/**
 * `text` without the `<system-reminder>…</system-reminder>` blocks Claude Code adds to what it records, each up to the
 * first close after it; an unclosed one stays. In one pass: a lazy regex sent every unclosed tag to the end of the
 * text, quadratic on a pasted text full of them.
 */
export function withoutReminders(text: string): string {
  let out = '';
  let from = 0;
  for (;;) {
    const open = text.indexOf(REMINDER_OPEN, from);
    if (open < 0) break;
    const close = text.indexOf(REMINDER_CLOSE, open + REMINDER_OPEN.length);
    // No close after this one: none after any later one either.
    if (close < 0) break;
    out += text.slice(from, open);
    from = close + REMINDER_CLOSE.length;
  }
  return out + text.slice(from);
}

/** The text a person typed in a user entry; null for anything else (meta, agents, tool results, commands, notices). */
export function promptText(e: unknown): string | null {
  const o = e as Entry | null;
  if (!o || typeof o !== 'object' || o.type !== 'user' || o.isMeta === true || o.isSidechain === true) return null;
  const content = (o.message as Entry | undefined)?.content;
  let text: string;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    if (content.some((c) => (c as Entry | null)?.type === 'tool_result')) return null;
    text = content.filter((c) => (c as Entry | null)?.type === 'text' && typeof (c as Entry).text === 'string').map((c) => (c as Entry).text as string).join(' ');
  } else return null;
  text = withoutReminders(text).trim();
  if (PROMPT_SKIP_PREFIXES.some((p) => text.startsWith(p))) return null;
  text = oneLine(text.replace(/<\/?[a-zA-Z][\w-]*(?:\s[^<>]*)?>/g, ''));
  return text ? text.slice(0, PROMPT_MAX) : null;
}
