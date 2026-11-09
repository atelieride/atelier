// Start a Claude session from a task: the task's detail first (a task gone from the source starts
// nothing), then a session named after it, started like New Session and linked to the task, and — once Claude is
// ready — the prompt typed the way a paste is (one bracketed paste, the same filters), sent only with ⌘Enter.
import type { ConnectorId, TaskDetail, TaskGetResult, TaskSummary } from '@shared/tasks';
import { t } from './i18n/en';
import { useApp } from './store';
import { newSessionIn } from './launch';
import { buildTaskPrompt, taskSessionName } from '@shared/task-prompt';
import { taskToastName } from './task-view';
import { CONNECTOR_NAMES } from './connectors-view';
import { sendAvailability } from './comments';
import { remoteReason } from './remote';
import { taskMarkdown } from './task-copy';
import { pasteSequence } from './terminal/paste';
import { focusTerminal, isBracketed, lastOutputAt } from './terminal/focus';
import { copyText } from './clipboard';
import { releaseInput, sendInput } from './terminal/drafts';

/** How often the new session is checked while Claude starts, and how long it may take before Atelier gives up. */
export const READY_POLL_MS = 150;
export const READY_TIMEOUT_MS = 45_000;
/**
 * ⌘Enter: the Enter goes as its own write once the paste has been taken in. Claude Code handles a long paste
 * asynchronously and an Enter in the same read can be lost, so: never before ENTER_FLOOR_MS, then as soon as the
 * terminal's output has been quiet for ENTER_QUIET_MS (Claude has drawn the paste), and at ENTER_CAP_MS at the latest.
 */
export const ENTER_FLOOR_MS = 250;
export const ENTER_QUIET_MS = 150;
export const ENTER_CAP_MS = 2000;
const ENTER_POLL_MS = 50;
/** Fetching the task's detail: a notice only when it takes longer than this. */
const SLOW_FETCH_MS = 400;

export interface StartOptions {
  /** ⌘Enter: Enter after the prompt. */
  send: boolean;
  /** ⌥Enter: the session opens to the side (split view). */
  side: boolean;
  /** The Claude account picked in the task's account step; absent: the one set for new sessions. */
  account?: string;
}

/**
 * The task lists from main (never blocks; main refreshes a list older than 60 s in the background and bumps
 * tasksVersion, which asks again). Called at start, when the palette opens and when tasksKey changes.
 */
export function loadTaskLists(): void {
  void window.atelier.tasks.list().then((lists) => useApp.getState().setTaskLists(lists)).catch(() => {});
}

/** Tasks being fetched right now: a second Enter on the same one starts nothing more. */
const inFlight = new Set<string>();

const nameOf = (source: ConnectorId) => useApp.getState().connectors.find((c) => c.id === source)?.name ?? CONNECTOR_NAMES[source];

function failure(reason: Exclude<TaskGetResult, { ok: true }>['reason'], name: string): string {
  switch (reason) {
    case 'gone': return t.tasks.gone(name);
    case 'reconnect': return t.conn.reasons.signedOut(name);
    case 'unavailable': return t.conn.unavailable(name);
    case 'not-connected': return t.tasks.notConnected(name);
    default: return t.tasks.getFailed(name);
  }
}

/**
 * The task's detail from its source, or null once the user has been told why: a notice while it takes long, a Retry
 * (running `again`) when offline; a task the source says is gone leaves the list.
 */
async function fetchTask(source: ConnectorId, task: TaskSummary, again: () => void): Promise<TaskDetail | null> {
  const name = nameOf(source);
  const fetching = t.tasks.fetching(taskToastName(task.displayId, task.title));
  const slow = setTimeout(() => useApp.getState().showToast(fetching, undefined, 'info'), SLOW_FETCH_MS);
  try {
    const r = await window.atelier.tasks.get(source, task.id).catch((): TaskGetResult => ({ ok: false, reason: 'failed' }));
    clearTimeout(slow);
    if (useApp.getState().toast?.text === fetching) useApp.getState().showToast(null);
    if (r.ok) return r.task;
    // Offline (the reply says so, or the connector is): why, and a Retry that does it as asked once the source answers.
    // A task the source itself says is gone stays gone.
    const offline = r.reason === 'offline' || (r.reason !== 'gone' && useApp.getState().connectors.find((c) => c.id === source)?.status === 'offline');
    if (offline) {
      useApp.getState().showToast(t.tasks.offline(name), { label: t.tasks.retry, run: again });
      return null;
    }
    useApp.getState().showToast(failure(r.reason, name));
    // Its row leaves the palette with the next list.
    if (r.reason === 'gone') void window.atelier.connectors.refresh(source).catch(() => {});
    return null;
  } finally {
    clearTimeout(slow);
  }
}

export async function startSessionFromTask(source: ConnectorId, task: TaskSummary, opts: StartOptions): Promise<void> {
  const key = `${source}:${task.id}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try {
    const detail = await fetchTask(source, task, () => void startSessionFromTask(source, task, opts));
    if (!detail) return;
    const prompt = buildTaskPrompt(nameOf(source), detail);
    const info = await newSessionIn(taskSessionName(detail.displayId, detail.title), undefined, { side: opts.side, ...(opts.account ? { account: opts.account } : {}) });
    if (!info) return;
    useApp.getState().linkTask(info.id, { source, taskId: detail.id, displayId: detail.displayId, title: detail.title, url: detail.url });
    typeWhenReady(info.id, prompt, opts.send, taskToastName(detail.displayId, detail.title));
  } finally {
    inFlight.delete(key);
  }
}

/** Why the task's prompt can't be typed into that session now (closed, Claude working or asking), or null. */
export function pasteReason(id: string): string | null {
  const term = useApp.getState().terminals.find((x) => x.id === id);
  if (!term?.session) return t.tasks.sessionClosed;
  return remoteReason(sendAvailability(term, isBracketed(id)));
}

/**
 * "Paste into Session": the same prompt as a new session's, typed into a session already open —
 * only while Claude waits for input (the rule of Send Review) — then that session is selected with the keyboard;
 * ⌘ also sends it. The session takes the task chip unless it already has one.
 */
export async function pasteTaskInto(source: ConnectorId, task: TaskSummary, id: string, opts: { send: boolean }): Promise<void> {
  const early = pasteReason(id);
  if (early) { useApp.getState().showToast(early); return; }
  const detail = await fetchTask(source, task, () => void pasteTaskInto(source, task, id, opts));
  if (!detail) return;
  // The fetch took a moment: the session may have started working or closed meanwhile.
  const why = pasteReason(id);
  if (why) { useApp.getState().showToast(why, { label: t.tasks.copyPrompt, run: () => void copyText(buildTaskPrompt(nameOf(source), detail)) }); return; }
  const st = useApp.getState();
  const term = st.terminals.find((x) => x.id === id)!;
  // In pieces under the terminal input limit: still one paste, the bytes arrive in order.
  for (const part of pasteSequence(buildTaskPrompt(nameOf(source), detail).trimEnd(), true, 256 * 1024)) sendInput(id, part);
  if (opts.send) enterWhenSettled(id);
  if (!st.taskLinks[id]) st.linkTask(id, { source, taskId: detail.id, displayId: detail.displayId, title: detail.title, url: detail.url });
  st.setActivity('sessions', { keepHidden: true });
  st.select(id);
  if (!opts.send) st.showToast(t.tasks.typedInto(taskToastName(detail.displayId, detail.title), term.title), undefined, 'info');
  // After the palette that ran it has closed (it gives focus back to where it was).
  setTimeout(() => focusTerminal(id), 0);
}

/** "Copy Task": the task as Markdown (task-copy.ts), its description included. */
export async function copyTask(source: ConnectorId, task: TaskSummary): Promise<void> {
  const detail = await fetchTask(source, task, () => void copyTask(source, task));
  if (detail && await copyText(taskMarkdown(detail))) useApp.getState().showToast(t.tasks.copiedMarkdown(taskToastName(detail.displayId, detail.title)), undefined, 'info');
}

/** "Copy Task ID": what people call it (the custom id when there is one). */
export async function copyTaskId(task: TaskSummary): Promise<void> {
  if (await copyText(task.displayId)) useApp.getState().showToast(t.tasks.copied(task.displayId), undefined, 'info');
}

/**
 * The Enter after a typed prompt (see ENTER_FLOOR_MS); nothing if the terminal is gone meanwhile. Also the Session
 * panel's commands (session-panel.ts).
 */
export function enterWhenSettled(id: string, done: () => void = () => {}): void {
  const pasted = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    if (!useApp.getState().terminals.some((x) => x.id === id)) { clearInterval(timer); done(); return; }
    if (now - pasted < ENTER_FLOOR_MS) return;
    if (now - lastOutputAt(id) < ENTER_QUIET_MS && now - pasted < ENTER_CAP_MS) return;
    clearInterval(timer);
    // Through the draft follower: this Enter sends what is in the prompt. Then what the user typed meanwhile, if it was
    // held (a Session panel command).
    releaseInput(id, '\r');
    done();
  }, ENTER_POLL_MS);
}

/**
 * Waits for Claude's prompt in that terminal (its session started, free, Claude in front with bracketed paste on — the
 * rule of sending line comments), twice in a row, then types the prompt as one paste; ⌘Enter adds the Enter. A session
 * closed meanwhile ends the wait quietly; one that never gets ready says so and offers the prompt to copy.
 */
function typeWhenReady(id: string, prompt: string, send: boolean, name: string): void {
  typeWhenReadyAs(id, prompt, send, t.tasks.typed(name));
}

/** The same wait, for any prompt (Docker's "Ask in a New Session"): `typed` is the toast once it is in. */
export function typeWhenReadyAs(id: string, prompt: string, send: boolean, typed: string): void {
  const started = Date.now();
  let seen = false;
  let readyOnce = false;
  const timer = setInterval(() => {
    const st = useApp.getState();
    const term = st.terminals.find((x) => x.id === id);
    if (term) seen = true;
    else if (seen || Date.now() - started > READY_TIMEOUT_MS) { clearInterval(timer); return; }
    const ready = !!term && sendAvailability(term, isBracketed(id)) === 'ok';
    if (ready && readyOnce) {
      clearInterval(timer);
      // In pieces under the terminal input limit: still one paste, the bytes arrive in order.
      for (const part of pasteSequence(prompt.trimEnd(), true, 256 * 1024)) sendInput(id, part);
      if (send) enterWhenSettled(id);
      else st.showToast(typed, undefined, 'info');
      if (st.selectedId === id && st.activeTab === 'term' && !st.paletteOpen && !st.settingsOpen) setTimeout(() => focusTerminal(id), 0);
      return;
    }
    readyOnce = ready;
    if (Date.now() - started > READY_TIMEOUT_MS) {
      clearInterval(timer);
      st.showToast(t.tasks.notTyped, { label: t.tasks.copyPrompt, run: () => void copyText(prompt) });
    }
  }, READY_POLL_MS);
}
