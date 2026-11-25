// The phones' conversation view: a Claude Code transcript read line by line into numbered entries (the protocol's
// `Entry`): the prompts typed, Claude's replies and its tool calls, a call completed in place by its result. Claude
// Code calls the line format internal: whatever isn't recognised is skipped. Pure; the caller keeps the cursor.
import { clean } from '../companion/chat';
import { toolCall, toolDone, waitTargetOf, contentText } from './tools';
import { CAPS, type Entry } from './types';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const timeOf = (v: unknown): number | null => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };

/** Tools whose calls become another kind of entry (agents, questions, task lists): the next step reads them. */
const OTHER_KINDS = new Set(['Agent', 'Task', 'AskUserQuestion', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);
const COMMAND_NAME = /^\/[\w:.-]{1,100}$/;
const INTERRUPTED = '[Request interrupted by user';

type ToolEntry = Extract<Entry, { k: 'tool' }>;

/** A call waiting for its result. */
interface Pending { n: number; tool: string; input: Obj }

export class ConversationParser {
  private readonly list: Entry[] = [];
  private readonly changed = new Set<number>();
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly o: { projectRoot: string; home: string | null }) {}

  /** Every entry so far; `entries[i].n === i + 1`. */
  get entries(): readonly Entry[] { return this.list; }

  /** The `n` of the entries added or changed since the last call, ascending. */
  takeChanged(): number[] {
    const out = [...this.changed].sort((a, b) => a - b);
    this.changed.clear();
    return out;
  }

  /** The calls still waiting for a result, with the target atelierd shows while the session waits on them. */
  running(): { n: number; k: 'tool' | 'agent' | 'question'; tool: string; waitTarget: string }[] {
    return [...this.pending.values()].map((p) => ({ n: p.n, k: 'tool' as const, tool: p.tool, waitTarget: waitTargetOf(p.tool, p.input) }));
  }

  push(line: unknown): void {
    if (!isObj(line) || line.isSidechain === true) return;
    const at = timeOf(line.timestamp);
    switch (line.type) {
      case 'assistant': return this.assistant(line, at);
      case 'user': return this.user(line, at);
      case 'system': return line.subtype === 'local_command' && typeof line.content === 'string' ? this.command(line.content, at) : undefined;
      case 'attachment': {
        const a = isObj(line.attachment) ? line.attachment : null;
        if (a?.type === 'queued_command' && typeof a.prompt === 'string') this.typed(a.prompt, at);
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
    const tool = str(c.name) ?? 'Tool';
    if (OTHER_KINDS.has(tool)) return;
    const input = isObj(c.input) ? c.input : {};
    const id = str(c.id);
    const n = this.add({ k: 'tool', at, status: 'running', ...toolCall(tool, input, { root: this.o.projectRoot, home: this.o.home }) });
    if (id) this.pending.set(id, { n, tool, input });
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
    const raw = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
    if (!raw || raw.startsWith(INTERRUPTED) || raw.startsWith('Caveat:')) return;
    if (raw.startsWith('<command-name>')) return this.command(raw, at);
    const bash = /^<bash-input>([\s\S]*?)<\/bash-input>$/.exec(raw);
    if (bash) return this.prompt(`! ${bash[1]!.trim()}`, at);
    if (raw.startsWith('<')) return;
    this.prompt(raw, at);
  }

  /** A slash command: "/model", or with its arguments "/review PR 42". */
  private command(raw: string, at: number | null): void {
    const name = /<command-name>([^<]*)<\/command-name>/.exec(raw)?.[1]?.trim() ?? '';
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(raw)?.[1]?.trim() ?? '';
    const slash = name.startsWith('/') ? name : `/${name}`;
    if (COMMAND_NAME.test(slash)) this.prompt(args ? `${slash} ${args}` : slash, at);
  }

  private prompt(raw: string, at: number | null): void {
    const text = clean(raw, CAPS.prompt);
    if (text) this.add({ k: 'prompt', at, text });
  }

  private toolResult(c: Obj, line: Obj): void {
    const id = str(c.tool_use_id);
    const p = id ? this.pending.get(id) : undefined;
    if (!id || !p) return;
    this.pending.delete(id);
    const prev = this.list[p.n - 1] as ToolEntry;
    // The call's own diff or plan stays unless the result brings a detail of its own.
    const done = toolDone(p.tool, p.input, c.content, line.toolUseResult, c.is_error === true, line);
    this.list[p.n - 1] = { ...prev, ...done };
    this.changed.add(p.n);
  }
}

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
