// Output triggers: rules matched against the new output lines of terminals, in the renderer. Pure logic
// here (validation, ANSI stripping, line splitting, matching, throttling); the worker and xterm glue live in
// src/renderer/terminal/.
import { pathStyle } from './platform';

export type TriggerAction = 'notify' | 'highlight';
export type TriggerScope = 'all' | 'sessions' | 'terminals';
/** What a terminal is, for a rule's scope: a Claude session or a plain terminal. */
export type TerminalKind = 'session' | 'terminal';

export interface TriggerRule { id: string; pattern: string; action: TriggerAction; scope: TriggerScope; enabled: boolean }

export const MAX_TRIGGERS = 50;
/** Pattern length cap (text or /regex/flags): with the line cap, bounds the work of one match. */
export const MAX_PATTERN = 200;
/** Lines are matched up to this many characters: a longer one is cut into pieces. */
export const MAX_LINE = 2048;
export const TRIGGER_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const TRIGGER_ACTIONS: readonly TriggerAction[] = ['notify', 'highlight'];
export const TRIGGER_SCOPES: readonly TriggerScope[] = ['all', 'sessions', 'terminals'];
/** At most one notification per rule per terminal in this window. */
export const NOTIFY_EVERY_MS = 30_000;

/** First run: two examples, off, to show what a rule looks like. */
export const DEFAULT_TRIGGERS: TriggerRule[] = [
  { id: 'example-tests-failed', pattern: 'tests failed', action: 'notify', scope: 'all', enabled: false },
  { id: 'example-error', pattern: 'ERROR', action: 'highlight', scope: 'all', enabled: false }
];

export type PatternCheck = { ok: true; re: RegExp } | { ok: false; error: string };

const REGEX_FORM = /^\/(.+)\/([imsu]*)$/s;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * A quantifier at `i`: its length (0: none), whether it repeats (more than once), has no upper bound (* + {n,}) and
 * may match nothing (? * {0,…}).
 */
function quantifier(src: string, i: number): { len: number; repeats: boolean; unbounded: boolean; optional: boolean } {
  const c = src[i];
  let len = 0; let repeats = false; let unbounded = false; let optional = false;
  if (c === '*' || c === '+') { len = 1; repeats = true; unbounded = true; optional = c === '*'; }
  else if (c === '?') { len = 1; optional = true; }
  else if (c === '{') {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i));
    if (!m) return { len: 0, repeats: false, unbounded: false, optional: false };
    len = m[0].length;
    const min = Number(m[1]);
    unbounded = m[2] !== undefined && m[3] === '';
    repeats = m[2] === undefined ? min > 1 : unbounded || Number(m[3]) > 1;
    optional = min === 0;
  }
  if (len && src[i + len] === '?') len++;
  return { len, repeats, unbounded, optional };
}

/** A group being scanned: does it contain a quantifier, an alternation whose branches can overlap, its branches. */
interface Frame { quant: boolean; alt: boolean; firsts: (string | null)[]; first: string | null | undefined; atoms: number }
const frame = (): Frame => ({ quant: false, alt: false, firsts: [], first: undefined, atoms: 0 });
/** At most this many open-ended repeats of broad atoms (. \w \s \d, classes): .*.*.*x is polynomial but huge. */
const MAX_BROAD_REPEATS = 2;

/**
 * The shapes that make a backtracking engine explode: a repeated group that itself contains a quantifier ("star
 * height" above one, like (a+)+, (\w+\s?)* or (a?){30}), an alternation whose branches can match the same text under
 * an open-ended repeat ((a|aa)+, (\w|\d)+ — conservatively, unless every branch starts with a different literal
 * character), three or more open-ended repeats of broad atoms (.*.*.*x), and backreferences. A scan of the source.
 */
function unsafe(src: string): string | null {
  const stack: Frame[] = [frame()];
  let broadRepeats = 0;
  let lastBroad = false;
  const top = () => stack[stack.length - 1]!;
  // An atom starts here: the branch's first one decides its first character (null: not a single known literal).
  const atom = (first: string | null, broad: boolean) => {
    const f = top();
    if (f.atoms === 0) f.first = first;
    f.atoms++;
    lastBroad = broad;
  };
  const endBranch = (f: Frame) => { f.firsts.push(f.atoms === 0 ? null : f.first ?? null); f.first = undefined; f.atoms = 0; };
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\\') {
      const n = src[i + 1] ?? '';
      if (/[1-9]/.test(n) || (n === 'k' && src[i + 2] === '<')) return 'Backreferences are not allowed.';
      const broad = /[dDwWsSpP]/.test(n);
      atom(/[A-Za-z0-9]/.test(n) ? null : n, broad);
      i += 2;
      continue;
    }
    if (c === '[') {
      i++;
      while (i < src.length && src[i] !== ']') i += src[i] === '\\' ? 2 : 1;
      i++;
      atom(null, true);
      continue;
    }
    if (c === '(') {
      atom(null, false);
      stack.push(frame());
      i++;
      if (src[i] === '?') {
        // (?: (?= (?! (?<= (?<! (?<name>: the ? is not a quantifier.
        const m = /^\?(?::|=|!|<=|<!|<[A-Za-z_$][\w$]*>)/.exec(src.slice(i));
        i += m ? m[0].length : 1;
      }
      continue;
    }
    if (c === '|') { endBranch(top()); i++; continue; }
    if (c === ')') {
      const g = stack.length > 1 ? stack.pop()! : frame();
      endBranch(g);
      const firsts = g.firsts;
      const overlap = firsts.length > 1 && (firsts.some((x) => x === null) || new Set(firsts.map((x) => x!.toLowerCase())).size < firsts.length);
      const q = quantifier(src, i + 1);
      if (g.quant && q.repeats) return 'Nested repetition like (a+)+ can freeze the terminal.';
      if ((g.alt || overlap) && q.unbounded) return 'Alternatives that can match the same text under + or * can freeze the terminal.';
      const parent = top();
      if (g.quant || q.len) parent.quant = true;
      if (g.alt || overlap) parent.alt = true;
      if (q.optional && parent.atoms === 1) parent.first = null;
      lastBroad = false;
      i += 1 + q.len;
      continue;
    }
    const q = quantifier(src, i);
    if (q.len) {
      const f = top();
      f.quant = true;
      // An optional first atom: the branch may start with what follows it.
      if (q.optional && f.atoms === 1) f.first = null;
      if (q.unbounded && lastBroad && ++broadRepeats > MAX_BROAD_REPEATS) return 'Three or more open-ended repeats like .* can freeze the terminal.';
      lastBroad = false;
      i += q.len;
      continue;
    }
    atom(c === '.' || c === '^' || c === '$' ? null : c, c === '.');
    i++;
  }
  return null;
}

/**
 * A pattern from the user: plain text (matched literally, case-sensitive) or /regex/flags (flags i, m, s, u). Refused:
 * empty, longer than MAX_PATTERN, control characters, invalid, catastrophic shapes, or matching the empty string.
 */
export function checkPattern(pattern: string): PatternCheck {
  if (pattern.trim() === '') return { ok: false, error: 'Type some text or a /regex/.' };
  if (pattern.length > MAX_PATTERN) return { ok: false, error: `Up to ${MAX_PATTERN} characters.` };
  if (CONTROL.test(pattern)) return { ok: false, error: 'No control characters.' };
  const m = REGEX_FORM.exec(pattern);
  if (!m) return { ok: true, re: new RegExp(escapeRe(pattern)) };
  const why = unsafe(m[1]!);
  if (why) return { ok: false, error: why };
  let re: RegExp;
  try { re = new RegExp(m[1]!, m[2]); } catch (err) {
    const msg = (err as Error).message.replace(/^Invalid regular expression:\s*/i, '');
    return { ok: false, error: `Invalid regular expression: ${msg}`.slice(0, 160) };
  }
  if (re.test('')) return { ok: false, error: 'This pattern matches every line.' };
  return { ok: true, re };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** One rule from the settings file, or null. */
export function parseTrigger(v: unknown): TriggerRule | null {
  if (!isObj(v)) return null;
  const { id, pattern, action, scope, enabled } = v;
  if (typeof id !== 'string' || !TRIGGER_ID.test(id) || typeof pattern !== 'string' || !checkPattern(pattern).ok) return null;
  if (!TRIGGER_ACTIONS.includes(action as TriggerAction) || !TRIGGER_SCOPES.includes(scope as TriggerScope) || typeof enabled !== 'boolean') return null;
  return { id, pattern, action: action as TriggerAction, scope: scope as TriggerScope, enabled };
}

/** The rules of the settings file: invalid ones dropped, each id once, capped; undefined when it isn't a list. */
export function normalizeTriggers(raw: unknown): TriggerRule[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const out: TriggerRule[] = [];
  for (const v of raw) {
    const r = parseTrigger(v);
    if (!r || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
    if (out.length === MAX_TRIGGERS) break;
  }
  return out;
}

export const scopeAllows = (scope: TriggerScope, kind: TerminalKind): boolean =>
  scope === 'all' || (scope === 'sessions' ? kind === 'session' : kind === 'terminal');

// ANSI stripping as a state machine, so a sequence cut between two chunks of output is still recognized.
type St = 'ground' | 'esc' | 'escInter' | 'csi' | 'str' | 'strEsc';
const MAX_SEQ = 4096;

// DEC private modes that switch to the alternate screen (full-screen programs: Claude Code, vim, less…).
const ALT_MODES = new Set(['47', '1047', '1049']);

/** ConPTY's cursor-forward of n columns stands for n spaces: at most this many per sequence. */
const MAX_FORWARD = 200;

class AnsiStripper {
  /**
   * Windows: ConPTY re-renders program output, spaces as cursor-forward (CSI n C) and new
   * lines as cursor positions (CSI r;c H / f). Read as a space each and a line end; elsewhere dropped, as before.
   */
  private readonly conpty = pathStyle() === 'win32';
  private st: St = 'ground';
  private seq = 0;
  private params = '';
  /** Whether the alternate screen is active, as the stream so far says (CSI ? 1049/1047/47 h/l). */
  alt = false;
  reset(): void { this.st = 'ground'; this.seq = 0; this.params = ''; }
  private csiEnd(final: string, out: (ch: string) => void): void {
    if ((final === 'h' || final === 'l') && this.params.startsWith('?') && this.params.slice(1).split(';').some((p) => ALT_MODES.has(p))) {
      this.alt = final === 'h';
    }
    if (!this.conpty || this.params.startsWith('?')) return;
    if (final === 'C') { for (let n = Math.min(Number.parseInt(this.params, 10) || 1, MAX_FORWARD); n > 0; n--) out(' '); }
    else if (final === 'H' || final === 'f') out('\n');
  }
  /** The printable characters of `s` and \n \r \t, in order, to `out`. */
  push(s: string, out: (ch: string) => void): void {
    for (const ch of s) {
      const c = ch.codePointAt(0)!;
      switch (this.st) {
        case 'ground':
          if (c === 0x1b) this.st = 'esc';
          else if (c === 0x9b) { this.st = 'csi'; this.seq = 0; this.params = ''; }
          else if (c === 0x9d || c === 0x90) { this.st = 'str'; this.seq = 0; }
          else if (c === 0x0a || c === 0x0d || c === 0x09) out(ch);
          else if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) { /* control: dropped */ }
          else out(ch);
          break;
        case 'esc':
          if (ch === '[') { this.st = 'csi'; this.seq = 0; this.params = ''; }
          else if (ch === ']' || ch === 'P' || ch === 'X' || ch === '^' || ch === '_') { this.st = 'str'; this.seq = 0; }
          else if (c >= 0x20 && c <= 0x2f) this.st = 'escInter';
          else this.st = 'ground';
          break;
        case 'escInter':
          if (!(c >= 0x20 && c <= 0x2f)) this.st = 'ground';
          break;
        case 'csi':
          if (c >= 0x40 && c <= 0x7e) { this.st = 'ground'; this.csiEnd(ch, out); }
          else if (++this.seq > 64) this.st = 'ground';
          else this.params += ch;
          break;
        case 'str':
          if (c === 0x07 || c === 0x9c || ++this.seq > MAX_SEQ) this.st = 'ground';
          else if (c === 0x1b) this.st = 'strEsc';
          break;
        case 'strEsc':
          // ESC \ ends the string; any other ESC sequence ends it too and starts anew.
          if (ch === '\\') this.st = 'ground';
          else { this.st = 'esc'; this.push(ch, out); }
          break;
      }
    }
  }
}

/** Escape sequences and control characters (but tabs, newlines, carriage returns) removed. */
export function stripAnsi(s: string): string {
  let out = '';
  new AnsiStripper().push(s, (ch) => { out += ch; });
  return out;
}

/**
 * The complete lines of a terminal's output stream, ANSI stripped: \n or \r\n ends a line, a lone \r starts it over
 * (progress bars), a line reaching MAX_LINE characters is cut there. A partial line waits for the next chunk.
 */
export class LineSplitter {
  private ansi = new AnsiStripper();
  private line = '';
  private cr = false;
  /** Some of the pending line was written on the alternate screen. */
  private lineAlt = false;

  /** `alt`: the alternate screen is already active when the stream starts here. */
  constructor(alt = false) { this.ansi.alt = alt; }

  feed(chunk: string): string[] {
    return this.feedTagged(chunk).map((l) => l.text);
  }

  /** As feed, each line tagged with whether (some of) it was written on the alternate screen. */
  feedTagged(chunk: string): { text: string; alt: boolean }[] {
    const out: { text: string; alt: boolean }[] = [];
    const end = () => { out.push({ text: this.line, alt: this.lineAlt || this.ansi.alt }); this.line = ''; this.lineAlt = false; };
    this.ansi.push(chunk, (ch) => {
      if (ch === '\n') { end(); this.cr = false; return; }
      if (this.cr) { this.line = ''; this.lineAlt = false; this.cr = false; }
      if (ch === '\r') { this.cr = true; return; }
      this.line += ch;
      if (this.ansi.alt) this.lineAlt = true;
      if (this.line.length >= MAX_LINE) end();
    });
    return out;
  }

  /**
   * The screen was replaced (attach snapshot): what was pending is not part of the new output. The snapshot itself is
   * only read for the screen it leaves active (a full-screen program's snapshot switches to the alternate screen).
   */
  reset(snapshot = ''): void {
    this.ansi.reset(); this.ansi.alt = false; this.line = ''; this.cr = false; this.lineAlt = false;
    if (snapshot) { this.ansi.push(snapshot, () => { /* text ignored */ }); this.ansi.reset(); }
  }
}

/** Notify entries are not repeated for the same (terminal, rule, line) within this window (TUI redraws). */
export const SAME_LINE_MS = 10 * 60_000;
const MAX_SEEN_LINES = 500;

/** A line as compared for repeats: whitespace collapsed, trimmed. */
export const normalizeLine = (line: string): string => line.replace(/\s+/g, ' ').trim();

/** Remembers (terminal, rule, normalized line) for SAME_LINE_MS: a redraw of the same line is not news. Bounded. */
export class TriggerRepeats {
  private seen = new Map<string, number>();
  constructor(private readonly ms: number = SAME_LINE_MS) {}
  /** Whether this line was already notified recently; does not record. */
  seenRecently(termId: string, ruleId: string, line: string, now: number): boolean {
    const at = this.seen.get(`${termId}\u0000${ruleId}\u0000${normalizeLine(line)}`);
    return at !== undefined && now - at < this.ms;
  }
  record(termId: string, ruleId: string, line: string, now: number): void {
    const key = `${termId}\u0000${ruleId}\u0000${normalizeLine(line)}`;
    this.seen.delete(key);
    this.seen.set(key, now);
    if (this.seen.size > MAX_SEEN_LINES) {
      for (const [k, at] of this.seen) if (now - at >= this.ms) this.seen.delete(k);
      while (this.seen.size > MAX_SEEN_LINES) this.seen.delete(this.seen.keys().next().value!);
    }
  }
}

export interface CompiledRule { id: string; action: TriggerAction; scope: TriggerScope; re: RegExp }

/** The enabled, valid rules ready to match (global regexes, for every matched text of a highlight). */
export function compileRules(rules: readonly TriggerRule[]): CompiledRule[] {
  const out: CompiledRule[] = [];
  for (const r of rules) {
    if (!r.enabled) continue;
    const c = checkPattern(r.pattern);
    if (c.ok) out.push({ id: r.id, action: r.action, scope: r.scope, re: new RegExp(c.re.source, `${c.re.flags}g`) });
  }
  return out;
}

export interface TriggerHit { ruleId: string; line: string; texts: string[] }
const MAX_TEXTS = 8;

/**
 * Matches lines against the rules in scope, rule by rule (`onRule` says which one starts: a watchdog outside can tell
 * which one never finished). notify: one hit per matching line with its first match; highlight: up to 8 matched texts.
 * Once the batch has taken budgetMs, the remaining lines are skipped (truncated).
 */
export function matchLines(rules: readonly CompiledRule[], lines: readonly string[], kind: TerminalKind, opts: { now: () => number; budgetMs: number; onRule?: (id: string) => void; alt?: readonly boolean[] }): { hits: TriggerHit[]; truncated: boolean } {
  const start = opts.now();
  const hits: TriggerHit[] = [];
  let truncated = false;
  for (const r of rules) {
    if (!scopeAllows(r.scope, kind)) continue;
    opts.onRule?.(r.id);
    for (const [i, line] of lines.entries()) {
      if (opts.now() - start > opts.budgetMs) { truncated = true; break; }
      // A full-screen program redraws its screen all the time: its lines are never news.
      if (r.action === 'notify' && opts.alt?.[i]) continue;
      const texts: string[] = [];
      r.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while (texts.length < (r.action === 'notify' ? 1 : MAX_TEXTS) && (m = r.re.exec(line)) !== null) {
        if (m[0] === '') { r.re.lastIndex++; continue; }
        texts.push(m[0]);
      }
      if (texts.length) hits.push({ ruleId: r.id, line, texts });
    }
    if (truncated) break;
  }
  return { hits, truncated };
}

const MAX_THROTTLED = 1000;

/** At most one pass per (terminal, rule) every `ms`; remembers at most 1000 pairs. */
export class TriggerThrottle {
  private last = new Map<string, number>();
  constructor(private readonly ms: number = NOTIFY_EVERY_MS) {}
  allow(termId: string, ruleId: string, now: number): boolean {
    const key = `${termId}\u0000${ruleId}`;
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < this.ms) return false;
    if (this.last.size >= MAX_THROTTLED) {
      for (const [k, at] of this.last) if (now - at >= this.ms || at > now) this.last.delete(k);
      // Still full (all recent): the oldest go, the memory never grows past the cap.
      while (this.last.size >= MAX_THROTTLED) this.last.delete(this.last.keys().next().value!);
    }
    this.last.delete(key);
    this.last.set(key, now);
    return true;
  }
  size(): number { return this.last.size; }
}
