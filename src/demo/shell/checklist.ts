import type { MenuCommand } from '@shared/api';
import type { DemoView } from '../protocol';

// "Things to try": thirteen things the app does best, each ticking itself when the visitor does it. The demo
// watches from outside, never instrumenting the app: the commands the shell sends (menus, accelerators), the calls the
// renderer makes to the bridge (observe.ts), the sessions' and containers' states the engine pushes, and what appears on
// screen (the palette, a split, a JSON view). Every item is also a "show me" button: actionFor says what a click does
// (the command its shortcut sends, or the event that opens the right place), and the same detection then ticks it.
// Pure: the shell feeds it signals, draws the result and runs the actions.

export type ChecklistId = 'jump' | 'approve' | 'changes' | 'ask' | 'commit' | 'search' | 'split' | 'workspaces' | 'docker' | 'redis' | 'databases' | 'background' | 'json';

/** `{…}` is a keycap, backticks are code. */
export const CHECKLIST: readonly { id: ChecklistId; text: string }[] = [
  { id: 'jump', text: '{⌘J}: jump to the session waiting for you' },
  { id: 'approve', text: 'Answer it (press {1}) and watch it work' },
  { id: 'changes', text: 'See what it changed (Changes, {⌘⇧M})' },
  { id: 'ask', text: '{⌘I}: ask a session where it is' },
  { id: 'commit', text: '{⌥⌘K}: stage a file, ✦ writes its commit' },
  { id: 'search', text: '{⌘K}: find anything' },
  { id: 'split', text: '{⌘\\}: put two things side by side' },
  { id: 'workspaces', text: 'Turn on workspaces (View), then switch to `Billing`' },
  { id: 'docker', text: 'Docker ({⌃⇧D}): see why `worker` stopped' },
  { id: 'redis', text: 'Redis ({⌃⇧R}): ask Claude why a job failed' },
  { id: 'databases', text: 'Databases ({⌃⇧B}): open a JSON payload as a tree' },
  { id: 'background', text: '{⌘⌥B}: what a session runs in the background' },
  { id: 'json', text: 'Open `package.json` as a tree ({⇧⌘V})' }
];

export type Segment = { kind: 'text' | 'kbd' | 'code'; text: string };

export function segments(text: string): Segment[] {
  const out: Segment[] = [];
  for (const m of text.matchAll(/\{([^}]+)\}|`([^`]+)`|([^{`]+)/g)) {
    if (m[1] !== undefined) out.push({ kind: 'kbd', text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: 'code', text: m[2] });
    else out.push({ kind: 'text', text: m[3]! });
  }
  return out;
}

/** What the world says before anything happens. */
export interface ChecklistContext {
  /** Terminals whose session waits for the visitor at startup. */
  waiting: ReadonlySet<string>;
  /** Containers that had stopped with an error at startup. */
  stopped: ReadonlySet<string>;
  /** Absolute paths the sessions changed (their diff is "what it changed"). */
  changed: ReadonlySet<string>;
  /** The container the Docker beat stops (`worker`), null in a world without it. */
  worker: string | null;
  /** The queue whose failed jobs the Redis item opens (`email-queue`), null when no queue has any. */
  failedQueue: string | null;
}

export interface ChecklistState {
  done: ReadonlySet<ChecklistId>;
  /** Terminals waiting now (a session that waits later and is approved counts too). */
  waiting: ReadonlySet<string>;
  /** Containers stopped with an error now (the worker, once its crash has played). */
  stopped: ReadonlySet<string>;
}

type TermLike = { id: string; session: { state: string } | null };
type ContainerLike = { id: string; state: string; exitCode?: number | null };
export type ChecklistSignal =
  | { kind: 'command'; command: MenuCommand }
  | { kind: 'terminals'; list: readonly TermLike[] }
  | { kind: 'containers'; list: readonly ContainerLike[] }
  | { kind: 'call'; name: string; args: readonly unknown[] }
  | { kind: 'dom'; what: 'palette' | 'split' | 'json-tree' | 'db-json' };

interface WorldLike {
  project: { root: string };
  head: Record<string, string>;
  files: Record<string, string>;
  sessions: readonly { terminal: TermLike }[];
  docker: { snapshot: { containers: readonly ContainerLike[] }; crash?: { container: { id: string } } };
  redis?: { queues: { infos: readonly { id: string; name: string; counts: { failed?: number | null } }[] } | null };
}

const stoppedOf = (list: readonly ContainerLike[]) => new Set(list.filter((c) => c.state !== 'running' && c.exitCode != null && c.exitCode !== 0).map((c) => c.id));

export function checklistContext(w: WorldLike): ChecklistContext {
  const rels = new Set([...Object.keys(w.head), ...Object.keys(w.files)]);
  const queues = w.redis?.queues?.infos ?? [];
  return {
    waiting: new Set(w.sessions.filter((s) => s.terminal.session?.state === 'waiting').map((s) => s.terminal.id)),
    stopped: stoppedOf(w.docker.snapshot.containers),
    changed: new Set([...rels].filter((r) => w.head[r] !== w.files[r]).map((r) => `${w.project.root}/${r}`)),
    worker: w.docker.crash?.container.id ?? null,
    failedQueue: queues.find((q) => (q.counts.failed ?? 0) > 0)?.id ?? null
  };
}

export const initialChecklist = (ctx: ChecklistContext): ChecklistState => ({ done: new Set(), waiting: new Set(ctx.waiting), stopped: new Set(ctx.stopped) });

// Docker is not here: opening it is not seeing why the worker stopped (the item ticks on a look into it, below).
const BY_COMMAND: Partial<Record<MenuCommand, ChecklistId>> = {
  'next-attention': 'jump', 'toggle-changes': 'changes', 'review-session': 'changes', 'review-all': 'changes',
  'open-palette': 'search', 'split-right': 'split', 'show-background': 'background'
};
// jobPrompt / jobsPrompt (shared/redis-queues.ts): "A … job failed in queue "q"…", "3 failed jobs in … queue "q"…".
const JOB_PROMPT = /\bjob failed in queue "|\bfailed jobs in [^\n]*queue "/;
const DOCKER_LOOK = new Set(['docker.logs', 'docker.inspect', 'docker.tail']);

function ticked(sig: ChecklistSignal, s: ChecklistState, ctx: ChecklistContext): ChecklistId | null {
  switch (sig.kind) {
    case 'command': return BY_COMMAND[sig.command] ?? null;
    // A Databases JSON value open in the JSON view (the inspector's, or a cell's double click): only the screen says so.
    case 'dom': return sig.what === 'palette' ? 'search' : sig.what === 'json-tree' ? 'json' : sig.what === 'db-json' ? 'databases' : 'split';
    case 'terminals': case 'containers': return null;
    case 'call': {
      const [a, b] = sig.args;
      if (sig.name === 'git.head') return typeof a === 'string' && ctx.changed.has(a) ? 'changes' : null;
      if (DOCKER_LOOK.has(sig.name)) return typeof a === 'string' && s.stopped.has(a) ? 'docker' : null;
      if (sig.name === 'docker.watchLogs') return Array.isArray(a) && a.some((id) => s.stopped.has(id as string)) ? 'docker' : null;
      if (sig.name === 'terminals.input') return typeof b === 'string' && JOB_PROMPT.test(b) ? 'redis' : null;
      if (sig.name === 'background.watch') return 'background';
      // ✦ wrote a message (the drawer's sparkle, ⌥⌘M, Commit <session>'s Work…): committing itself asks to download.
      if (sig.name === 'git.message') return 'commit';
      // Ask answered something: a Catch me up (on open, its button, the refresh) or a question (typed, a chip, Why?).
      if (sig.name === 'companion.catchUp' || sig.name === 'companion.ask') return 'ask';
      // The page's menu state (as it tells main): workspaces on with another one than the first in front.
      if (sig.name === 'menuState') { const ws = (a as { workspaces?: { active: number } } | undefined)?.workspaces; return ws && ws.active !== 0 ? 'workspaces' : null; }
      return null;
    }
  }
}

export function reduceChecklist(s: ChecklistState, sig: ChecklistSignal, ctx: ChecklistContext): ChecklistState {
  if (sig.kind === 'terminals') {
    const waiting = new Set<string>();
    let approved = false;
    for (const t of sig.list) {
      const st = t.session?.state;
      if (st === 'waiting') waiting.add(t.id);
      else if (st === 'running' && s.waiting.has(t.id)) approved = true;
    }
    const same = waiting.size === s.waiting.size && [...waiting].every((id) => s.waiting.has(id));
    if (!approved && same) return s;
    return { ...s, done: approved && !s.done.has('approve') ? new Set([...s.done, 'approve']) : s.done, waiting };
  }
  if (sig.kind === 'containers') {
    const stopped = stoppedOf(sig.list);
    return stopped.size === s.stopped.size && [...stopped].every((id) => s.stopped.has(id)) ? s : { ...s, stopped };
  }
  const id = ticked(sig, s, ctx);
  if (!id || s.done.has(id)) return s;
  return { ...s, done: new Set([...s.done, id]) };
}

export const progress = (s: ChecklistState) => ({ done: s.done.size, total: CHECKLIST.length });

/** What the screen shows when an item is clicked (the shell reads it from the DOM). */
export interface ActionScreen {
  /** Two panes or more. */
  split: boolean;
  /** The Changes panel is open. */
  changes: boolean;
  /** The session in front waits for the visitor. */
  selectedWaiting: boolean;
  /** A JSON tree on screen (Tree or Split of a JSON file). */
  jsonTree: boolean;
  /** A Databases value open in the JSON view. */
  dbJson: boolean;
  /** Workspaces are on (the sidebar shows them). */
  workspaces: boolean;
}

/**
 * What a click on an item does ("show me"): the command its shortcut sends, or the event that opens the right place,
 * and a one-line hint when the last step is the visitor's. The item ticks through the usual detection, never here.
 * - `command`: sent as the menu sends it (a visitor's command: it counts, as the shortcut would);
 * - `docker`: the container's Inspect ("Why it stopped", on.dockerOpen); `crash`: the worker still runs, so its crash
 *   (the Docker beat) is brought forward and plays while the visitor watches;
 * - `redis`: that queue's failed jobs (on.redisOpen); asking Claude stays the visitor's step;
 * - `hint`: nothing to open, only the next key to press;
 * - `view`: a view of the demo itself (open-view.ts), as a feature row's "Try it" opens it.
 * null: the screen already shows it (a split, a JSON tree).
 */
export type ChecklistAction =
  | { kind: 'command'; command: MenuCommand; hint?: string }
  | { kind: 'view'; view: DemoView; hint?: string }
  | { kind: 'docker'; id: string; crash: boolean; hint?: string }
  | { kind: 'redis'; queue: string; hint?: string }
  | { kind: 'hint'; hint: string };

const ANSWER_HINT = 'Press 1 to answer it, then watch it work.';
const COMMIT_HINT = 'Tick a file to stage it, then press ✦ to write its message.';
const WORKSPACES_HINT = 'Each workspace keeps its own tabs. Click Billing in the sidebar to bring its session forward.';
const ASK_HINT = 'Ask reads it without interrupting it. Press Catch me up, or try a suggested question.';
const DATABASES_HINT = 'Open webhook_events, then double-click a payload.';

export function actionFor(id: ChecklistId, s: ChecklistState, ctx: ChecklistContext, screen: ActionScreen): ChecklistAction | null {
  switch (id) {
    case 'jump': return { kind: 'command', command: 'next-attention' };
    case 'approve':
      if (screen.selectedWaiting) return { kind: 'hint', hint: ANSWER_HINT };
      return s.waiting.size ? { kind: 'command', command: 'next-attention', hint: ANSWER_HINT } : { kind: 'command', command: 'next-attention' };
    // ⌘⇧M toggles: with the panel open already, the review of every change shows the diffs instead of closing it.
    case 'changes': return { kind: 'command', command: screen.changes ? 'review-all' : 'toggle-changes' };
    // Ask open on a session at work (open-view.ts: never toggled shut), on its empty state (Catch me up when opened is
    // off by default, as in the app): Catch me up or a question ticks it.
    case 'ask': return { kind: 'view', view: 'demo:ask', hint: ASK_HINT };
    // Git › Commit…: Changes with the drawer open; staging and ✦ stay the visitor's steps.
    case 'commit': return { kind: 'command', command: 'git-commit', hint: COMMIT_HINT };
    case 'search': return { kind: 'command', command: 'open-palette' };
    case 'split': return screen.split ? null : { kind: 'command', command: 'split-right' };
    // View › Toggle Workspaces for This Project when they are off; switching stays the visitor's step.
    case 'workspaces': return screen.workspaces ? { kind: 'hint', hint: WORKSPACES_HINT } : { kind: 'command', command: 'toggle-workspaces', hint: WORKSPACES_HINT };
    case 'docker':
      if (!ctx.worker) return { kind: 'command', command: 'view-docker' };
      return s.stopped.has(ctx.worker) ? { kind: 'docker', id: ctx.worker, crash: false } : { kind: 'docker', id: ctx.worker, crash: true, hint: 'The worker is about to stop. Watch it here.' };
    case 'redis':
      return ctx.failedQueue ? { kind: 'redis', queue: ctx.failedQueue, hint: 'Pick a job, then Ask Claude Why It Failed.' } : { kind: 'command', command: 'view-redis' };
    // The view (it connects when shown); opening a table and a payload stays the visitor's step.
    case 'databases': return screen.dbJson ? null : { kind: 'command', command: 'view-databases', hint: DATABASES_HINT };
    case 'background': return { kind: 'command', command: 'show-background' };
    // package.json with its tree beside it (Split Preview: opening it again never toggles it back to the source).
    case 'json': return screen.jsonTree ? null : { kind: 'view', view: 'demo:json' };
  }
}
