// Ask companion's channels: a trusted app page of a project window only (its pop-outs
// included: a popped-out session has its Ask too), input parsed strictly, then a binding is checked against what main
// knows of the sender's project and terminal before the service sees it. Threads are app-wide, so their events go to
// every window.
import { lstatSync } from 'node:fs';
import type { IpcMainInvokeEvent } from 'electron';
import { IPC } from '@shared/api';
import type { Binding, CompanionEvent, CompanionModel } from '@shared/companion/types';
import { isInside } from '@shared/paths';
import type { TerminalInfo } from '@shared/protocol';
import { sessionTranscript } from '../claude-history';
import { insideProject } from '../fs/files';
import { companionAskSchema, companionCatchUpSchema, companionSessionSchema } from '../ipc-schemas';
import type { CompanionService } from './service';

export type CompanionIpcService = Pick<CompanionService, 'thread' | 'ask' | 'catchUp' | 'stop' | 'newThread' | 'seen'>;

export interface CompanionIpcDeps {
  /** A window's project (pop-outs included); null for the welcome window. */
  projectOf(wcId: number): string | null;
  isTrusted(e: IpcMainInvokeEvent): boolean;
  handle(channel: string, fn: (e: IpcMainInvokeEvent, arg: unknown) => unknown): void;
  /**
   * A project's terminal's Claude account dir when it is a configured account other than the default, else undefined
   * (TerminalHub.accountDirOf, as ✦ and dictation use it): the terminal's dir comes from hook data, which alone never
   * names a dir that is read or put in an environment.
   */
  accountDir(project: string, terminalId: string): string | undefined;
  /** A terminal atelierd lists (an ended session's included); null otherwise. Its title names a live session. */
  terminal(terminalId: string): (Pick<TerminalInfo, 'projectRoot' | 'session'> & { title?: string }) | null;
  /**
   * The session's transcript is there (an ended session, or one /clear replaced in its terminal), or in another history
   * folder of the project (Claude Code moved it into a worktree): transcriptExists.
   */
  hasTranscript(o: { sessionId: string; cwd: string; configDir: string | null }, project: string): boolean;
}

/**
 * A regular file where the session's transcript is now (sessionTranscript: its cwd's folder, else another folder of the
 * project it moved to), never followed through a symlink, as Claude history reads them.
 */
export function transcriptExists(o: { sessionId: string; cwd: string; configDir: string | null }, project: string): boolean {
  const file = sessionTranscript(o, [project, o.cwd]);
  if (file === null) return false;
  try { return lstatSync(file).isFile(); } catch { return false; }
}

export const TERMINAL_UNAVAILABLE = "This session's terminal isn't available right now";

/**
 * The binding as the service gets it, or why not. Its terminal is one atelierd lists for the sender's project; its cwd
 * inside that project (as spelled, or through the project's real path: Claude reports real folders); its session the
 * terminal's current one, or one whose transcript is there under that cwd or moved into a worktree of the project (it
 * ended, or /clear replaced it). The config dir is the terminal's mapped through the configured accounts only: another
 * account's launch dir, else null (the default account: its own dir, a removed account's, a dir only hook data names).
 * The renderer's is never used. The cwd and config dir pick the transcript Ask reads (the transcript check here too)
 * and the account it runs as. While the terminal still runs that session, the title rules.md and facts.md name is
 * main's (the page's may lag behind a rename).
 */
export function checkedBinding(project: string, b: Binding, deps: Pick<CompanionIpcDeps, 'accountDir' | 'terminal' | 'hasTranscript'>): Binding {
  const term = deps.terminal(b.terminalId);
  if (!term) throw new Error(TERMINAL_UNAVAILABLE);
  if (term.projectRoot !== project) throw new Error('terminal of another project');
  if (!isInside(project, b.cwd) && insideProject(project, b.cwd) === null) throw new Error('session folder outside the project');
  const live = term.session?.sessionId === b.sessionId;
  const bound: Binding = { ...b, configDir: deps.accountDir(project, b.terminalId) ?? null, ...(live && term.title ? { title: term.title } : {}) };
  if (!live && !deps.hasTranscript(bound, project)) throw new Error('session of another terminal');
  return bound;
}

export function installCompanionIpc(svc: CompanionIpcService, deps: CompanionIpcDeps): void {
  // The sender first: an untrusted page's input is never even parsed.
  const projectOf = (e: IpcMainInvokeEvent) => {
    const p = deps.projectOf(e.sender.id);
    if (!p || !deps.isTrusted(e)) throw new Error('unauthorized sender');
    return p;
  };
  // By id only, app-wide once the sender is checked, by design: every thread goes to every window anyway (ev:companion),
  // as git:cancel and scm:message-cancel act on an id alone.
  const session = (e: IpcMainInvokeEvent, arg: unknown) => {
    projectOf(e);
    return companionSessionSchema.parse(arg).sessionId;
  };
  deps.handle(IPC.companionThread, (e, arg) => svc.thread(session(e, arg)));
  const pick = (o: { model?: CompanionModel; account?: string }) => ({ ...(o.model ? { model: o.model } : {}), ...(o.account ? { account: o.account } : {}) });
  deps.handle(IPC.companionAsk, (e, arg) => {
    const project = projectOf(e);
    const o = companionAskSchema.parse(arg);
    return svc.ask(checkedBinding(project, o.binding, deps), { text: o.text, ...pick(o) });
  });
  deps.handle(IPC.companionCatchUp, (e, arg) => {
    const project = projectOf(e);
    const o = companionCatchUpSchema.parse(arg);
    return svc.catchUp(checkedBinding(project, o.binding, deps), { final: o.final, ...pick(o) });
  });
  deps.handle(IPC.companionStop, (e, arg) => { svc.stop(session(e, arg)); });
  deps.handle(IPC.companionNew, (e, arg) => svc.newThread(session(e, arg)));
  deps.handle(IPC.companionSeen, (e, arg) => { svc.seen(session(e, arg)); });
}

export interface CompanionWindow { send(channel: string, payload: unknown): void; isDestroyed(): boolean }

/**
 * The service's listener: every window gets every event (two windows may show the same thread). Never throws: a window
 * closing meanwhile, or the list failing while the app quits, never breaks a save or the queue's bookkeeping.
 */
export function broadcastCompanion(windows: () => readonly CompanionWindow[]): (e: CompanionEvent) => void {
  return (e) => {
    let list: readonly CompanionWindow[];
    try { list = windows(); } catch { return; }
    for (const w of list) {
      try { if (!w.isDestroyed()) w.send(IPC.evCompanion, e); } catch { /* gone: it reloads the thread when it opens again */ }
    }
  };
}
