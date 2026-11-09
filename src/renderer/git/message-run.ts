// ✦ in the commit drawer, driven: asks main to write (main builds the input and runs
// claude), follows its ev:scmMessage stream into the store's gitWrite, stops it, and drops it when the drawer closes
// (moving to another repository keeps it for when the drawer is back). The field puts the text in (MessageField: one
// undo step). Commit all's ✦ Write All
// has its own runner (commit-all-run.ts); both listen to the same events and each keeps only its own ids.
import type { GitApi, MessageTweak, ScmMessageEvent } from '@shared/git-write';
import { t } from '../i18n/en';
import { useApp, type AppState } from '../store';
import { stagedKey, writeApplied, writeChunk, writeEdited, writeReady, writeStart, writeStopped } from './message';

const api = (): GitApi => window.atelier.git;
const st = () => useApp.getState();
const allowed = (s: AppState) => s.settings.gitActions === 'on' && s.settings.commitMessages !== 'off';

/** Bumped by every start and every drop: an answer from main for an older one is cancelled at once. */
let seq = 0;
/** Events for an id main hasn't answered yet (they can overtake the invoke's answer). */
let early: ScmMessageEvent[] = [];
let starting = 0;
let offEvents: (() => void) | null = null;
let offStore: (() => void) | null = null;

const cancel = (id: string) => { void api().messageCancel(id).catch(() => {}); };

/**
 * Listening while a run exists: its events, and the drawer closing (which drops it). The target moving to another
 * repository (staging there) keeps it: it goes on writing and lands in the field once the drawer is back on its
 * repository (the drawer shows only its target's run).
 */
function listen(): void {
  offEvents ??= window.atelier.on.scmMessage(onEvent);
  offStore ??= useApp.subscribe((s) => {
    const w = s.gitWrite;
    if (!w) { if (!starting) unlisten(); return; }
    if (!s.gitDrawer.open || !allowed(s)) drop();
  });
}

function unlisten(): void {
  offEvents?.(); offEvents = null;
  offStore?.(); offStore = null;
  early = [];
}

/** The run goes without a trace: cancelled in main if it writes, nothing put in the field. */
function drop(): void {
  const w = st().gitWrite;
  seq++;
  if (w?.phase === 'writing' && w.id) cancel(w.id);
  if (w) st().setGitWrite(null);
}

function failed(reason: string): void {
  st().setGitWrite(null);
  if (reason !== 'Stopped') st().showToast(t.git.write.failed(reason), undefined, 'info');
}

/**
 * Once this window's stage and unstage clicks in `root` reached git: a checkbox shows its click before git ran
 * (stage-intents.ts), and main reads the index for ✦ outside the write queue.
 */
export function clicksInGit(root: string): Promise<void> {
  const pending = () => st().gitStageIntents.some((i) => i.root === root && i.at === null);
  if (!pending()) return Promise.resolve();
  return new Promise((resolve) => {
    const off = useApp.subscribe(() => { if (!pending()) { off(); resolve(); } });
  });
}

/**
 * ✦ for a working tree (the drawer's target): a plain run, or a tweak of the current text (Shorter, More detail,
 * Subject only). A run already writing is cancelled first. Off or Read-only: nothing. It shows writing at once, and
 * asks main once the checkbox clicks in that repository reached git.
 */
export async function writeMessage(root: string, tweak?: { kind: MessageTweak; current: string }): Promise<void> {
  const s = st();
  if (!allowed(s)) return;
  const prev = s.gitWrite;
  if (prev?.phase === 'writing' && prev.id) cancel(prev.id);
  const mine = ++seq;
  early = [];
  s.setGitWrite(writeStart(prev, { root, staged: stagedKey(s.repos.find((r) => r.root === root)), at: Date.now(), tweak: tweak?.kind ?? null }));
  listen();
  let res: { id: string } | { error: string } | null;
  starting++;
  try {
    await clicksInGit(root);
    // Stopped, dropped or replaced while the clicks reached git: main is never asked.
    res = mine !== seq || st().gitWrite?.phase !== 'writing' ? null
      : await api().message({ root, ...(tweak ? { tweak: { kind: tweak.kind, current: tweak.current } } : {}) });
  } catch (e) {
    res = { error: e instanceof Error ? e.message : String(e) };
  } finally { starting--; }
  if (res === null) {
    if (!st().gitWrite) unlisten();
    return;
  }
  const w = st().gitWrite;
  // Stopped, dropped or replaced while main was starting it.
  if (mine !== seq || w?.phase !== 'writing') {
    if ('id' in res) cancel(res.id);
    if (!st().gitWrite) unlisten();
    return;
  }
  if ('error' in res) { failed(res.error); return; }
  st().setGitWrite({ ...w, id: res.id });
  const queued = early.filter((e) => e.id === res.id);
  early = [];
  for (const e of queued) onEvent(e);
}

function onEvent(e: ScmMessageEvent): void {
  const w = st().gitWrite;
  if (!w || w.phase !== 'writing') return;
  if (w.id === null) { if (starting) early.push(e); return; }
  if (e.id !== w.id) return;
  if ('chunk' in e) st().setGitWrite(writeChunk(w, e.chunk));
  else if ('done' in e) st().setGitWrite(writeReady(w, e.done));
  else failed(e.error);
}

/** Stop (the button, Esc): main stops writing; what streamed stays, put in the field as one undo step. */
export function stopMessage(): void {
  const w = st().gitWrite;
  if (!w || w.phase !== 'writing') return;
  seq++;
  if (w.id) cancel(w.id);
  st().setGitWrite(writeStopped(w));
}

/** The field took the text. */
export function messageApplied(): void {
  const w = st().gitWrite;
  if (w) st().setGitWrite(writeApplied(w));
}

/** The field changed: typing ends ready (its pills and meta line go). */
export function messageEdited(text: string): void {
  const w = st().gitWrite;
  if (!w) return;
  const next = writeEdited(w, text);
  if (next !== w) st().setGitWrite(next);
}

/**
 * ⌥⌘M, Git › Write Commit Message with Claude: Changes shows, the drawer opens on its default target (or
 * stays on the one it has), ✦ starts there; while it writes, it stops.
 */
export async function writeMessageCommand(): Promise<void> {
  if (!allowed(st())) return;
  if (st().gitWrite?.phase === 'writing' && st().gitDrawer.open) { stopMessage(); return; }
  if (!st().showChanges) st().toggleChanges();
  if (!st().gitDrawer.open) st().openGitDrawer();
  const root = st().gitTarget;
  if (root) await writeMessage(root);
}
