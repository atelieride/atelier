// Ask companion: what the panel shows, pure. The panel and its host only render these.
import { parseAnswer, plainText } from '@shared/companion/answer';
import type { CatchPoint, CompanionModel, Thread, ThreadItem } from '@shared/companion/types';
import { clockTime } from '../work-view';
import { agoLower } from '../connectors-view';
import { t } from '../i18n/en';
import { dockMode, type RunView } from './model';
import { suggestionsFrom, whyQuestion } from './suggest';

/**
 * What ⌘I acts on ("toggles Ask for the focused session"): the selected terminal when it is a session or has
 * Ask open (an ended one still closes), else the last session. One not on screen is shown first (and opened); an open
 * panel is never closed unseen.
 */
export function askTarget(o: { selectedId: string | null; lastSession: string | null; open: ReadonlySet<string>; sessions: ReadonlySet<string>; shown: ReadonlySet<string> }): { id: string; show: boolean; toggle: boolean } | null {
  const ok = (id: string | null): id is string => id !== null && (o.open.has(id) || o.sessions.has(id));
  const id = ok(o.selectedId) ? o.selectedId : ok(o.lastSession) ? o.lastSession : null;
  if (id === null) return null;
  const show = !o.shown.has(id);
  return { id, show, toggle: !show || !o.open.has(id) };
}

/** The pane showing `key` holds its terminal's Ask as a sheet (over the pane's right side). */
export function sheetIn(st: { askOpen: Record<string, unknown>; askDock: Record<string, 'dock' | 'sheet'> }, key: string | null): boolean {
  if (!key?.startsWith('t:')) return false;
  const id = key.slice(2);
  return !!st.askOpen[id] && st.askDock[id] === 'sheet';
}

/**
 * Docked beside the terminal, or a sheet over it when the terminal would drop under its minimum. A sheet
 * stays one (`held`) when room comes back: docking resizes the terminal under the user's eyes, so the header's dock
 * button (`canDock`) does it.
 */
export function placement(paneWidth: number, held: boolean): { mode: 'dock' | 'sheet'; held: boolean; canDock: boolean } {
  const fits = dockMode(paneWidth) === 'dock';
  const sheet = held || !fits;
  return { mode: sheet ? 'sheet' : 'dock', held: sheet, canDock: sheet && fits };
}

/** Whether the session's Ask is answering (Stop) or has a run waiting its turn (Send waits too). */
export function runPhase(runs: Record<string, RunView>, sessionId: string): 'idle' | 'queued' | 'running' {
  let phase: 'idle' | 'queued' | 'running' = 'idle';
  for (const r of Object.values(runs)) {
    if (r.sessionId !== sessionId) continue;
    if (!r.queued) return 'running';
    phase = 'queued';
  }
  return phase;
}

/** The composer's hint: about the session, then a follow-up once a question was asked. */
export function askPlaceholder(thread: Thread | null, title: string): string {
  return thread?.items.some((i) => i.kind === 'question') ? t.companion.followUp : t.companion.askAbout(title);
}

export const MODEL_LABEL: Record<CompanionModel, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' };

const usd = (v: number) => (v <= 0 ? '$0.00' : v < 0.01 ? '<$0.01' : `$${v.toFixed(2)}`);

/** The ⋯ menu's last line: what the thread cost so far (from Claude's results). */
export function costLine(costUsd: number): string {
  return t.companion.cost(usd(costUsd));
}

const STATUS_WORD: Record<CatchPoint['status'], string> = { done: 'done', in_progress: 'in progress', not_started: 'not started', unclear: 'unclear' };

/** An item's header line in a copied thread (Copy Thread's Markdown and HTML): who, and when. */
export function itemHeading(i: ThreadItem): string {
  const when = clockTime(i.at);
  switch (i.kind) {
    case 'question': return `You · ${when}`;
    case 'answer': return `Ask · ${MODEL_LABEL[i.model]} · ${when}${i.stopped ? ' · Stopped' : ''}`;
    case 'error': return `Error · ${when}`;
    case 'catchup': return `Catch me up${i.final ? ' (final)' : ''} · ${when}`;
  }
}

function itemMarkdown(i: ThreadItem): string[] {
  const head = `## ${itemHeading(i)}`;
  switch (i.kind) {
    case 'question':
      return [head, '', i.text];
    case 'answer':
      return [head, '', i.markdown.trim()];
    case 'error':
      return [head, '', i.message];
    case 'catchup': {
      const c = i.data;
      const out = [head];
      if (c.points.length) out.push('', ...c.points.map((p) => `${p.n}. [${STATUS_WORD[p.status]}] ${p.text}${p.at ? ` (${p.at})` : ''}${p.note ? ` — ${p.note}` : ''}`));
      if (c.where) out.push('', `**Where it is:** ${c.where}`);
      if (c.choices.length) out.push('', '**Choices it made:**', ...c.choices.map((x) => `- ${x}`));
      if (c.leftOpen) out.push('', `**Left open:** ${c.leftOpen}`);
      return out;
    }
  }
}

/** Copy Thread's Markdown (its text flavour, copy.ts writes its HTML): every item in order, under the session's name. */
export function threadMarkdown(thread: Thread, title: string): string {
  const out = [`# ${t.companion.askAboutTitle(title)}`];
  for (const i of thread.items) out.push('', ...itemMarkdown(i));
  return `${out.join('\n')}\n`;
}

// --- Catch me up -------------------------------------------------------------------------

// The chips' rules live in suggest.ts (light enough for the live demo's tests to check its script against them).
export { suggestionsFrom, whyQuestion };

/** The chips under the thread: right after a Catch me up, while nothing runs (an empty thread shows its own starters). */
export function suggestionsFor(thread: Thread | null, busy: boolean): string[] {
  const last = thread?.items.at(-1);
  return !busy && last?.kind === 'catchup' ? suggestionsFrom(last.data) : [];
}

export type PointTime = { text: string; tone: 'time' | 'now' | 'next' | 'asked' | 'open' } | null;

/**
 * Each point's right column: the time a done one finished, "now" for the one in progress, "next" for the
 * first not started, then when a later one was asked. A final card (the session ended): whatever isn't done says so.
 */
export function pointTimes(points: readonly CatchPoint[], final: boolean): PointTime[] {
  const next = final ? -1 : points.findIndex((p) => p.status === 'not_started');
  return points.map((p, i): PointTime => {
    if (p.status === 'done') return p.at ? { text: p.at, tone: 'time' } : null;
    if (p.status === 'unclear') return null;
    if (final) return { text: t.companion.notDone, tone: 'open' };
    if (p.status === 'in_progress') return { text: t.companion.now, tone: 'now' };
    if (i === next) return { text: t.companion.next, tone: 'next' };
    return p.at ? { text: t.companion.asked(p.at), tone: 'asked' } : null;
  });
}

/** The card's time: "12:41 · 2 min ago" (by the minute, the hour, the day); a final one "final · 13:02". */
export function catchUpWhen(at: number, now: number, final: boolean): string {
  return final ? t.companion.final(clockTime(at)) : t.companion.when(clockTime(at), agoLower(at, now));
}

/** The card's source line: it reads the session's chat, and the project files it opened. */
export function catchUpSource(read: readonly string[]): string {
  return read.length ? t.companion.fromChatAnd(t.companion.files(read.length)) : t.companion.fromChat;
}

// --- Questions and answers (3 and 7) ------------------------------------------------------------

type AnswerItem = Extract<ThreadItem, { kind: 'answer' }>;

/**
 * The answer's header after "✦ Ask": the model, "read N files" (the trace folded; nothing when it read only the chat,
 * which the read list can't tell), and Stopped for one stopped midway.
 */
export function answerMeta(a: Pick<AnswerItem, 'model' | 'read' | 'stopped'>): string[] {
  const out = [MODEL_LABEL[a.model]];
  if (a.read.length) out.push(t.companion.read(a.read.length));
  if (a.stopped) out.push(t.companion.stopped);
  return out;
}

/** The verdict's meter: one segment per step up to ten, then filled in proportion (never empty once begun, never full before the end). */
export function meterOf(p: { n: number; m: number }): { total: number; filled: number } {
  if (p.m <= 10) return { total: p.m, filled: p.n };
  const filled = Math.round((p.n / p.m) * 10);
  return { total: 10, filled: p.n > 0 && p.n < p.m ? Math.min(9, Math.max(1, filled)) : filled };
}

/** The terminals whose open Ask has been on screen in this window since it opened. */
const entered = new Set<string>();

/**
 * True the first time a terminal's open Ask is on screen: it enters (slides in, its items with it). Shown again — its
 * tab back in front, a split or an unsplit moving it to another pane — it is already there: no entrance.
 */
export function firstEntrance(terminalId: string): boolean {
  if (entered.has(terminalId)) return false;
  entered.add(terminalId);
  return true;
}

/** Where its thread was scrolled up to (null: following the bottom), so a panel shown again keeps its place. */
const scrolled = new Map<string, number | null>();

export function keepScroll(terminalId: string, top: number | null): void {
  scrolled.set(terminalId, top);
}

/** The thread's kept scroll position; null: at the bottom (or never scrolled). */
export function keptScroll(terminalId: string): number | null {
  return scrolled.get(terminalId) ?? null;
}

/** Its Ask closed (or its terminal gone): the next open enters again, at the bottom. */
export function forgetEntrance(terminalId: string): void {
  entered.delete(terminalId);
  scrolled.delete(terminalId);
}

/**
 * Use as prompt: the answer's Markdown, its verdict line left out (a chip, not words for Claude). A leading
 * `!` or `/` gets a space before it: sent as written, it would be Claude Code's bash mode or a slash command.
 */
export function promptText(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length > 0 && lines[0]!.trim() === '') lines.shift();
  if (parseAnswer(lines[0] ?? '')[0]?.k === 'verdict') lines.shift();
  const text = lines.join('\n').trim();
  return text.startsWith('!') || text.startsWith('/') ? ` ${text}` : text;
}

const DETAIL_OPEN = /^:::detail(?:\s+.*)?$/;
const VERDICT_WORD = 'Verdict:';

/**
 * The streamed text as it is drawn while it arrives: a Detail still being written is drawn as its box, and a verdict
 * line waits for its end (a half verdict would show as text, then jump into a chip).
 */
export function liveMarkdown(text: string): string {
  const head = text.trimStart();
  if (!head.includes('\n') && (head.startsWith(VERDICT_WORD) || (head.length > 0 && VERDICT_WORD.startsWith(head)))) return '';
  let open = false;
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!open && DETAIL_OPEN.test(s)) open = true;
    else if (open && s === ':::') open = false;
  }
  return open ? `${text}\n:::` : text;
}

/** The step it is on, in the present tense: "Read src/a.ts" → "Reading src/a.ts". */
export function traceNow(line: string): string {
  return line.replace(/^Read\b/, 'Reading').replace(/^Searched\b/, 'Searching').replace(/^Listed\b/, 'Listing');
}

/** The trace: earlier steps done; the last one current until text arrives after it. */
export function traceRows(run: Pick<RunView, 'trace' | 'traceAt' | 'text'>): { text: string; now: boolean }[] {
  const last = run.trace.length - 1;
  const reading = run.text.length === run.traceAt;
  return run.trace.map((text, i) => (i === last && reading ? { text: traceNow(text), now: true } : { text, now: false }));
}

/**
 * The thread's runs on their way: by the question they follow (it is in the thread, unanswered: running, or waiting for
 * a free slot), and the questions still held behind the current answer (not in the thread yet: their text, kept by this
 * window). A run whose answer already landed (its end is on its way) shows nothing more; Catch me up has its own row.
 */
/**
 * One session's live runs and their waiting questions' texts, the same RunView objects as the store's: a thread view
 * selecting these shallowly renders again for its own runs only, never for another session's streamed delta.
 */
export function sessionRuns(runs: Record<string, RunView>, texts: Record<string, string>, sessionId: string): { runs: Record<string, RunView>; texts: Record<string, string> } {
  const mine: Record<string, RunView> = {};
  const waiting: Record<string, string> = {};
  for (const [id, r] of Object.entries(runs)) {
    if (r.sessionId !== sessionId) continue;
    mine[id] = r;
    if (texts[id] !== undefined) waiting[id] = texts[id]!;
  }
  return { runs: mine, texts: waiting };
}

export function liveRuns(thread: Thread | null, runs: Record<string, RunView>, texts: Record<string, string>, sessionId: string): { byQuestion: Record<string, RunView>; held: { runId: string; text: string }[] } {
  const asked = new Set<string>();
  const settled = new Set<string>();
  for (const i of thread?.items ?? []) {
    if (i.kind === 'question') asked.add(i.id);
    else if (i.kind === 'answer' || (i.kind === 'error' && i.questionId)) settled.add(i.questionId!);
  }
  const byQuestion: Record<string, RunView> = {};
  const held: { run: RunView; text: string }[] = [];
  for (const r of Object.values(runs)) {
    if (r.sessionId !== sessionId || r.questionId === null || settled.has(r.questionId)) continue;
    if (asked.has(r.questionId)) byQuestion[r.questionId] = r;
    else if (texts[r.runId] !== undefined) held.push({ run: r, text: texts[r.runId]! });
  }
  held.sort((a, b) => a.run.startedAt - b.run.startedAt);
  return { byQuestion, held: held.map((h) => ({ runId: h.run.runId, text: h.text })) };
}

const ANNOUNCE_MAX = 200;

/** What a screen reader hears when an answer lands: its verdict and its opening text, no Markdown, cut short. */
export function plainAnswer(markdown: string): string {
  const blocks = parseAnswer(markdown);
  const parts: string[] = [];
  const verdict = blocks[0]?.k === 'verdict' ? blocks[0] : null;
  if (verdict) parts.push(`${verdict.label.trim().replace(/[.!?]?$/, '.')}`);
  const first = blocks.find((b) => b.k === 'para' || b.k === 'list' || b.k === 'detail');
  if (first?.k === 'para') parts.push(plainText(first.inline));
  else if (first?.k === 'list' && first.items[0]) parts.push(plainText(first.items[0]));
  else if (first?.k === 'detail') parts.push(first.title);
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  return text.length > ANNOUNCE_MAX ? `${text.slice(0, ANNOUNCE_MAX)}…` : text;
}
