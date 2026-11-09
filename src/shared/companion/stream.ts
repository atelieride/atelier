// Parser for `claude -p --output-format stream-json` lines and the human trace lines shown while Ask reads.
// Claude Code calls the format internal and adds fields often: everything is narrowed defensively and unknown
// shapes are ignored, never thrown.
import { isBelow, samePath, splitPath, trimTrailingSep } from '../paths';
import { pathStyle, type PathStyle } from '../platform';
import type { LimitWindow } from './types';

export type StreamItem =
  | { t: 'init'; sessionId: string }
  | { t: 'delta'; text: string }
  | { t: 'tool'; id: string; name: string; input: unknown }
  | { t: 'denied'; tool: string; reason: string }
  | { t: 'rate'; status: string; resetsAt: number | null; window: LimitWindow | null }
  | { t: 'result'; isError: boolean; text: string; structured: unknown; costUsd: number | null; apiStatus: number | null };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Claude's `rateLimitType`: five_hour, or a seven_day one (all models, Opus, Sonnet: each weekly); else unknown. */
function limitWindow(v: unknown): LimitWindow | null {
  const s = str(v);
  return s === 'five_hour' ? 'five-hour' : s?.startsWith('seven_day') ? 'weekly' : null;
}

/** Every item a line holds (empty for nothing useful); never throws. */
export function parseStreamLine(line: string): StreamItem[] {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isObj(raw)) return [];
  switch (raw.type) {
    case 'system': {
      if (raw.subtype === 'init') {
        const sessionId = str(raw.session_id);
        return sessionId ? [{ t: 'init', sessionId }] : [];
      }
      if (raw.subtype === 'permission_denied') {
        return [{ t: 'denied', tool: str(raw.tool_name) ?? '', reason: str(raw.decision_reason) ?? str(raw.message) ?? '' }];
      }
      return [];
    }
    case 'stream_event': {
      const ev = raw.event;
      if (!isObj(ev) || ev.type !== 'content_block_delta' || !isObj(ev.delta)) return [];
      const text = ev.delta.type === 'text_delta' ? str(ev.delta.text) : null;
      return text === null ? [] : [{ t: 'delta', text }];
    }
    case 'assistant': {
      const content = isObj(raw.message) ? raw.message.content : null;
      if (!Array.isArray(content)) return [];
      const items: StreamItem[] = [];
      for (const block of content) {
        if (!isObj(block) || block.type !== 'tool_use') continue;
        const id = str(block.id);
        const name = str(block.name);
        if (id && name && name !== 'StructuredOutput') items.push({ t: 'tool', id, name, input: block.input });
      }
      return items;
    }
    case 'rate_limit_event': {
      const info = raw.rate_limit_info;
      if (!isObj(info)) return [];
      const status = str(info.status);
      return status === null ? [] : [{ t: 'rate', status, resetsAt: num(info.resetsAt), window: limitWindow(info.rateLimitType) }];
    }
    case 'result':
      return [{
        t: 'result',
        isError: raw.is_error === true,
        text: str(raw.result) ?? '',
        structured: raw.structured_output,
        costUsd: num(raw.total_cost_usd),
        apiStatus: num(raw.api_error_status),
      }];
    default:
      return [];
  }
}

const MAX_PATTERN = 60;

/**
 * `p` relative to `root` when it is strictly inside it (no `..` segments), `/`-separated; null otherwise. Windows (the
 * model writes C:\…, main's roots may be C:/…): either separator, any case, compared name by name (a name whose lower
 * case is longer, İ, never shifts the relative part).
 */
export function within(root: string, p: string, style: PathStyle = pathStyle()): string | null {
  const base = trimTrailingSep(root, style);
  if (style === 'win32') {
    const names = splitPath(base, style);
    const segs = splitPath(p, style);
    if (segs.length <= names.length || !names.every((n, i) => samePath(n, segs[i]!, style))) return null;
    // Windows reads a doubled separator as one: an empty name adds nothing.
    const rel = segs.slice(names.length).filter((s) => s !== '');
    return rel.length === 0 || rel.includes('..') ? null : rel.join('/');
  }
  if (!isBelow(base, p, style)) return null;
  const rel = p.slice(base.length + 1);
  return rel === '' || rel.split('/').includes('..') ? null : rel;
}

function inside(root: string, p: string, style: PathStyle): boolean {
  return samePath(trimTrailingSep(root, style), trimTrailingSep(p, style), style) || within(root, p, style) !== null;
}

/**
 * A Glob pattern that names a place itself: `/…` or the home folder (`~`, Glob doesn't expand it: shown as the attempt
 * it is, outside the project); on Windows also `\…` and a drive (C:\…, C:…).
 */
const absPattern = (p: string, style: PathStyle) => p.startsWith('~') || (style === 'win32' ? /^([A-Za-z]:|[\\/])/.test(p) : p.startsWith('/'));

export function traceLine(item: { name: string; input: unknown }, roots: { project: string; thread: string }, style: PathStyle = pathStyle()): string | null {
  const input = isObj(item.input) ? item.input : null;
  if (!input) return null;
  switch (item.name) {
    case 'Read': {
      const file = str(input.file_path);
      if (!file) return null;
      const inThread = within(roots.thread, file, style);
      if (inThread !== null) {
        if (samePath(inThread, 'chat.md', style)) return 'Read the chat';
        if (samePath(inThread, 'facts.md', style)) return 'Read the session facts';
        return null;
      }
      const rel = within(roots.project, file, style);
      return rel === null ? null : `Read ${rel}`;
    }
    case 'Grep': {
      const pattern = str(input.pattern);
      if (!pattern) return null;
      const p = `'${pattern.slice(0, MAX_PATTERN)}'`;
      const path = str(input.path);
      if (path === null) return `Searched the code for ${p}`;
      if (inside(roots.thread, path, style)) return `Searched the chat for ${p}`;
      return inside(roots.project, path, style) ? `Searched the code for ${p}` : null;
    }
    case 'Glob': {
      const pattern = str(input.pattern);
      if (!pattern || splitPath(pattern, style).includes('..')) return null;
      const path = str(input.path);
      if (path !== null && !inside(roots.project, path, style) && !inside(roots.thread, path, style)) return null;
      if (absPattern(pattern, style)) {
        const rel = within(roots.project, pattern, style);
        return rel === null ? null : `Listed ${rel.slice(0, MAX_PATTERN)}`;
      }
      return `Listed ${splitPath(pattern, style).join('/').slice(0, MAX_PATTERN)}`;
    }
    default:
      return null;
  }
}
