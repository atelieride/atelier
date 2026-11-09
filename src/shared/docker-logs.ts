// Docker logs: what makes a container's lines readable — the timestamp Docker prefixes, access
// lines (status colors), one-line JSON (message + "{…} N keys"), stack traces folded after two frames, frames that
// point into the project through a bind mount.
import { classify, stripAnsi } from './logline';
import type { Mount } from './docker';

/** One log line as main sends it: absolute number, time (ms, null if unknown), stream, text (ANSI kept). */
export interface DockerLogLine { seq: number; at: number | null; err: boolean; text: string; /** Stack view: the container's name. */ svc?: string }

const STAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2}) ?/;

/** The RFC 3339 prefix of `timestamps=1` (nanoseconds cut to ms), and the line without it. */
export function splitTimestamp(line: string): { at: number | null; text: string } {
  const m = STAMP.exec(line);
  if (!m) return { at: null, text: line };
  const frac = m[2] ? `.${m[2].slice(1, 4).padEnd(3, '0')}` : '';
  const at = Date.parse(`${m[1]}${frac}${m[3]}`);
  return Number.isFinite(at) ? { at, text: line.slice(m[0].length) } : { at: null, text: line };
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
/** Local time, to the millisecond. */
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export interface Http { method: string; path: string; status: number; duration: string | null }
const HTTP = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S*?)"?(?:\s+HTTP\/\d(?:\.\d)?"?)?\s+(?:(?:→|->)\s*)?([1-5]\d\d)\b(?:[^\d\n]*?(\d+(?:\.\d+)?\s?(?:ms|µs|us|s))\b)?/;

/** An access line: method, path, status and (when written) the duration. */
export function httpOf(text: string): Http | null {
  const m = HTTP.exec(stripAnsi(text));
  return m ? { method: m[1]!, path: m[2]!, status: Number(m[3]), duration: m[4] ?? null } : null;
}

const FRAME = /^\s+(?:at\s+\S|File ".+", line \d+|\.\.\. \d+ more\b)/;
export const isFrame = (text: string): boolean => FRAME.test(stripAnsi(text));

const JS_FRAME = /^\s+at\s+(?:.*?\()?((?:\/|\.\.?\/)?[^\s():]*\.[A-Za-z0-9]+):(\d+)(?::\d+)?\)?\s*$/;
const PY_FRAME = /^\s+File "([^"]+)", line (\d+)/;

/** The file and line a frame points at (Node internals and the like: null). */
export function frameOf(text: string): { path: string; line: number } | null {
  const t = stripAnsi(text);
  const m = JS_FRAME.exec(t) ?? PY_FRAME.exec(t);
  if (!m || m[1]!.startsWith('node:') || m[1]!.includes('node:')) return null;
  return { path: m[1]!, line: Number(m[2]) };
}

function normalize(p: string): string | null {
  if (!p.startsWith('/')) return null;
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!out.length) return null; out.pop(); } else out.push(part);
  }
  return `/${out.join('/')}`;
}

/** A path inside the container, on the host through a bind mount, when that lands inside the project. */
export function hostPath(path: string, mounts: readonly Mount[], root: string): string | null {
  const p = normalize(path);
  if (!p) return null;
  for (const m of mounts) {
    if (m.type !== 'bind') continue;
    const target = m.target.replace(/\/+$/, '');
    if (p !== target && !p.startsWith(`${target}/`)) continue;
    const host = normalize(m.source.replace(/\/+$/, '') + p.slice(target.length));
    if (host && (host === root || host.startsWith(`${root.replace(/\/+$/, '')}/`))) return host;
  }
  return null;
}

export type TraceRow = { kind: 'line'; index: number } | { kind: 'fold'; index: number; hidden: number };
const SHOWN_FRAMES = 2;

/** The rows to draw: in a run of more than three frames, the third on fold into one row unless opened (`isOpen(i)`). */
export function foldTraces(texts: readonly string[], isOpen: (firstHidden: number) => boolean): TraceRow[] {
  const out: TraceRow[] = [];
  for (let i = 0; i < texts.length;) {
    if (!isFrame(texts[i]!)) { out.push({ kind: 'line', index: i++ }); continue; }
    let end = i;
    while (end < texts.length && isFrame(texts[end]!)) end++;
    const run = end - i;
    const fold = i + SHOWN_FRAMES;
    if (run > SHOWN_FRAMES + 1 && !isOpen(fold)) {
      for (let k = i; k < fold; k++) out.push({ kind: 'line', index: k });
      out.push({ kind: 'fold', index: fold, hidden: end - fold });
    } else for (let k = i; k < end; k++) out.push({ kind: 'line', index: k });
    i = end;
  }
  return out;
}

const META_KEYS = new Set(['time', 'timestamp', 'ts', '@timestamp', 'level', 'severity', 'lvl', 'msg', 'message']);

/** A one-line JSON object: its message (msg/message) and how many other keys it carries. */
export function jsonSummary(text: string): { message: string | null; keys: number } | null {
  const t = stripAnsi(text).trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return null;
  let o: unknown;
  try { o = JSON.parse(t); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  const message = typeof r.msg === 'string' ? r.msg : typeof r.message === 'string' ? r.message : null;
  return { message, keys: Object.keys(r).filter((k) => !META_KEYS.has(k)).length };
}

export type DockerLevel = 'error' | 'warn' | 'info' | 'debug' | 'http' | 'plain';
const DEBUG = /^\s*(?:\S+\s+){0,2}?\[?(?:debug|trace|verbose)\]?(?::|\s)/i;

/** The level shown and filtered on. Access lines by status; stderr alone is not an error (many loggers use it). */
export function lineLevel(text: string, _stream: 'out' | 'err'): DockerLevel {
  const t = stripAnsi(text);
  const http = httpOf(t);
  if (http) return http.status >= 500 ? 'error' : http.status >= 400 ? 'warn' : 'http';
  const c = classify(t);
  if (c === 'error' || c === 'warn') return c;
  if (DEBUG.test(t)) return 'debug';
  return c === 'plain' ? 'plain' : 'info';
}
