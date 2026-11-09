// Ask companion: the session's conversation as `chat.md`, built line by line from its Claude Code
// transcript (main's companion/digest.ts reads the file and keeps the cursor). Every prompt typed (slash commands with
// arguments too), the user's answers to Claude's questions, Claude's replies, one line per tool call, the subagents'
// final reports, the questions asked, the task list, the compactions. Tool outputs are left out. Claude Code calls the
// line format internal: anything not recognised is skipped. Pure.
import { isInside, splitPath } from '../paths';
import { promptText } from '../prompt-text';
import { redactSecrets } from '../session';
import { cutEnd, cutFront, hhmm, isHighSurrogate, isLowSurrogate, middleCut, oneLine, tidy, ymd } from './text';

export type ChatEntry =
  | { k: 'prompt'; n: number; at: number | null; text: string }
  | { k: 'answer'; at: number | null; text: string }
  | { k: 'reply'; at: number | null; text: string }
  | { k: 'tool'; at: number | null; line: string }
  | { k: 'agent'; at: number | null; text: string }
  | { k: 'question'; at: number | null; text: string }
  | { k: 'todos'; at: number | null; items: { text: string; status: string }[] }
  | { k: 'compact'; at: number | null };

export interface ChatState {
  /** Prompts numbered so far. */
  prompts: number;
  /** tool_use id → name, for the calls whose result is read (Agent, Task, AskUserQuestion, TaskCreate), until it comes. */
  tools: Record<string, string>;
  /** The task list TaskCreate/TaskUpdate keep (task id → item), and the subjects of creations waiting for their id. */
  tasks?: { items: Record<string, { text: string; status: string }>; pending: Record<string, string> };
}

/** A copy chatEntries can update without touching `s` (a cached cursor stays valid if a read fails). */
export const cloneChatState = (s: ChatState): ChatState => ({
  prompts: s.prompts,
  tools: { ...s.tools },
  ...(s.tasks ? { tasks: { items: { ...s.tasks.items }, pending: { ...s.tasks.pending } } } : {})
});

/** Where a read of the transcript stopped: the next one starts at `offset` with `partial`, an unfinished last line. */
export interface ChatCursor { offset: number; size: number; partial: string; state: ChatState; entries: ChatEntry[] }

/** A subagent's report is kept to this many characters, its head and its tail. */
export const AGENT_MAX = 4096;
/** chat.md stays under this many bytes (every prompt is kept, so a session of huge prompts alone may pass it). */
export const CHAT_CAP = 300 * 1024;
const PROMPT_MAX = 16 * 1024;
const REPLY_MAX = 8 * 1024;
const QUESTION_MAX = 2048;
const ANSWER_MAX = 500;
const TARGET_MAX = 160;
const TODO_TEXT_MAX = 200;
const TODOS_MAX = 100;
/** Text longer than twice this (a pasted log) is narrowed to its head and tail before it is redacted and cut. */
const WIDE = 64 * 1024;
/** Prompts over the cap are cut, never below this many characters. */
const PROMPT_FLOOR = 256;
const NOTIFICATION = '<task-notification>';
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const COMMAND_NAME = /^\/[\w:.-]{1,100}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const timeOf = (v: unknown): number | null => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };
const firstLine = (s: string) => s.split('\n').find((l) => l.trim()) ?? '';

/**
 * Text kept in an entry: tidied (an invisible character never hides a key from redaction), token-like runs redacted
 * (before any cut, which could leave a piece of a key too short to be recognised), then cut to `max` around its middle.
 */
function clean(text: string, max: number): string {
  if (text.length <= 2 * WIDE) return middleCut(redactSecrets(tidy(text)), max);
  return middleCut(redactSecrets(tidy(`${text.slice(0, WIDE)}\n${text.slice(-WIDE)}`)), max, text.length - 2 * WIDE);
}
/** A short one-line value (a command, a pattern, a label, an answer): redacted, then cut at its end. */
const short = (s: string, max: number) => cutEnd(redactSecrets(oneLine(s.slice(0, 4096))), max);

/** `p` inside the project relative to it, `/`-separated (Windows' C:\… too: Ask cites forward slashes everywhere). */
function relPath(p: string, root: string): string {
  const r = root.replace(/[\\/]+$/, '');
  if (!r || !isInside(r, p)) return p;
  return p.length === r.length ? '.' : splitPath(p.slice(r.length + 1)).join('/');
}

/** "Edit src/auth/session.ts", "Bash npm test -- auth", "Grep refreshToken in src", "Agent Review the fix". */
function toolLine(name: string, input: Obj, root: string): string {
  const label = name.replace(/[^\w.:-]/g, '').slice(0, 80) || 'Tool';
  const file = str(input.file_path) ?? str(input.notebook_path);
  let target = '';
  if (file) target = cutFront(oneLine(relPath(file, root)), TARGET_MAX);
  else {
    const pattern = str(input.pattern);
    const where = str(input.path);
    if (pattern) target = short(where ? `${pattern} in ${relPath(where, root)}` : pattern, TARGET_MAX);
    else {
      for (const k of ['command', 'description', 'url', 'query', 'skill', 'prompt']) {
        const v = str(input[k]);
        if (v) { target = short(firstLine(v), TARGET_MAX); break; }
      }
    }
  }
  return target ? `${label} ${target}` : label;
}

const statusOf = (v: unknown) => (typeof v === 'string' && /^[A-Za-z_-]{1,24}$/.test(v) ? v : 'unknown');
const itemText = (s: string) => short(s, TODO_TEXT_MAX);

function todoItems(v: unknown): { text: string; status: string }[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter(isObj).flatMap((t) => { const text = str(t.content); return text ? [{ text: itemText(text), status: statusOf(t.status) }] : []; }).slice(0, TODOS_MAX);
}

function questionText(v: unknown): string | null {
  if (!Array.isArray(v)) return null;
  const qs = v.filter(isObj).flatMap((q) => {
    const text = str(q.question);
    if (!text) return [];
    const labels = (Array.isArray(q.options) ? q.options : []).filter(isObj).map((o) => str(o.label)).filter((l): l is string => l !== null).map(oneLine);
    return [labels.length > 0 ? `${oneLine(text)} (${labels.join(' / ')})` : oneLine(text)];
  });
  return qs.length > 0 ? clean(qs.join('\n'), QUESTION_MAX) : null;
}

const taskIdOf = (v: unknown): string | null => { const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : ''; return /^[\w-]{1,32}$/.test(s) ? s : null; };
const tasksOf = (st: ChatState) => (st.tasks ??= { items: {}, pending: {} });
const taskList = (st: ChatState) => Object.entries(tasksOf(st).items)
  .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })).slice(0, TODOS_MAX).map(([, item]) => item);

function taskUpdate(input: Obj, at: number | null, st: ChatState): ChatEntry[] {
  const id = taskIdOf(input.taskId);
  if (!id) return [];
  const t = tasksOf(st);
  const status = str(input.status);
  if (status === 'deleted') delete t.items[id];
  else {
    const cur = t.items[id] ?? { text: `Task #${id}`, status: 'pending' };
    const subject = str(input.subject);
    t.items[id] = { text: subject ? itemText(subject) : cur.text, status: status ? statusOf(status) : cur.status };
  }
  return [{ k: 'todos', at, items: taskList(st) }];
}

function toolUse(c: Obj, at: number | null, root: string, st: ChatState): ChatEntry[] {
  const name = typeof c.name === 'string' && c.name ? c.name : 'Tool';
  const id = str(c.id);
  const input = isObj(c.input) ? c.input : {};
  switch (name) {
    case 'TodoWrite': { const items = todoItems(input.todos); return items ? [{ k: 'todos', at, items }] : []; }
    case 'AskUserQuestion': {
      if (id) st.tools[id] = name;
      const text = questionText(input.questions);
      if (text) return [{ k: 'question', at, text }];
      break;
    }
    case 'ExitPlanMode': { const plan = str(input.plan); if (plan) return [{ k: 'reply', at, text: clean(`Plan:\n${plan}`, REPLY_MAX) }]; break; }
    case 'TaskCreate': {
      if (id) { st.tools[id] = name; tasksOf(st).pending[id] = itemText(str(input.subject) ?? str(input.description) ?? 'Task'); }
      return [];
    }
    case 'TaskUpdate': return taskUpdate(input, at, st);
    case 'TaskList': case 'TaskGet': return [];
  }
  if (id && AGENT_TOOLS.has(name)) st.tools[id] = name;
  return [{ k: 'tool', at, line: toolLine(name, input, root) }];
}

function assistant(msg: Obj, at: number | null, root: string, st: ChatState): ChatEntry[] {
  const content = Array.isArray(msg.content) ? msg.content : typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : [];
  const out: ChatEntry[] = [];
  for (const c of content) {
    if (!isObj(c)) continue;
    if (c.type === 'tool_use') out.push(...toolUse(c, at, root, st));
    else if (c.type === 'text') {
      const t = str(c.text);
      if (!t || t.trim() === '(no content)') continue;
      const text = clean(t, REPLY_MAX);
      if (text) out.push({ k: 'reply', at, text });
    }
  }
  return out;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => isObj(c) && c.type === 'text' && typeof c.text === 'string').map((c) => (c as Obj).text as string).join('\n');
}

/** A foreground Agent's result ends with its id and usage for Claude ("agentId: …", "<usage>…</usage>"): not report. */
function withoutAgentMeta(s: string): string {
  const i = s.lastIndexOf('agentId: ');
  if (i < 0 || (i > 0 && s[i - 1] !== '\n')) return s;
  return /^agentId: [\w-]+[^\n]*(?:\n<usage>[^]*<\/usage>)?\s*$/.test(s.slice(i)) ? s.slice(0, i) : s;
}

/**
 * The answers chosen or typed for an AskUserQuestion: its structured result (question → answer), else the pairs its
 * text lists ("User has answered your questions: "Q"="A". …"). One answer alone, several as "Q → A / Q → A".
 */
function answerText(c: Obj, result: Obj | null): string | null {
  if (c.is_error === true) return null;
  const pairs: [string, string][] = [];
  const answers = result && isObj(result.answers) ? result.answers : null;
  if (answers) {
    for (const [q, a] of Object.entries(answers)) {
      const text = typeof a === 'string' ? a : Array.isArray(a) ? a.filter((x) => typeof x === 'string').join(', ') : '';
      if (text.trim()) pairs.push([q, text]);
    }
  } else {
    const text = resultText(c.content);
    const from = text.indexOf('User has answered your question');
    if (from < 0) return null;
    for (const m of text.slice(from).matchAll(/"([^"]*)"="([^"]*)"/g)) if (m[2]!.trim()) pairs.push([m[1]!, m[2]!]);
  }
  if (pairs.length === 0) return null;
  return short(pairs.length === 1 ? pairs[0]![1] : pairs.map(([q, a]) => `${q} → ${a}`).join(' / '), ANSWER_MAX);
}

function taskCreated(useId: string, c: Obj, result: Obj | null, at: number | null, st: ChatState): ChatEntry[] {
  const t = tasksOf(st);
  const subject = t.pending[useId];
  delete t.pending[useId];
  const task = result && isObj(result.task) ? result.task : null;
  const id = taskIdOf(task?.id) ?? taskIdOf(/Task #([\w-]{1,32}) created/.exec(resultText(c.content))?.[1]);
  if (!id || c.is_error === true) return [];
  t.items[id] = { text: subject ?? itemText(str(task?.subject) ?? `Task #${id}`), status: 'pending' };
  return [{ k: 'todos', at, items: taskList(st) }];
}

function toolResult(c: Obj, line: Obj, at: number | null, st: ChatState): ChatEntry[] {
  const id = str(c.tool_use_id);
  const name = id ? st.tools[id] : undefined;
  if (!id || !name) return [];
  delete st.tools[id];
  const result = isObj(line.toolUseResult) ? line.toolUseResult : null;
  if (name === 'TaskCreate') return taskCreated(id, c, result, at, st);
  if (name === 'AskUserQuestion') { const text = answerText(c, result); return text ? [{ k: 'answer', at, text }] : []; }
  // A background Agent's launch: its report comes later, in a task notification.
  if (result && (result.isAsync === true || result.status === 'async_launched')) return [];
  const raw = withoutAgentMeta(resultText(c.content)).trim();
  if (!raw || raw.startsWith('Async agent launched')) return [];
  const text = clean(raw, AGENT_MAX);
  return text ? [{ k: 'agent', at, text }] : [];
}

/** A background task reported back: a subagent's report is its `<result>`; a shell's notice has none. */
function notification(raw: string, at: number | null): ChatEntry[] {
  const a = raw.indexOf('<result>');
  const b = raw.lastIndexOf('</result>');
  if (a < 0 || b < a) return [];
  const text = clean(raw.slice(a + '<result>'.length, b), AGENT_MAX);
  return text ? [{ k: 'agent', at, text }] : [];
}

/** A slash command typed with arguments is a prompt ("/review PR 42"); one without (/clear, /model) is not. */
function command(raw: string, at: number | null, st: ChatState): ChatEntry[] {
  const name = /<command-name>([^<]*)<\/command-name>/.exec(raw)?.[1]?.trim() ?? '';
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(raw)?.[1]?.trim() ?? '';
  const slash = name.startsWith('/') ? name : `/${name}`;
  if (!args || !COMMAND_NAME.test(slash)) return [];
  const text = clean(`${slash} ${args}`, PROMPT_MAX);
  return text ? [{ k: 'prompt', n: ++st.prompts, at, text }] : [];
}

function user(line: Obj, msg: Obj, at: number | null, st: ChatState): ChatEntry[] {
  const content = msg.content;
  if (Array.isArray(content) && content.some((c) => isObj(c) && c.type === 'tool_result')) {
    return content.flatMap((c) => (isObj(c) && c.type === 'tool_result' ? toolResult(c, line, at, st) : []));
  }
  const raw = (typeof content === 'string' ? content : resultText(content)).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (raw.startsWith(NOTIFICATION)) return notification(raw, at);
  // Claude Code's own messages (meta, the compaction summary, command output, scheduled prompts) are not prompts.
  if (line.isCompactSummary === true || line.isMeta === true) return [];
  if (raw.startsWith('<command-')) return command(raw, at, st);
  if (raw.startsWith('<') || promptText(line) === null) return [];
  const text = clean(raw, PROMPT_MAX);
  return text ? [{ k: 'prompt', n: ++st.prompts, at, text }] : [];
}

/** The entries one transcript line adds (none for most). `st` carries what spans lines and is updated in place. */
export function chatEntries(line: unknown, projectRoot: string, st: ChatState): ChatEntry[] {
  if (!isObj(line) || line.isSidechain === true) return [];
  const at = timeOf(line.timestamp);
  if (line.type === 'system') return line.subtype === 'compact_boundary' ? [{ k: 'compact', at }] : [];
  const msg = isObj(line.message) ? line.message : null;
  if (!msg) return [];
  if (line.type === 'assistant') return assistant(msg, at, projectRoot, st);
  if (line.type === 'user') return user(line, msg, at, st);
  return [];
}

// --- chat.md -----------------------------------------------------------------------------------------------------

const HEADER = "Session chat, oldest first. YOU = the user's prompts and slash commands (numbered), YOU ANSWERED = the user's answer to a question, CLAUDE = the session's replies, TOOL = one tool call (its output left out), AGENT RESULT = a subagent's final report, ASKED YOU = a question the session asked the user, TODOS = its latest task list. Times are local (HH:MM).";
const LEFT_OUT = '[… earlier entries left out to fit; every prompt is kept]';
const clock = (at: number | null) => (at === null ? '--:--' : hhmm(at));
const dayLine = (day: string) => `--- ${day} ---`;
const flat = (s: string) => redactSecrets(oneLine(s));

/** UTF-8 length without encoding. */
function utf8(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (isHighSurrogate(c) && isLowSurrogate(s.charCodeAt(i + 1))) { n += 4; i++; } else n += 3;
  }
  return n;
}

/** The first line after the head; the next ones indented, so no text line ever starts like an entry. */
function lines(head: string, text: string): string {
  const [first = '', ...rest] = redactSecrets(tidy(text)).split('\n');
  return [head + first, ...rest.map((l) => (l ? `  ${l}` : ''))].join('\n');
}

function block(e: ChatEntry, text?: string): string {
  const t = clock(e.at);
  switch (e.k) {
    case 'prompt': return lines(`[#${e.n} ${t}] YOU: `, text ?? e.text);
    case 'answer': return `[${t}] YOU ANSWERED: ${flat(e.text)}`;
    case 'reply': return lines(`[${t}] CLAUDE: `, e.text);
    case 'tool': return `[${t}] TOOL ${flat(e.line)}`;
    case 'agent': return lines(`[${t}] AGENT RESULT: `, e.text);
    case 'question': return lines(`[${t}] ASKED YOU: `, e.text);
    case 'todos': return [`[${t}] TODOS:${e.items.length === 0 ? ' (empty)' : ''}`, ...e.items.map((i) => `  [${flat(i.status)}] ${flat(i.text)}`)].join('\n');
    case 'compact': return `[${t}] --- context compacted ---`;
  }
}

/** The user's own words and the task list: always kept (prompts may lose their middle). */
const isOwn = (e: ChatEntry) => e.k === 'prompt' || e.k === 'answer' || e.k === 'todos';

/** Which entries can ever show: of the task lists only the latest, and never a compaction right after another. */
function showable(entries: readonly ChatEntry[]): boolean[] {
  let lastTodos = -1;
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i]!.k === 'todos') { lastTodos = i; break; }
  const out = new Array<boolean>(entries.length).fill(false);
  let prevCompact = false;
  entries.forEach((e, i) => {
    if (e.k === 'todos' && i !== lastTodos) return;
    if (e.k === 'compact' && prevCompact) return;
    prevCompact = e.k === 'compact';
    out[i] = true;
  });
  return out;
}

/**
 * The newest showable entries other than the user's own, as many as fit in `cap` bytes together — more than chat.md
 * can ever hold of them — with their rendered text, and `beyond`, the next older one (-1: none), which tells that
 * older ones were left out. renderChat and pruneChat both start from it, so pruning never changes chat.md.
 */
function recentWindow(entries: readonly ChatEntry[], show: boolean[], cap: number): { texts: Map<number, string>; beyond: number } {
  const texts = new Map<number, string>();
  let used = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (!show[i] || isOwn(e)) continue;
    const text = block(e);
    used += utf8(text) + 1;
    if (used > cap) return { texts, beyond: i };
    texts.set(i, text);
  }
  return { texts, beyond: -1 };
}

/**
 * The entries renderChat(entries, cap) can still show, plus the one that tells older ones were left out: every prompt
 * and answer, the latest task list, about one cap of the newest others. renderChat gives the same chat.md on them, and
 * pruning again (or after appending) changes nothing more: a long session's cursor stays bounded.
 */
export function pruneChat(entries: readonly ChatEntry[], cap: number = CHAT_CAP): ChatEntry[] {
  const show = showable(entries);
  const { texts, beyond } = recentWindow(entries, show, cap);
  return entries.filter((e, i) => show[i] && (isOwn(e) || texts.has(i) || i === beyond));
}

interface Block { e: ChatEntry; text: string; size: number; own: boolean; dropped: boolean }

/**
 * Prompts over their room: each prompt longer than a common length L loses its middle down to L characters, with L as
 * large as still makes room (never below PROMPT_FLOOR: past that the cap gives way, every prompt is kept).
 */
function shrinkPrompts(prompts: Block[], excess: number): void {
  const cutTo = (b: Block, len: number) => block(b.e, middleCut((b.e as { text: string }).text, len));
  const lengths = prompts.map((b) => (b.e as { text: string }).text.length);
  const gain = (len: number) => prompts.reduce((g, b, i) => g + (lengths[i]! > len ? b.size - (utf8(cutTo(b, len)) + 1) : 0), 0);
  const longest = lengths.reduce((m, l) => Math.max(m, l), 0);
  if (longest <= PROMPT_FLOOR) return;
  let lo = PROMPT_FLOOR;
  if (gain(lo) >= excess) {
    let hi = longest - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (gain(mid) >= excess) lo = mid; else hi = mid - 1;
    }
  }
  prompts.forEach((b, i) => { if (lengths[i]! > lo) { b.text = cutTo(b, lo); b.size = utf8(b.text) + 1; } });
}

/**
 * chat.md from the entries, oldest first, under `cap` bytes: the latest task list only, a day line where the date
 * changes, consecutive compactions once. Over the cap, the user's own words (prompts, answers) and the task list stay,
 * taking at most two thirds when the rest needs room (the longest prompts lose their middle first); the newest replies,
 * tool lines and results fill the rest, the oldest going first. Everything goes through redactSecrets.
 */
export function renderChat(entries: readonly ChatEntry[], cap: number = CHAT_CAP): string {
  const show = showable(entries);
  const { texts, beyond } = recentWindow(entries, show, cap);
  const blocks: Block[] = [];
  entries.forEach((e, i) => {
    if (!show[i]) return;
    const own = isOwn(e);
    const text = own ? block(e) : texts.get(i);
    if (text !== undefined) blocks.push({ e, text, size: utf8(text) + 1, own, dropped: false });
  });
  // Day lines: dropping blocks never adds one, so those of every block bound what is printed.
  let days = 0;
  let day = '';
  for (const b of blocks) if (b.e.at !== null && ymd(b.e.at) !== day) { day = ymd(b.e.at); days += utf8(dayLine(day)) + 1; }
  let budget = cap - (utf8(HEADER) + 1) - days;
  const sum = (own: boolean) => blocks.reduce((s, b) => s + (b.own === own && !b.dropped ? b.size : 0), 0);
  let mine = sum(true);
  let recent = sum(false);
  let cut = beyond >= 0;
  if (cut || mine + recent > budget) {
    budget = Math.max(0, budget - (utf8(LEFT_OUT) + 1));
    // The newest activity always gets a third; the user's own words get the rest, or less when they don't need it.
    const third = budget - Math.floor((budget * 2) / 3);
    const room = Math.min(mine, Math.max(budget - third, budget - recent));
    if (mine > room) { shrinkPrompts(blocks.filter((b) => b.e.k === 'prompt'), mine - room); mine = sum(true); }
    const recentRoom = Math.max(budget - mine, third);
    for (const b of blocks) {
      if (recent <= recentRoom) break;
      if (b.own) continue;
      b.dropped = true; recent -= b.size; cut = true;
    }
  }
  const out = [HEADER];
  if (cut) out.push(LEFT_OUT);
  day = '';
  for (const b of blocks) {
    if (b.dropped) continue;
    if (b.e.at !== null && ymd(b.e.at) !== day) { day = ymd(b.e.at); out.push(dayLine(day)); }
    out.push(b.text);
  }
  return out.join('\n') + '\n';
}
