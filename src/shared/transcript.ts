/**
 * A subagent's transcript (JSONL) as a timeline. Claude Code calls the line format
 * internal: only `assistant` and `user` lines are read, everything else is skipped, and a file that is mostly
 * unparsable is reported as unrecognized instead of showing an empty timeline. Pure.
 */
import { redactSecrets } from './session';
import { isInside } from './paths';
export interface ToolEntry { kind: 'tool'; id: string; at: number | null; tool: string; target: string; result?: 'ok' | 'error'; summary?: string; taskId?: string }
export interface TextEntry { kind: 'text'; at: number | null; text: string }
export type TimelineEntry = ToolEntry | TextEntry;
export interface TimelineMeta { task?: string; model?: string; tokens: number; tools: number; files: number; lastAt?: number }

export const TIMELINE_SHOWN = 500;
const TARGET_MAX = 160;
const TEXT_MAX = 300;
const SUMMARY_MAX = 120;
/** The task is kept whole (newlines included); this only bounds a pathological prompt. */
const TASK_MAX = 20000;
const MIN_LINES_TO_JUDGE = 20;
const REDACT_MAX = 4096;
/** Entries (and message ids) kept while following: what is shown, and as much again for results that come late. */
const KEEP = TIMELINE_SHOWN * 2;
const BG_ID = /with ID: ([A-Za-z0-9_-]{1,128})/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const clip = (s: string, n: number) => { const one = s.replace(/\s+/g, ' ').trim(); return one.length > n ? `${one.slice(0, n - 1)}…` : one; };
/** The task's text as written (trimmed, newlines kept), cut at `n` characters with a trailing "…". */
const clipKeep = (s: string, n: number) => { const t = s.trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const firstLine = (s: string) => s.split('\n').find((l) => l.trim()) ?? '';

function relative(p: string, cwd?: string): string {
  if (cwd && isInside(cwd, p)) return p.slice(cwd.length + 1) || '.';
  return p;
}

/** Token-like runs (keys, tokens) become "…", over the whole text before it is cut (as the inspector's commands). */
const redact = (s: string) => redactSecrets(s.slice(0, REDACT_MAX));

/**
 * What a tool call is about, in a few words: a file, a pattern, a command, a URL, a description. Everything but a
 * file path is redacted: a command or a URL can carry a token, a prompt a key.
 */
function targetOf(input: Obj, cwd?: string): string {
  const file = str(input.file_path) ?? str(input.notebook_path);
  if (file) return clip(relative(file, cwd), TARGET_MAX);
  const pattern = str(input.pattern);
  if (pattern) { const where = str(input.path); return clip(redact(where ? `${pattern} in ${relative(where, cwd)}` : pattern), TARGET_MAX); }
  for (const k of ['command', 'url', 'description', 'prompt', 'query'] as const) { const v = str(input[k]); if (v) return clip(redact(firstLine(v)), TARGET_MAX); }
  return '';
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (isObj(c) && typeof c.text === 'string' ? c.text : '')).join('\n');
  return '';
}

export class TranscriptReader {
  entries: TimelineEntry[] = [];
  meta: TimelineMeta = { tokens: 0, tools: 0, files: 0 };
  private decoder = new TextDecoder('utf-8');
  private partial = '';
  private lines = 0;
  private bad = 0;
  /** Assistant and user lines seen: the ones the timeline is made of. */
  private known = 0;
  private tools = new Map<string, ToolEntry>();
  private files = new Set<string>();
  private seenMessages = new Set<string>();
  private background = new Set<string>();
  private midFile = false;

  /** Reads what arrived; returns how many lines it completed (0: only a partial line, nothing new to show). */
  push(bytes: Uint8Array, cwd?: string): number {
    const parts = (this.partial + this.decoder.decode(bytes, { stream: true })).split('\n');
    this.partial = parts.pop() ?? '';
    let n = 0;
    for (const raw of parts) if (raw.trim()) { this.line(raw, cwd); n++; }
    this.trim();
    return n;
  }

  /** The hub started reading past offset 0: the first user line seen is not the task. */
  startsMidFile(): void { this.midFile = true; }

  /**
   * From 20 lines on: more than half unparsable, or all of them JSON yet none an assistant or user line (the format
   * changed under the same file name).
   */
  unrecognized(): boolean {
    if (this.lines < MIN_LINES_TO_JUDGE) return false;
    return this.bad * 2 > this.lines || (this.lines - this.bad >= MIN_LINES_TO_JUDGE && this.known === 0);
  }
  shown(): TimelineEntry[] { return this.entries.slice(-TIMELINE_SHOWN); }

  reset(): void {
    this.entries = []; this.meta = { tokens: 0, tools: 0, files: 0 };
    this.decoder = new TextDecoder('utf-8'); this.partial = ''; this.lines = 0; this.bad = 0; this.known = 0;
    this.tools.clear(); this.files.clear(); this.seenMessages.clear(); this.background.clear(); this.midFile = false;
  }

  /**
   * A transcript followed for hours stays bounded: the oldest entries beyond KEEP go (with their pending results), and
   * so do the oldest message ids (a message's lines are consecutive). The counters in `meta` stay cumulative; the set
   * of files read is kept whole, since it is what "Files read" counts.
   */
  private trim(): void {
    if (this.entries.length > KEEP) {
      const gone = this.entries.splice(0, this.entries.length - KEEP);
      for (const e of gone) if (e.kind === 'tool') { this.tools.delete(e.id); this.background.delete(e.id); }
    }
    if (this.seenMessages.size > KEEP) {
      let extra = this.seenMessages.size - KEEP;
      for (const id of this.seenMessages) { if (extra-- <= 0) break; this.seenMessages.delete(id); }
    }
  }

  private line(raw: string, cwd?: string): void {
    this.lines++;
    let o: unknown;
    try { o = JSON.parse(raw); } catch { this.bad++; return; }
    if (!isObj(o)) { this.bad++; return; }
    const at = typeof o.timestamp === 'string' && !Number.isNaN(Date.parse(o.timestamp)) ? Date.parse(o.timestamp) : null;
    const msg = isObj(o.message) ? o.message : null;
    if (o.type === 'assistant' && msg) this.assistant(msg, at, cwd);
    else if (o.type === 'user' && msg) this.user(msg, o, at);
    else return;
    this.known++;
    if (at !== null) this.meta.lastAt = at;
  }

  private assistant(msg: Obj, at: number | null, cwd?: string): void {
    const model = str(msg.model);
    if (model) this.meta.model = model;
    // One line per content block repeats the same message id and usage: count each message once.
    const mid = str(msg.id);
    const fresh = !mid || !this.seenMessages.has(mid);
    if (mid) this.seenMessages.add(mid);
    if (fresh && isObj(msg.usage)) this.meta.tokens += num(msg.usage.input_tokens) + num(msg.usage.output_tokens) + num(msg.usage.cache_creation_input_tokens);
    const content = Array.isArray(msg.content) ? msg.content : typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : [];
    for (const c of content) {
      if (!isObj(c)) continue;
      if (c.type === 'tool_use') {
        const tool = str(c.name) ?? 'Tool';
        const input = isObj(c.input) ? c.input : {};
        const entry: ToolEntry = { kind: 'tool', id: str(c.id) ?? `anon-${this.meta.tools}`, at, tool, target: targetOf(input, cwd) };
        this.entries.push(entry);
        this.tools.set(entry.id, entry);
        this.meta.tools++;
        if (tool === 'Bash' && input.run_in_background === true) this.background.add(entry.id);
        if (tool === 'Read') { const f = str(input.file_path); if (f) { this.files.add(f); this.meta.files = this.files.size; } }
      } else if (c.type === 'text') {
        const text = str(c.text);
        if (text) this.entries.push({ kind: 'text', at, text: clip(text, TEXT_MAX) });
      }
    }
  }

  private user(msg: Obj, o: Obj, at: number | null): void {
    if (typeof msg.content === 'string') { if (!this.meta.task && !this.midFile) this.meta.task = clipKeep(msg.content, TASK_MAX); return; }
    if (!Array.isArray(msg.content)) return;
    for (const c of msg.content) {
      if (!isObj(c)) continue;
      if (c.type === 'text' && !this.meta.task && !this.midFile) { const text = str(c.text); if (text) this.meta.task = clipKeep(text, TASK_MAX); continue; }
      if (c.type !== 'tool_result') continue;
      const entry = this.tools.get(str(c.tool_use_id) ?? '');
      if (!entry) continue;
      const text = resultText(c.content);
      entry.result = c.is_error === true ? 'error' : 'ok';
      const bgTask = entry.tool === 'Bash' && this.background.has(entry.id);
      const structured = isObj(o.toolUseResult) ? str(o.toolUseResult.backgroundTaskId) : null;
      const bg = bgTask ? structured ?? (isObj(o.toolUseResult) && 'backgroundTaskId' in o.toolUseResult ? null : BG_ID.exec(text)?.[1] ?? null) : null;
      if (bg) entry.taskId = bg;
      const count = text ? text.replace(/\n$/, '').split('\n').length : 0;
      entry.summary = entry.result === 'error' ? clip(firstLine(text), SUMMARY_MAX) : bgTask ? 'background' : `${count} lines`;
      if (at !== null && entry.at === null) entry.at = at;
    }
  }
}
