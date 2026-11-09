// What Ask's script says about a session now: its phase, from the state the
// demo knows (the session's state and activity, the working tree, the visitor's prompts); its Catch me up as the app's
// CatchUp; the answer to a question as the panel asks it, with what the run reads. Pure: the bridge (bridge/companion.ts)
// plays the result on the demo's clock. This module and the script (world/ask.ts) are one chunk, loaded on Ask's first
// use (ASK_PLAYER): neither is part of the demo's first paint.
import type { CatchPoint, CatchUp } from '@shared/companion/types';
import { CATCHUP_LIMITS } from '@shared/companion/catchup';
import type { SessionState } from '@shared/session';
import { waitTarget } from '@shared/session-view';
import { t } from '../../renderer/i18n/en';
import { clockTime } from '../../renderer/work-view';
import { ASK_SCRIPT, type AskAnswer, type AskPhase, type AskPoint, type AskScript, type AskSession, type AskWhen, type VisitorState } from '../world/ask';
import type { ScenarioName } from '../world/scenarios';

/** What the demo knows of a session when Ask reads it. */
export interface AskFacts {
  /** The scripted session it is (null: a session the visitor started). */
  scenario: ScenarioName | null;
  /** Its state now; null once Claude is gone from the terminal. */
  state: SessionState | null;
  /** atelierd's activity line ("waiting: Bash npm test -- auth"). */
  activity: string | null;
  /** The working tree (rel → text). */
  files: Readonly<Record<string, string>>;
  /** The prompts the visitor sent it, in order, each with how its turn ended once it has. */
  prompts: readonly { text: string; at: number; outcome?: 'finished' | 'interrupted' }[];
  /**
   * How its scripted turn ended (finished, or interrupted with Esc) and what its terminal had printed by then; null
   * while that turn goes on (or it had none).
   */
  scripted: { interrupted: boolean; output: string } | null;
  /** When its conversation last had a message: a done point's time. */
  lastMessageAt: number | null;
  now: number;
}

/** An answer as a run plays it: its Markdown, what it read and searched, and its trace lines in order. */
export interface AskReply { md: string; read: string[]; search: string[]; trace: string[] }

const CHAT = 'Read the chat';
const FACTS = 'Read the session facts';

/** A question as the panel asks it, compared without case, spacing, curly quotes or its final mark. */
export function questionKey(q: string): string {
  return q.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[\s.?!…]+$/u, '');
}

// The panel's own questions (the app's words): the chips, the empty state's starters and Help me decide.
const STATUS = new Set([questionKey(t.companion.whatsLeft), questionKey(t.companion.starters[1] ?? '')]);
const DOING = questionKey(t.companion.starters[0] ?? '');
const PLAN = questionKey(t.companion.starters[2] ?? '');
const DECIDE = questionKey(t.companion.helpDecideQuestion('\u0000').split('\u0000')[0]!);

const cut = (s: string, max: number) => ([...s].length <= max ? s : `${[...s].slice(0, max - 1).join('')}…`);

function holds(w: AskWhen, f: AskFacts, state: SessionState): boolean {
  if (w.states && !w.states.includes(state)) return false;
  if (w.waits !== undefined && !(f.activity ?? '').includes(w.waits)) return false;
  if (w.interrupted !== undefined && (f.scripted?.interrupted ?? false) !== w.interrupted) return false;
  if (w.printed !== undefined && !(f.scripted?.output ?? '').includes(w.printed)) return false;
  if (w.file) {
    const text = f.files[w.file.rel] ?? '';
    if (w.file.has !== undefined && !text.includes(w.file.has)) return false;
    if (w.file.lacks !== undefined && text.includes(w.file.lacks)) return false;
  }
  return true;
}

/**
 * The phase the session is in: the first whose condition holds, the last one by default. Once its scripted turn has
 * ended, its phases are tried in the state that turn ended in (idle after Esc, done after its Stop), whatever the
 * visitor typed since; a session prompted with no record of it (none in the demo) counts as done.
 */
export function phaseFor(session: AskSession, f: AskFacts): AskPhase {
  const state: SessionState = f.scripted ? (f.scripted.interrupted ? 'idle' : 'done') : f.prompts.length ? 'done' : f.state ?? 'done';
  return session.phases.find((p) => !p.when || holds(p.when, f, state)) ?? session.phases.at(-1)!;
}

/** Where the visitor's latest prompt is: how its turn ended once it has (Esc: stopped), else the session's state. */
function visitorState(f: AskFacts): VisitorState {
  const outcome = f.prompts.at(-1)?.outcome;
  if (outcome === 'interrupted') return 'stopped';
  if (outcome === 'finished') return 'done';
  return f.state === 'waiting' ? 'waiting' : f.state === 'running' ? 'working' : f.state === 'idle' ? 'stopped' : 'done';
}
/**
 * A template filled in: {prompt}, the visitor's latest prompt; {wait}, what it waits for as atelierd names it ("Edit
 * tokens.ts"), its " ({wait})" gone when it names nothing. Replaced by functions: the visitor's text is data, never a
 * replacement pattern ($&, $$).
 */
const fill = (s: string, f: AskFacts) => {
  const wait = waitTarget(f.activity);
  const prompt = f.prompts.at(-1)?.text ?? '';
  return s.replace(/\{prompt\}/g, () => prompt).replace(/ ?\(\{wait\}\)/g, () => (wait ? ` (${wait})` : ''));
};

function point(p: AskPoint, f: AskFacts): Omit<CatchPoint, 'n'> {
  return { text: cut(p.text, CATCHUP_LIMITS.pointText), status: p.status, at: p.at === 'turn' ? clockTime(f.lastMessageAt ?? f.now) : null, note: p.note ? cut(p.note, CATCHUP_LIMITS.note) : null };
}

/** A visitor's prompt whose turn Esc ended: its point's note. */
const STOPPED = 'Stopped: you interrupted it';

/**
 * The visitor's prompts as points: done once finished, Stopped (unclear) when Esc ended its turn, the latest one in
 * progress while the session waits or works on it.
 */
function visitorPoints(f: AskFacts): Omit<CatchPoint, 'n'>[] {
  const now = visitorState(f);
  return f.prompts.map((p, i) => {
    const last = i === f.prompts.length - 1;
    const text = cut(p.text, CATCHUP_LIMITS.pointText);
    const ended = p.outcome ?? (last ? null : 'finished');
    if (ended === 'interrupted' || (last && now === 'stopped')) return { text, status: 'unclear', at: null, note: STOPPED };
    if (last && (now === 'waiting' || now === 'working')) {
      const wait = waitTarget(f.activity);
      return { text, status: 'in_progress', at: null, note: now !== 'waiting' ? null : wait ? cut(`Waiting for you: ${wait}`, CATCHUP_LIMITS.note) : 'Waiting for your answer' };
    }
    return { text, status: 'done', at: last ? clockTime(f.lastMessageAt ?? f.now) : null, note: null };
  });
}

/** The session's Catch me up: valid by the app's own limits; `final` (Claude has exited) adds what it left open. */
export function catchUpFor(script: AskScript, f: AskFacts, final: boolean): { data: CatchUp; read: string[]; trace: string[] } {
  const session = f.scenario ? script.sessions[f.scenario] : null;
  const visitor = f.prompts.length > 0;
  if (!session && !visitor) return { data: { points: [], where: script.nothingAsked.where, choices: [], leftOpen: null }, read: [], trace: [CHAT, FACTS] };
  const c = session ? phaseFor(session, f).catchUp : null;
  const points = [...(c?.points ?? []).map((p) => point(p, f)), ...visitorPoints(f)].map((p, i) => ({ n: i + 1, ...p })).slice(-CATCHUP_LIMITS.points);
  const read = [...(c?.read ?? [])];
  return {
    data: {
      points,
      where: visitor ? fill(script.visitor.where[visitorState(f)], f) : c!.where,
      choices: [...(c?.choices ?? [])],
      leftOpen: final && !visitor ? c?.leftOpen ?? null : null
    },
    read,
    trace: [CHAT, FACTS, ...read.map((r) => `Read ${r}`)]
  };
}

const lookup = (answers: Readonly<Record<string, AskAnswer>> | undefined, q: string): AskAnswer | undefined =>
  answers ? Object.entries(answers).find(([k]) => questionKey(k) === q)?.[1] : undefined;

/** The answer to `question` now: the panel's own questions by phase (or the visitor's prompt), then the session's, else the fallback. */
export function answerFor(script: AskScript, f: AskFacts, question: string): AskReply {
  const q = questionKey(question);
  const session = f.scenario ? script.sessions[f.scenario] : null;
  const phase = session ? phaseFor(session, f) : null;
  const visitor = f.prompts.length > 0;
  const forVisitor = (a: AskAnswer): AskAnswer => ({ ...a, md: fill(a.md, f) });
  let a: AskAnswer | undefined;
  if (q.startsWith(DECIDE)) a = f.state !== 'waiting' ? script.notAsking : visitor ? script.visitor.decide : phase?.decide ?? script.notAsking;
  else if (STATUS.has(q) || q === DOING) {
    a = visitor ? forVisitor(script.visitor.status[visitorState(f)]) : phase ? (q === DOING ? phase.doing : phase.status) : script.nothingAsked.status;
  } else if (q === PLAN) a = visitor ? script.visitor.plan : phase?.plan ?? script.nothingAsked.status;
  else a = lookup(phase?.answers, q) ?? lookup(session?.answers, q);
  a ??= script.fallback;
  const read = [...(a.read ?? [])];
  const search = [...(a.search ?? [])];
  return { md: a.md, read, search, trace: [CHAT, ...search.map((s) => `Searched the code for '${s}'`), ...read.map((r) => `Read ${r}`)] };
}

/** The script with what reads it: what the bridge loads, as one chunk, the first time Ask runs. */
export interface AskPlayer { script: AskScript; catchUpFor: typeof catchUpFor; answerFor: typeof answerFor }
export const ASK_PLAYER: AskPlayer = { script: ASK_SCRIPT, catchUpFor, answerFor };
