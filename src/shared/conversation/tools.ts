// The phones' conversation view: what one tool call shows (its target, its diff while it waits) and what its result
// makes of it (a summary, a detail, an error). Pure; every text is redacted before any cut.
import { isInside, splitPath } from '../paths';
import { redactSecrets } from '../session';
import { clean, relPath, short } from '../companion/chat';
import { cutFront, oneLine } from '../companion/text';
import { CAPS, type ToolStatus } from './types';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Where a path is shown: relative to the project, `~/…` under the home folder, else as it is. */
export interface At { root: string; home: string | null }

/**
 * What atelierd puts after "waiting: " in a waiting session's activity for this request (its `permissionTarget`):
 * the same words, so a phone can match a running call to the wait.
 */
export function waitTargetOf(tool: string, input: Record<string, unknown>): string {
  if (tool === 'ExitPlanMode') return 'plan approval';
  if (tool === 'AskUserQuestion') return 'question';
  const file = str(input.file_path) ?? str(input.notebook_path);
  if (file) return `${tool} ${file.split('/').filter(Boolean).at(-1) ?? file}`;
  const cmd = str(input.command);
  if (cmd) {
    const flat = cmd.replace(/\s+/g, ' ');
    return `${tool} ${flat.length > 60 ? `${flat.slice(0, 59)}…` : flat}`;
  }
  return tool;
}

function displayPath(p: string, at: At): string {
  const root = at.root.replace(/[\\/]+$/, '');
  let shown = p;
  if (root && isInside(root, p)) shown = relPath(p, root);
  else if (at.home && isInside(at.home, p)) shown = `~/${splitPath(p.slice(at.home.replace(/[\\/]+$/, '').length + 1)).join('/')}`;
  return cutFront(redactSecrets(oneLine(shown)), CAPS.target);
}

function targetOf(input: Obj, at: At): string | undefined {
  const file = str(input.file_path) ?? str(input.notebook_path);
  if (file) return displayPath(file, at);
  const pattern = str(input.pattern);
  const where = str(input.path);
  if (pattern) return short(where ? `${pattern} in ${displayPath(where, at)}` : pattern, CAPS.target);
  for (const k of ['command', 'description', 'url', 'query', 'skill', 'prompt']) {
    const v = str(input[k]);
    if (v) return short(v.split('\n').find((l) => l.trim()) ?? '', CAPS.target);
  }
  return undefined;
}

// Control characters (newline and tab aside) and format characters: they never hide a key from redaction.
const INVISIBLE = /(?![\n\t])[\p{Cc}\p{Cf}]/gu;
/** Text whose lines keep their leading spaces (a diff's context lines): invisible characters gone, secrets redacted. */
const verbatim = (s: string) => redactSecrets(s.replace(/\r\n?/g, '\n').replace(INVISIBLE, ''));

/** At most the first `lines` lines and `max` characters of `text`, the end replaced by "…". */
function head(text: string, lines: number, max: number): string {
  let out = text.split('\n').slice(0, lines).join('\n');
  if (out.length > max) out = `${out.slice(0, /[\ud800-\udbff]/.test(out[max - 2] ?? '') ? max - 2 : max - 1)}…`;
  return out;
}

/** A command's or tool's output: redacted first, then its end kept (the last lines, at most `max` characters). */
function tail(text: string): string {
  const flat = verbatim(text.length > 65536 ? text.slice(-65536) : text).replace(/\s+$/, '');
  const lines = flat.split('\n');
  const kept = lines.slice(-CAPS.outputLines).join('\n');
  return cutFront(kept, CAPS.output);
}

const diffLines = (sign: '-' | '+', text: string) => text.replace(/\n$/, '').split('\n').map((l) => sign + l);

/** The "-"/"+" lines of an edit that has not run yet. */
function editDiff(input: Obj): string | undefined {
  const edits = Array.isArray(input.edits) ? input.edits.filter(isObj) : [input];
  const lines = edits.flatMap((e) => {
    const old = typeof e.old_string === 'string' ? e.old_string : null;
    const next = typeof e.new_string === 'string' ? e.new_string : null;
    return old === null || next === null ? [] : [...(old ? diffLines('-', old) : []), ...(next ? diffLines('+', next) : [])];
  });
  return lines.length ? head(verbatim(lines.join('\n')), CAPS.detailLines, CAPS.detail) : undefined;
}

/** What a call shows while it waits or runs: its tool, target and, for edits, writes and plans, a detail. */
export function toolCall(name: string, input: Record<string, unknown>, at: At): { tool: string; target?: string; detail?: string } {
  const out: { tool: string; target?: string; detail?: string } = { tool: name };
  if (name !== 'ExitPlanMode') {
    const target = targetOf(input, at);
    if (target) out.target = target;
  }
  let detail: string | undefined;
  if (name === 'Edit' || name === 'MultiEdit') detail = editDiff(input);
  else if (name === 'Write') {
    const content = typeof input.content === 'string' ? input.content : '';
    if (content) detail = head(verbatim(diffLines('+', content.slice(0, CAPS.detail * 2)).join('\n')), CAPS.detailLines, CAPS.detail);
  } else if (name === 'ExitPlanMode') {
    const plan = str(input.plan);
    if (plan) detail = clean(plan, CAPS.plan);
  }
  if (detail) out.detail = detail;
  return out;
}

/** The text of a tool_result's content: a string, or its text parts. */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => isObj(c) && c.type === 'text' && typeof c.text === 'string').map((c) => (c as Obj).text as string).join('\n');
}

const lineCount = (s: string) => (s.trim() ? s.replace(/\n+$/, '').split('\n').length : 0);

function failure(content: unknown, result: unknown, line: Obj): { status: ToolStatus; summary: string; detail?: string; feedback?: string } {
  const text = contentText(content).trim();
  const feedback = str(line.userFeedback);
  if (feedback) return { status: 'error', summary: 'Rejected', feedback: clean(feedback, CAPS.feedback) };
  if (result === 'User rejected tool use' || text.startsWith("The user doesn't want to proceed")) return { status: 'error', summary: 'Interrupted' };
  const body = text.replace(/^<tool_use_error>\s*/, '').replace(/\s*<\/tool_use_error>$/, '');
  const summary = short(body.split('\n').find((l) => l.trim()) ?? 'Failed', CAPS.summary);
  return { status: 'error', summary, ...(body ? { detail: clean(body, CAPS.output) } : {}) };
}

/** What a result makes of a call: its status, summary, detail and, for a rejection, the user's words. */
export function toolDone(
  name: string, input: Record<string, unknown>, content: unknown, result: unknown, isError: boolean, line: Record<string, unknown>
): { status: ToolStatus; summary?: string; detail?: string; feedback?: string } {
  if (isError) return failure(content, result, line);
  const r = isObj(result) ? result : {};
  const text = contentText(content);
  switch (name) {
    case 'Bash': {
      if (typeof r.backgroundTaskId === 'string') return { status: 'ok', summary: 'In background' };
      const out = [r.stdout, r.stderr].filter((v): v is string => typeof v === 'string' && v.trim() !== '').join('\n');
      const body = typeof r.stdout === 'string' || typeof r.stderr === 'string' ? out : text;
      if (!body.trim() || r.noOutputExpected === true) return { status: 'ok', summary: 'No output' };
      return { status: 'ok', summary: plural(lineCount(body), 'line'), detail: tail(body) };
    }
    case 'Read': {
      const n = num(isObj(r.file) ? r.file.numLines : null);
      return n === null ? { status: 'ok' } : { status: 'ok', summary: plural(n, 'line') };
    }
    case 'Edit': case 'MultiEdit': {
      const lines = (Array.isArray(r.structuredPatch) ? r.structuredPatch : []).filter(isObj)
        .flatMap((h) => (Array.isArray(h.lines) ? h.lines.filter((l): l is string => typeof l === 'string') : []));
      if (lines.length === 0) return { status: 'ok' };
      const added = lines.filter((l) => l.startsWith('+')).length;
      const removed = lines.filter((l) => l.startsWith('-')).length;
      return { status: 'ok', summary: `+${added} −${removed}`, detail: head(verbatim(lines.join('\n')), CAPS.detailLines, CAPS.detail) };
    }
    case 'Write': {
      const body = typeof r.content === 'string' ? r.content : typeof input.content === 'string' ? input.content : null;
      return body === null ? { status: 'ok' } : { status: 'ok', summary: plural(lineCount(body), 'line') };
    }
    case 'Grep': case 'Glob': {
      const files = num(r.numFiles);
      if (files !== null) return { status: 'ok', summary: plural(files, 'file') };
      const matches = num(r.numMatches);
      if (matches !== null) return { status: 'ok', summary: plural(matches, 'match', 'matches') };
      return { status: 'ok', summary: plural(lineCount(text), 'line') };
    }
    case 'ExitPlanMode': return { status: 'ok', summary: 'Approved' };
    default: {
      if (!text.trim()) return { status: 'ok', summary: 'Done' };
      return { status: 'ok', summary: plural(lineCount(text), 'line'), detail: tail(text) };
    }
  }
}
