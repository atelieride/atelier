// The Claude Code screen of a scripted session: a TypeScript port of the drawing in
// tests/e2e/fake-claude-demo.pl, which stays as it is for the screenshots. Transcript on top, a dim divider, then the
// bottom area of the session's state (permission menu, options, spinner, prompt). Pure: the runtime redraws it on every
// resize and input, so it is a function of the size, never recorded bytes. The optional fields are the live demo's own
// (an edit permission, the text being typed, the spinner's frame and counters); without them the bytes are the Perl's.
import type { Scenario } from '../world/scenarios';

/** A permission other than a Bash command (an edit): its heading, what it touches, the question and the choices. */
export interface PermissionView { title: string; detail: string[]; question: string; choices: string[] }

/** What the drawing needs of a scenario, plus what the live demo animates. */
export type ClaudeScreen = Pick<Scenario, 'transcript' | 'state'> & Partial<Pick<Scenario, 'command' | 'options' | 'spinner'>> & {
  /** `permission`: drawn instead of the Bash command. */
  permission?: PermissionView;
  /** The prompt's text (idle, done, working): what the visitor typed so far; lines split on "\n". */
  input?: string;
  /** `working`: the spinner's glyph now (✻ by default), seconds since the turn started and tokens so far. */
  glyph?: string;
  elapsed?: number;
  tokens?: number;
};

export function screenOf(s: Scenario): ClaudeScreen {
  return {
    transcript: s.transcript, state: s.state,
    ...(s.state === 'permission' && s.command !== undefined ? { command: s.command } : {}),
    ...(s.state === 'question' && s.options ? { options: s.options } : {}),
    ...(s.state === 'working' && s.spinner !== undefined ? { spinner: s.spinner } : {})
  };
}

const ESC = '\u001b';
const DIM = `${ESC}[2m`;
const RST = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const PROMPT = '> ';

export const BASH_CHOICES = ['Yes', "Yes, and don't ask again", 'No, tell Claude what to do'];

/** Claude Code's spinner glyphs, back and forth (the runtime cycles them while Claude works). */
export const SPINNER_GLYPHS = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];

/** A numbered menu: the picked item cyan behind a ❯, the others indented to line up (Claude Code's look). */
function menu(items: readonly string[], selected: number): string[] {
  return items.map((label, i) => (i === selected ? ` ${ESC}[36m❯ ${i + 1}. ${label}${RST}` : `   ${i + 1}. ${label}`));
}

/** How many choices the state's menu offers (0: no menu). */
export function choicesOf(s: ClaudeScreen): number {
  if (s.state === 'permission') return (s.permission?.choices ?? BASH_CHOICES).length;
  if (s.state === 'question') return s.options?.length ?? 0;
  return 0;
}

/** "1.2k" above a thousand, as Claude Code counts tokens. */
const tokensText = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/**
 * The spinner's line: the Perl's when no counter is given, with the time and tokens otherwise. In a narrow pane the
 * hint shrinks (tokens first, then the time) so the line never wraps into the prompt below it.
 */
export function spinnerLine(s: ClaudeScreen, cols = Infinity): string {
  const glyph = s.glyph ?? '✻';
  const hints = s.elapsed === undefined ? ['(esc to interrupt)', ''] : [`(${s.elapsed}s · ↓ ${tokensText(s.tokens ?? 0)} tokens · esc to interrupt)`, `(${s.elapsed}s · esc to interrupt)`, `(${s.elapsed}s)`, ''];
  const lineOf = (hint: string) => `${ESC}[38;5;211m${glyph} ${s.spinner ?? ''}${RST}${hint ? ` ${DIM}${hint}${RST}` : ''}`;
  const fits = hints.find((h) => visibleLength(lineOf(h)) <= cols);
  return fits !== undefined ? lineOf(fits) : clipVisible(lineOf(''), cols);
}

/** The first `n` visible characters of a styled line, its styles kept (and closed, so nothing bleeds into what follows). */
export function clipVisible(line: string, n: number): string {
  if (visibleLength(line) <= n) return line;
  let out = '';
  let seen = 0;
  let i = 0;
  while (i < line.length && seen < n) {
    const m = /^\u001b\[[0-9;?]*[A-Za-z]/.exec(line.slice(i));
    if (m) { out += m[0]; i += m[0].length; continue; }
    const ch = String.fromCodePoint(line.codePointAt(i)!);
    out += ch;
    i += ch.length;
    seen++;
  }
  return `${out}${ESC}[0m`;
}

/** The prompt's lines: "> " then the text, its last part when it is wider than the screen. */
function promptLines(input: string | undefined, cols: number): string[] {
  const lines = (input ?? '').split('\n');
  const room = Math.max(1, cols - PROMPT.length - 1);
  return lines.map((l, i) => {
    const chars = [...l];
    const shown = chars.length > room ? `…${chars.slice(chars.length - room + 1).join('')}` : l;
    return `${i === 0 ? PROMPT : '  '}${shown}`;
  });
}

function bottomOf(s: ClaudeScreen, selected: number, cols: number): { lines: string[]; prompt: number } {
  switch (s.state) {
    case 'permission': {
      const p = s.permission;
      const head = p ? [` ${BOLD}${p.title}${RST}`, ...p.detail.map((d) => `   ${d}`), '', ` ${p.question}`] : [` ${BOLD}Bash command${RST}`, `   ${s.command ?? ''}`, '', ' Do you want to proceed?'];
      return { lines: [...head, ...menu(p?.choices ?? BASH_CHOICES, selected)], prompt: -1 };
    }
    case 'question': return { lines: menu(s.options ?? [], selected), prompt: -1 };
    case 'working': {
      const prompt = promptLines(s.input, cols);
      return { lines: [spinnerLine(s, cols), '', ...prompt, ''], prompt: 2 + prompt.length - 1 };
    }
    default: {
      const prompt = promptLines(s.input, cols);
      return { lines: ['', ...prompt, ''], prompt: 1 + prompt.length - 1 };
    }
  }
}

/** Visible characters of a line (styles dropped): what it takes on screen. */
export function visibleLength(line: string): number {
  return [...line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')].length;
}

/**
 * A transcript line wider than the pane, broken at spaces as Claude Code re-wraps its text on a resize: the next rows
 * indented under the text (past a "● " or "⎿ "). Styles carry over the line break by themselves (SGR stays set).
 */
export function wrapLine(line: string, cols: number): string[] {
  if (visibleLength(line) <= cols) return [line];
  const plain = line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
  const indent = Math.min(Math.floor(cols / 2), /^[\s●⎿>]*/.exec(plain)![0].length);
  const out: string[] = [];
  let cur = '';
  let width = 0;
  for (const part of line.split(/(?<= )/)) {
    const w = visibleLength(part);
    if (width > indent && width + w - (part.endsWith(' ') ? 1 : 0) > cols) {
      out.push(cur.replace(/ +$/, ''));
      cur = ' '.repeat(indent);
      width = indent;
    }
    cur += part;
    width += w;
  }
  out.push(cur);
  return out;
}

/** The transcript's last lines that fit in `room` rows, a long line taking as many rows as it wraps to. */
function fit(transcript: readonly string[], room: number, cols: number): readonly string[] {
  let used = 0;
  let from = transcript.length;
  while (from > 0) {
    const h = Math.max(1, Math.ceil(visibleLength(transcript[from - 1]!) / Math.max(1, cols)));
    if (used + h > room) break;
    used += h;
    from--;
  }
  return from === 0 ? transcript : transcript.slice(from);
}

interface Layout { bottom: string[]; top: number; cursor: string }

function layout(s: ClaudeScreen, rows: number, cols: number, selected: number): Layout {
  // Every bottom line on its own row: one wider than the pane (a long menu choice) is cut, never wrapped over the next.
  const raw = bottomOf(s, selected, cols);
  const lines = raw.lines.map((l) => clipVisible(l, Math.max(1, cols)));
  const prompt = raw.prompt;
  const top = rows - lines.length;
  // The cursor sits at the end of the prompt's text (shown), or hides while a menu is up, as Claude Code does.
  const cursor = prompt >= 0 ? `${ESC}[?25h${ESC}[${top + 1 + prompt};${visibleLength(lines[prompt]!) + 1}H` : `${ESC}[?25l`;
  return { bottom: lines, top, cursor };
}

/**
 * The whole screen for a terminal of `rows` × `cols`: clear, transcript (its tail, when it does not fit above the
 * divider, as Claude Code scrolls it away), divider at `rows - bottom`, the bottom lines placed absolutely, and the
 * cursor in the prompt (shown) or hidden while a menu is up.
 */
export function claudeScreen(s: ClaudeScreen, rows: number, cols: number, opts: { selected?: number } = {}): string {
  const { bottom, top, cursor } = layout(s, rows, cols, opts.selected ?? 0);
  let out = `${ESC}[2J${ESC}[H`;
  for (const line of fit(s.transcript.flatMap((l) => wrapLine(l, cols)), top - 1, cols)) out += `${line}\r\n`;
  out += `${ESC}[${top};1H${DIM}${'─'.repeat(Math.max(0, cols))}${RST}`;
  bottom.forEach((line, i) => { out += `${ESC}[${top + 1 + i};1H${line}`; });
  return out + cursor;
}

/** Only the spinner's line redrawn (a frame of its animation), the cursor put back: '' when nothing spins. */
export function spinnerFrame(s: ClaudeScreen, rows: number, cols: number): string {
  if (s.state !== 'working') return '';
  const { top, cursor } = layout(s, rows, cols, 0);
  return `${ESC}[${top + 1};1H${ESC}[2K${spinnerLine(s, cols)}${cursor}`;
}
