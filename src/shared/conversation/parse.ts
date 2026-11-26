// The phones' conversation view: a Claude Code transcript read line by line into numbered entries (the protocol's
// `Entry`): the prompts typed, Claude's replies and its tool calls, a call completed in place by its result. Claude
// Code calls the line format internal: whatever isn't recognised is skipped. Pure; the caller keeps the cursor.
//
// A rewind (the person going back to an earlier prompt) appends a prompt whose parent is a line from before prompts
// already read, or no parent at all when it went back to the first one: the parser stops there (`forked`), and the
// caller reads the file again without the turns it left (`skip`). So does Esc before any reply, which takes the prompt
// back: the next prompt is its sibling. Lines are never walked by their parents, which a transcript may lack.
import { clean, commandParts, itemText, short, taskCreated, taskUpdate, tasksOf, todoItems, withoutAgentMeta, type ChatState } from '../companion/chat';
import { oneLine } from '../companion/text';
import { withoutReminders } from '../prompt-text';
import { toolCall, toolDone, waitTargetOf, contentText } from './tools';
import { CAPS, type AskedQuestion, type Entry } from './types';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const timeOf = (v: unknown): number | null => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };

const INTERRUPTED = '[Request interrupted by user';
const INTERRUPT_LINE = /^\[Request interrupted by user( for tool use)?\]$/;
const NOTIFICATION = '<task-notification>';

type ToolEntry = Extract<Entry, { k: 'tool' }>;

/** A call waiting for its result, and the kind of entry it became. */
interface Pending { n: number; k: 'tool' | 'agent' | 'question'; tool: string; input: Obj }

/** Line ordinals: 0-based, every line pushed counts. */
export interface ParserOptions {
  projectRoot: string;
  home: string | null;
  /** Inclusive ranges of lines to read as if absent: the turns rewinds left behind. */
  skip?: readonly (readonly [number, number])[];
}

/**
 * A rewind: `at`, the line of the prompt that went back; `after`, its parent's line, which earlier prompts came after
 * (-1: no parent, back to the start).
 */
export interface Fork { after: number; at: number }

/** The text between `<tag>` and `</tag>` (the first pair), or null. */
function between(raw: string, tag: string, last = false): string | null {
  const a = raw.indexOf(`<${tag}>`);
  const b = last ? raw.lastIndexOf(`</${tag}>`) : raw.indexOf(`</${tag}>`, a);
  return a < 0 || b < a ? null : raw.slice(a + tag.length + 2, b);
}

/** The answers to a question: its structured result, else the pairs its text lists. One answer alone, several one per line. */
function answerOf(c: Obj, result: unknown): string | null {
  const pairs: [string, string][] = [];
  const answers = isObj(result) && isObj(result.answers) ? result.answers : null;
  if (answers) {
    for (const [q, a] of Object.entries(answers)) {
      const text = typeof a === 'string' ? a : Array.isArray(a) ? a.filter((x) => typeof x === 'string').join(', ') : '';
      if (text.trim()) pairs.push([q, text]);
    }
  } else {
    const text = contentText(c.content);
    if (/answered/i.test(text)) for (const m of text.matchAll(/"([^"]*)"="([^"]*)"/g)) if (m[2]!.trim()) pairs.push([m[1]!, m[2]!]);
  }
  if (pairs.length === 0) return null;
  const text = pairs.length === 1 ? pairs[0]![1] : pairs.map(([q, a]) => `${oneLine(q)} → ${a}`).join('\n');
  return clean(text, CAPS.answer) || null;
}

/** The questions of an AskUserQuestion call, each text one line, redacted and within its cap. */
function questionsOf(v: unknown): AskedQuestion[] {
  if (!Array.isArray(v)) return [];
  const out: AskedQuestion[] = [];
  for (const q of v) {
    const text = isObj(q) ? str(q.question) : null;
    if (!isObj(q) || !text) continue;
    const header = str(q.header);
    const options = (Array.isArray(q.options) ? q.options : []).filter(isObj).flatMap((o) => {
      const label = str(o.label);
      const description = str(o.description);
      return label ? [{ label: short(label, CAPS.label), ...(description ? { description: short(description, CAPS.description) } : {}) }] : [];
    }).slice(0, CAPS.options);
    out.push({ ...(header ? { header: short(header, CAPS.header) } : {}), question: short(text, CAPS.question), ...(q.multiSelect === true ? { several: true as const } : {}), options });
    if (out.length === CAPS.questions) break;
  }
  return out;
}

export class ConversationParser {
  private readonly list: Entry[] = [];
  private readonly changed = new Set<number>();
  private readonly pending = new Map<string, Pending>();
  /** Background calls that were launched: tool_use id → entry, until their notification says how they ended. */
  private readonly background = new Map<string, number>();
  /** TaskCreate calls waiting for the id their result gives. */
  private readonly creating = new Set<string>();
  /** The task list TaskCreate and TaskUpdate keep, in the shape the Ask companion's helpers update. */
  private readonly chat: ChatState = { prompts: 0, tools: {} };
  /**
   * The next line's ordinal; the line being read, its parent's uuid (null: none, as a conversation's first line;
   * undefined: no parent field), and whether it is a user line or a queued prompt (not a local command's).
   */
  private count = 0;
  private line = -1;
  private parent: string | null | undefined;
  private typedLine = false;
  /** The line of each uuid read, and of the last prompt. */
  private readonly lines = new Map<string, number>();
  private lastPrompt = -1;
  private fork: Fork | null = null;

  constructor(private readonly o: ParserOptions) {}

  /** Every entry so far; `entries[i].n === i + 1`. */
  get entries(): readonly Entry[] { return this.list; }

  /** Set at a rewind's prompt, which adds nothing, nor does any line after it: the file is to be read again. */
  get forked(): Fork | null { return this.fork; }

  /** The `n` of the entries added or changed since the last call, ascending. */
  takeChanged(): number[] {
    const out = [...this.changed].sort((a, b) => a - b);
    this.changed.clear();
    return out;
  }

  /**
   * The calls still waiting for a result, with the target atelierd shows while the session waits on them, and a
   * command's whole text when that target cuts it short.
   */
  running(): { n: number; k: 'tool' | 'agent' | 'question'; tool: string; waitTarget: string; command?: string }[] {
    return [...this.pending.values()].map((p) => {
      const waitTarget = waitTargetOf(p.tool, p.input);
      const command = str(p.input.command);
      const cut = command !== null && !str(p.input.file_path) && !str(p.input.notebook_path) && waitTarget.endsWith('…');
      return { n: p.n, k: p.k, tool: p.tool, waitTarget, ...(cut ? { command } : {}) };
    });
  }

  push(line: unknown): void {
    const i = this.count++;
    if (this.fork || this.o.skip?.some(([a, b]) => i >= a && i <= b)) return;
    if (!isObj(line) || line.isSidechain === true) return;
    this.line = i;
    this.parent = line.parentUuid === null ? null : str(line.parentUuid) ?? undefined;
    this.typedLine = line.type === 'user' || line.type === 'attachment';
    this.read(line);
    const uuid = str(line.uuid);
    if (uuid) this.lines.set(uuid, i);
  }

  private read(line: Obj): void {
    const at = timeOf(line.timestamp);
    switch (line.type) {
      case 'assistant': return this.assistant(line, at);
      case 'user': return this.user(line, at);
      case 'system':
        if (line.subtype === 'compact_boundary') this.add({ k: 'compact', at });
        else if (line.subtype === 'local_command' && typeof line.content === 'string') this.command(line.content, at);
        return;
      case 'attachment': {
        // A prompt typed while Claude worked has no user line: it shows when Claude takes it (this attachment), never
        // when it was queued. A background task's notice can arrive the same way.
        const a = isObj(line.attachment) ? line.attachment : null;
        if (a?.type !== 'queued_command' || typeof a.prompt !== 'string') return;
        const text = a.prompt.trimStart();
        if (text.startsWith(NOTIFICATION) || (a.commandMode === 'prompt' && !text.startsWith('<'))) this.typed(text, at);
      }
    }
  }

  private add(entry: DistributiveOmit<Entry, 'n'>): number {
    const n = this.list.length + 1;
    this.list.push({ ...entry, n } as Entry);
    this.changed.add(n);
    return n;
  }

  private assistant(line: Obj, at: number | null): void {
    const msg = isObj(line.message) ? line.message : null;
    const content = msg && Array.isArray(msg.content) ? msg.content : msg && typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : [];
    for (const c of content) {
      if (!isObj(c)) continue;
      if (c.type === 'text') {
        const t = str(c.text);
        if (!t || t.trim() === '(no content)') continue;
        const text = clean(t, CAPS.reply);
        if (text) this.add({ k: 'reply', at, text });
      } else if (c.type === 'tool_use') this.toolUse(c, at);
    }
  }

  private toolUse(c: Obj, at: number | null): void {
    // Only plain name characters reach the phone (an MCP tool is `mcp__server__tool`).
    const tool = (str(c.name) ?? '').replace(/[^\w.:-]/g, '').slice(0, 80) || 'Tool';
    const input = isObj(c.input) ? c.input : {};
    const id = str(c.id);
    switch (tool) {
      case 'Agent': case 'Task': {
        const description = short(str(input.description) ?? str(input.subagent_type) ?? 'Agent', CAPS.target);
        const n = this.add({ k: 'agent', at, description, status: 'running' });
        if (id) this.pending.set(id, { n, k: 'agent', tool, input });
        return;
      }
      case 'AskUserQuestion': {
        const questions = questionsOf(input.questions);
        if (questions.length === 0) return;
        const n = this.add({ k: 'question', at, questions, status: 'running' });
        if (id) this.pending.set(id, { n, k: 'question', tool, input });
        return;
      }
      case 'TodoWrite': {
        const items = todoItems(input.todos);
        if (items) this.todos(items, at);
        return;
      }
      case 'TaskCreate':
        if (id) {
          this.creating.add(id);
          tasksOf(this.chat).pending[id] = itemText(str(input.subject) ?? str(input.description) ?? 'Task');
        }
        return;
      case 'TaskUpdate': {
        const e = taskUpdate(input, at, this.chat)[0];
        if (e?.k === 'todos') this.todos(e.items, at);
        return;
      }
      case 'TaskList': case 'TaskGet': return;
    }
    const n = this.add({ k: 'tool', at, status: 'running', ...toolCall(tool, input, { root: this.o.projectRoot, home: this.o.home }) });
    if (id) this.pending.set(id, { n, k: 'tool', tool, input });
  }

  /** A task list: right after another one (nothing in between) it replaces it, under the same `n`. */
  private todos(items: { text: string; status: string }[], at: number | null): void {
    const last = this.list.at(-1);
    if (last?.k !== 'todos') { this.add({ k: 'todos', at, items }); return; }
    this.list[last.n - 1] = { ...last, at, items };
    this.changed.add(last.n);
  }

  private user(line: Obj, at: number | null): void {
    const msg = isObj(line.message) ? line.message : null;
    if (!msg) return;
    const content = msg.content;
    if (Array.isArray(content) && content.some((c) => isObj(c) && c.type === 'tool_result')) {
      for (const c of content) if (isObj(c) && c.type === 'tool_result') this.toolResult(c, line);
      return;
    }
    if (line.isMeta === true || line.isCompactSummary === true) return;
    this.typed(typeof content === 'string' ? content : contentText(content), at);
  }

  /** What a user line's text is: a prompt, a slash command, bash mode; or nothing (Claude Code's own messages). */
  private typed(text: string, at: number | null): void {
    const raw = withoutReminders(text).trim();
    if (!raw) return;
    if (raw.startsWith(INTERRUPTED)) return INTERRUPT_LINE.test(raw) ? this.interrupt() : undefined;
    if (raw.startsWith(NOTIFICATION)) return this.notification(raw);
    if (raw.startsWith('<command-')) return this.command(raw, at);
    const bash = /^<bash-input>([\s\S]*?)<\/bash-input>$/.exec(raw);
    if (bash) return this.prompt(`! ${bash[1]!.trim()}`, at);
    if (raw.startsWith('<')) return;
    this.prompt(raw, at);
  }

  /** A slash command: "/model", or with its arguments "/review PR 42". */
  private command(raw: string, at: number | null): void {
    const c = commandParts(raw);
    if (c) this.prompt(c.args ? `${c.name} ${c.args}` : c.name, at);
  }

  private prompt(raw: string, at: number | null): void {
    const text = clean(raw, CAPS.prompt);
    if (!text) return;
    // Its parent read before the last prompt, or a typed prompt with none after one (back to the start): the person
    // went back. A prompt's parent is otherwise the line before it.
    const after = this.parent === null ? (this.typedLine ? -1 : undefined) : this.parent === undefined ? undefined : this.lines.get(this.parent);
    if (after !== undefined && after < this.lastPrompt) { this.fork = { after, at: this.line }; return; }
    // A local command's lines (system) may sit off the branch the next prompt links to: never a prompt read before it.
    if (this.typedLine) this.lastPrompt = this.line;
    this.add({ k: 'prompt', at, text });
  }

  /**
   * Esc stopped Claude: calls still waiting for a result will never get one (they end as interrupted), and the newest
   * entry is where it stopped. Background calls already launched keep running.
   */
  private interrupt(): void {
    for (const p of this.pending.values()) {
      const e = this.list[p.n - 1]!;
      if (e.k === 'tool' || e.k === 'agent' || e.k === 'question') {
        this.list[p.n - 1] = { ...e, status: 'error', ...(e.k === 'tool' ? { summary: 'Interrupted' } : {}) } as Entry;
        this.changed.add(p.n);
      }
    }
    this.pending.clear();
    this.creating.clear();
    const last = this.list.at(-1);
    if (last && !last.interrupted) {
      this.list[last.n - 1] = { ...last, interrupted: true };
      this.changed.add(last.n);
    }
  }

  /** A background task reported back: an agent's status and report, or a shell's exit code. */
  private notification(raw: string): void {
    const id = between(raw, 'tool-use-id')?.trim();
    const n = id ? this.background.get(id) : undefined;
    if (!id || n === undefined) return;
    this.background.delete(id);
    const e = this.list[n - 1]!;
    const status = between(raw, 'status')?.trim();
    if (e.k === 'agent') {
      const report = clean(between(raw, 'result', true) ?? '', CAPS.report);
      this.list[n - 1] = { ...e, status: status === 'completed' ? 'ok' : 'error', ...(report ? { report } : {}) };
    } else if (e.k === 'tool') {
      // The last one: the command's own description may contain such a phrase.
      const code = [...(between(raw, 'summary') ?? '').matchAll(/\(exit code (\d+)\)/g)].at(-1)?.[1];
      const done = code === undefined ? status === 'completed' : Number(code) === 0;
      const summary = done ? 'Done' : code !== undefined ? `Exit ${Number(code)}` : status === 'killed' ? 'Stopped' : 'Failed';
      this.list[n - 1] = { ...e, status: done ? 'ok' : 'error', summary };
    } else return;
    this.changed.add(n);
  }

  private toolResult(c: Obj, line: Obj): void {
    const id = str(c.tool_use_id);
    if (!id) return;
    if (this.creating.delete(id)) {
      const e = taskCreated(id, c, isObj(line.toolUseResult) ? line.toolUseResult : null, null, this.chat)[0];
      if (e?.k === 'todos') this.todos(e.items, timeOf(line.timestamp));
      return;
    }
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    const prev = this.list[p.n - 1]!;
    const result = line.toolUseResult;
    const failed = c.is_error === true;
    if (prev.k === 'agent') {
      const r = isObj(result) ? result : {};
      if (!failed && (r.isAsync === true || r.status === 'async_launched' || contentText(c.content).startsWith('Async agent launched'))) {
        this.background.set(id, p.n); // its report comes in a notification
        return;
      }
      const d = failed ? toolDone(p.tool, p.input, c.content, result, true, line) : null;
      const report = failed ? (d?.feedback ?? d?.detail) : clean(withoutAgentMeta(contentText(c.content)).trim(), CAPS.report);
      this.list[p.n - 1] = { ...prev, status: failed ? 'error' : 'ok', ...(report ? { report } : {}) };
    } else if (prev.k === 'question') {
      this.list[p.n - 1] = { ...prev, status: failed ? 'error' : 'ok' };
      this.changed.add(p.n);
      const text = failed ? null : answerOf(c, result);
      if (text) this.add({ k: 'answer', at: timeOf(line.timestamp), text });
      return;
    } else if (prev.k === 'tool') {
      // The call's own diff or plan stays unless the result brings a detail of its own.
      this.list[p.n - 1] = { ...prev, ...toolDone(p.tool, p.input, c.content, result, failed, line) };
      if (p.tool === 'Bash' && isObj(result) && typeof result.backgroundTaskId === 'string') this.background.set(id, p.n);
    }
    this.changed.add(p.n);
  }
}

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
