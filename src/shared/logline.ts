export type Level = 'error' | 'warn' | 'info' | 'ok' | 'plain';
export interface Seg { text: string; color: string | null; bold: boolean }
export interface LogLine { raw: string; text: string; level: Level; segs: Seg[]; json: [string, string][] | null; time: string | null }

/** The 16 named colors are the theme's (--log-0…15 in theme.css, themes.css): readable on light themes too. */
const named = (n: number) => `var(--log-${n})`;

function color256(n: number): string {
  if (n < 16) return named(n);
  if (n < 232) { const i = n - 16; const c = (v: number) => (v === 0 ? 0 : 55 + v * 40); return `rgb(${c(Math.floor(i / 36))},${c(Math.floor(i / 6) % 6)},${c(i % 6)})`; }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

const ANY_ESC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;

export function stripAnsi(raw: string): string { return raw.replace(ANY_ESC, ''); }

export function parseAnsi(raw: string): Seg[] {
  const out: Seg[] = [];
  let color: string | null = null; let bold = false; let last = 0;
  const push = (text: string) => { if (!text) return; const prev = out.at(-1); if (prev && prev.color === color && prev.bold === bold) prev.text += text; else out.push({ text, color, bold }); };
  for (const m of raw.matchAll(ANY_ESC)) {
    push(raw.slice(last, m.index));
    last = m.index! + m[0].length;
    const sgr = /^\x1b\[([0-9;]*)m$/.exec(m[0]);
    if (!sgr) continue;
    const codes = (sgr[1] || '0').split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]!;
      if (c === 0) { color = null; bold = false; }
      else if (c === 1) bold = true;
      else if (c === 22) bold = false;
      else if (c === 39) color = null;
      else if (c >= 30 && c <= 37) color = named(c - 30);
      else if (c >= 90 && c <= 97) color = named(c - 90 + 8);
      else if (c === 38 && codes[i + 1] === 5) { color = color256(codes[i + 2] ?? 7); i += 2; }
      else if (c === 38 && codes[i + 1] === 2) { color = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`; i += 4; }
      else if (c === 48 && (codes[i + 1] === 5 || codes[i + 1] === 2)) i += codes[i + 1] === 5 ? 2 : 4; // backgrounds ignored
    }
  }
  push(raw.slice(last));
  return out;
}

const ERR = /\b(error|err!|fatal|exception|unhandled\w*|panic|failed|failure|ECONNREFUSED|EADDRINUSE)\b|^\s+at .+:\d+:\d+\)?$/i;
const WARN = /\b(warn|warning|deprecated)\b/i;
const OK = /\b(ready in|listening on|compiled successfully|server (is )?running|started)\b/i;
const INFO = /\b(GET|POST|PUT|PATCH|DELETE|INFO)\b/;

function jsonLevel(o: Record<string, unknown>): Level | null {
  const l = o.level ?? o.severity ?? o.lvl;
  if (typeof l === 'number') return l >= 50 ? 'error' : l >= 40 ? 'warn' : 'info';
  if (typeof l === 'string') { const s = l.toLowerCase(); return s.startsWith('err') || s === 'fatal' ? 'error' : s.startsWith('warn') ? 'warn' : 'info'; }
  return null;
}

function tryJson(text: string): Record<string, unknown> | null {
  const t = text.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return null;
  try { const v = JSON.parse(t); return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null; } catch { return null; }
}

// Level written by the logger at the start of the line (winston "info:", "[ERROR]", even after date and time): it wins over the message words.
const LEVEL_WORD = '(error|fatal|warn(?:ing)?|info|debug|verbose|silly|http|trace)';
const LEVEL_COLON = new RegExp(`^\\s*(?:\\S+\\s+){0,2}?${LEVEL_WORD}\\s*:`, 'i');
const LEVEL_BRACKET = new RegExp(`^\\s*(?:\\S+\\s+){0,2}?\\[${LEVEL_WORD}\\]`, 'i');

function explicitLevel(text: string): Level | null {
  const m = LEVEL_COLON.exec(text) ?? LEVEL_BRACKET.exec(text);
  if (!m) return null;
  const w = m[1]!.toLowerCase();
  return w === 'error' || w === 'fatal' ? 'error' : w.startsWith('warn') ? 'warn' : 'info';
}

// One member of a pretty-printed JSON object (`"error": null,`, `"items": [`): parsed back as a one-key object.
function jsonMember(text: string): Record<string, unknown> | null {
  const t = text.trim().replace(/,$/, '');
  if (!/^"(?:[^"\\]|\\.)*"\s*:/.test(t)) return null;
  const closed = t.endsWith('{') ? `${t}}` : t.endsWith('[') ? `${t}]` : t;
  return tryJson(`{${closed}}`);
}

// A test reporter's result line (Playwright, Vitest, Jest, Mocha, TAP, Go, pytest): its mark says how the test went,
// never the words of its title (`✓ no page logs an error` passed).
// Each mark in the shape its reporter prints, so look-alikes (`- 1 error found`, `ok 200 POST … failed`) still count.
const TEST_PASS = /^\s*(?:[✓✔√]\s|PASS\s+\S+\.[cm]?[jt]sx?\b|ok \d+(?: - | #|\s*$))|^--- PASS:|^\S+::\S+.*\sPASSED(?:\s+\[\s*\d+%\])?\s*$/;
const TEST_FAIL = /^\s*(?:[✘✗×✖]\s|FAIL\s+\S+\.[cm]?[jt]sx?\b|not ok \d+(?: - | #|\s*$))|^--- FAIL:|^\S+::\S+.*\sFAILED(?:\s+\[\s*\d+%\])?\s*$/;
// Playwright's skipped test (`-  3 [project] › file:line:col › title`, or without a project) and Vitest's.
const TEST_SKIP = /^\s*(?:↓\s|-\s+\d+\s+(?:\[[^\]]+\]\s+›|\S+:\d+:\d+\s+›))/;

function testResult(text: string): Level | null {
  if (TEST_FAIL.test(text)) return 'error';
  if (TEST_PASS.test(text)) return 'ok';
  return TEST_SKIP.test(text) ? 'plain' : null;
}

export function classify(text: string): Level {
  const j = tryJson(text);
  if (j) return jsonLevel(j) ?? 'info';
  // Like whole JSON lines, only a level key counts: `"error": null` is a field name, not an error.
  const member = jsonMember(text);
  if (member) return jsonLevel(member) ?? 'plain';
  const result = testResult(text);
  if (result) return result;
  const explicit = explicitLevel(text);
  if (explicit) return explicit;
  if (ERR.test(text)) return 'error';
  if (WARN.test(text)) return 'warn';
  if (OK.test(text)) return 'ok';
  if (INFO.test(text)) return 'info';
  return 'plain';
}

const TIME_KEYS = ['time', 'timestamp', 'ts', '@timestamp'];

export function parseLogLine(raw: string): LogLine {
  const text = stripAnsi(raw);
  const j = tryJson(text);
  let json: [string, string][] | null = null; let time: string | null = null;
  if (j) {
    json = [];
    for (const [k, v] of Object.entries(j)) {
      if (TIME_KEYS.includes(k)) { const m = /T?(\d{2}:\d{2}:\d{2})/.exec(String(v)); if (m) time = m[1]!; continue; }
      json.push([k, typeof v === 'string' ? v : JSON.stringify(v)]);
    }
  }
  // In text lines the time, if any, is already in the text: the column would only repeat it.
  return { raw, text, level: classify(text), segs: parseAnsi(raw), json, time };
}

/**
 * Text to paste into Claude's prompt: printable characters and tabs only, without Enter.
 * With `bracketed` (the foreground program enabled it) it arrives as a real paste, not as keystrokes.
 */
export function pasteText(text: string, bracketed = true): string {
    const clean = stripAnsi(text).replace(/[\x00-\x08\x0a-\x1f\x7f]/g, '');
  return bracketed ? `\x1b[200~${clean}\x1b[201~` : clean;
}

// Lines where a service says where it listens (Vite, Next, Express, Fastify, Nest…).
const LISTEN = /\b(listen(ing)?|local:|running (at|on)|started (server )?on|server (is )?(running|ready)|ready (on|at|-))/i;

/** Port the service listens on: only from startup lines, never from error lines (which quote other people's ports). */
export function detectPort(lines: string[]): number | null {
  for (const l of lines) {
    const t = stripAnsi(l);
    if (!LISTEN.test(t) || classify(t) === 'error') continue;
    const m = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]|\[::1\]):(\d{2,5})\b/.exec(t) ?? /\bport\s+(\d{2,5})\b/i.exec(t);
    if (m) return Number(m[1]);
  }
  return null;
}
