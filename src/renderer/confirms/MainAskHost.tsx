// main's questions as Aurora sheets: restart atelierd, a quit while git writes run, the
// window closing with unsaved files, and a window closing (or quitting) with busy sessions. The answer goes back to
// main, which acts on it.
import { useEffect, useMemo } from 'react';
import type { AskMessage, CloseSessionsAsk, QuitGitAsk, RestartAsk, UnsavedCloseAsk } from '@shared/asks';
import { useApp } from '../store';
import { t } from '../i18n/en';
import { SheetFrame } from '../git/SheetFrame';
import { dirtyPaths, saveMany } from '../editor/savers';
import { UnsavedSheet, unsavedFiles } from './UnsavedHost';
import { allowUnload } from './unload';
import { idStyle } from '../avatar';
import { Icon } from '../components/Icon';
import type { UnsavedAnswer } from './slice';

export function MainAskHost() {
  const ask = useApp((s) => s.mainAsk);
  if (!ask) return null;
  const r = ask.request;
  if (r.kind === 'restart-daemon') return <RestartSheet key={ask.id} r={r} />;
  if (r.kind === 'close-sessions') return <CloseSessionsSheet key={ask.id} r={r} />;
  if (r.kind === 'quit-git') return <QuitGitSheet key={ask.id} r={r} />;
  return <UnsavedCloseSheet key={ask.id} ask={ask} r={r} />;
}

const answer = (a: Parameters<ReturnType<typeof useApp.getState>['answerMain']>[0]) => useApp.getState().answerMain(a);

function RestartSheet({ r }: { r: RestartAsk }) {
  const c = t.confirm;
  const cancel = () => answer('cancel');
  const more = r.sessionCount - r.sessions.length;
  return (
    <SheetFrame title={c.restartTitle} icon="sync" tone="danger" className="confirm-sheet" onClose={cancel}>
      <p className="git-sheet-body">{c.restartBody}</p>
      {(r.sessionCount > 0 || r.terminals > 0) && (
        <div className="confirm-well is-row">
          {r.sessions.length > 0 && (
            <span className="confirm-avatars" aria-hidden="true">
              {r.sessions.map((s, i) => <span key={i} className="confirm-av" style={idStyle(s.color)}>{(s.title.trim()[0] ?? '·').toUpperCase()}</span>)}
              {more > 0 && <span className="confirm-av is-more">+{more}</span>}
            </span>
          )}
          <span className="confirm-counts">
            {r.sessionCount > 0
              ? <span><b>{c.sessionsN(r.sessionCount)}</b>{r.working > 0 ? ` · ${c.workingN(r.working)}` : ''}</span>
              : <span><b>{c.terminalsN(r.terminals)}</b></span>}
            <span className="confirm-faint">{r.sessionCount > 0 && r.terminals > 0 ? `${c.terminalsN(r.terminals)} ${c.inProjects(r.projects)}` : c.inProjects(r.projects)}</span>
          </span>
        </div>
      )}
      <p className="git-sheet-note">{r.sessionCount > 0 ? c.restartNote : c.restartNoteTerminals}</p>
      <div className="git-sheet-actions">
        <span className="grow" />
        <button type="button" className="btn-ghost" data-autofocus onClick={cancel}>{c.cancel}<span className="confirm-key mono">{c.esc}</span></button>
        <button type="button" className="btn-danger" onClick={() => answer('restart')}>{c.restartGo}</button>
      </div>
    </SheetFrame>
  );
}

/** A window closing, or Atelier quitting, with busy sessions. Enter keeps them running. */
function CloseSessionsSheet({ r }: { r: CloseSessionsAsk }) {
  const c = t.confirm;
  const cancel = () => answer('cancel');
  const quit = r.what === 'quit';
  const title = quit ? c.quitSessionsTitle : c.closeSessionsTitle(r.projects[0]?.name ?? '');
  const grouped = r.projects.length > 1;
  return (
    <SheetFrame title={title} icon="warning" tone="warn" className="confirm-sheet close-sessions" onClose={cancel}>
      <p className="git-sheet-body">{quit ? c.quitSessionsBody(r.windows) : c.closeSessionsBody}</p>
      <div className="confirm-well close-busy">
        {r.projects.map((p, pi) => (
          <div key={`${p.name}:${pi}`} className="close-busy-project">
            {grouped && <div className="close-busy-head"><span className="section-label">{p.name}</span></div>}
            {p.busy.map((b, i) => (
              <div key={i} className="close-busy-row">
                {b.session
                  ? <span className="confirm-av" style={idStyle(b.color)} aria-hidden="true">{(b.title.trim()[0] ?? '·').toUpperCase()}</span>
                  : <span className="confirm-av is-term" aria-hidden="true"><Icon name="terminal" size={13} stroke={1.8} /></span>}
                <span className={`close-busy-title${b.command !== undefined ? ' mono' : ''}`}>{b.command ?? b.title}</span>
                <span className={`close-busy-chip is-${b.kind}`}><i aria-hidden="true" />{c.busyKind[b.kind]}</span>
              </div>
            ))}
            {p.more > 0 && <span className="confirm-faint close-busy-more">{c.busyMore(p.more)}</span>}
            {(p.idleSessions > 0 || p.idleTerminals > 0) && <span className="confirm-faint close-busy-also">{c.alsoClosing(p.idleSessions, p.idleTerminals)}</span>}
          </div>
        ))}
      </div>
      <p className="git-sheet-note">{quit ? c.quitSessionsNote : c.closeSessionsNote}</p>
      <div className="git-sheet-actions">
        <button type="button" className="btn-ghost is-quiet" onClick={cancel}>{c.cancel}<span className="confirm-key mono">{c.esc}</span></button>
        <span className="grow" />
        <button type="button" className="btn-ghost" data-autofocus onClick={() => answer('keep')}>{c.keepInBackground}</button>
        <button type="button" className="btn-danger" onClick={() => answer('stop')}>{quit ? c.stopAndQuit : c.stopAndClose}</button>
      </div>
    </SheetFrame>
  );
}

function QuitGitSheet({ r }: { r: QuitGitAsk }) {
  const c = t.confirm;
  const wait = () => answer('wait');
  return (
    <SheetFrame title={r.title} icon="branchOff" tone="warn" className="confirm-sheet" onClose={wait}>
      {r.ops.length > 0 && (
        <div className="confirm-well">
          {r.ops.map((o, i) => (
            <span key={`${o.noun}:${o.repo}:${i}`} className="confirm-op"><i className="confirm-op-dot" /><span className="confirm-op-noun">{o.noun}</span><span className="confirm-faint mono">{o.repo}</span></span>
          ))}
          <span className="confirm-progress" role="progressbar" aria-label={r.title}><i /></span>
        </div>
      )}
      <p className="git-sheet-body">{r.detail}</p>
      <div className="git-sheet-actions">
        <button type="button" className="btn-text-danger" onClick={() => answer('quit')}>{c.quitAnyway}</button>
        <span className="grow" />
        <button type="button" className="btn-primary" data-autofocus onClick={wait}>{c.wait}</button>
      </div>
    </SheetFrame>
  );
}

/** The window closing (or quitting, or reloading) with unsaved files: saved or discarded here, then main goes on. */
function UnsavedCloseSheet({ ask, r }: { ask: AskMessage; r: UnsavedCloseAsk }) {
  const c = t.confirm;
  const files = useApp((s) => s.openFiles);
  // The editors' own word (not the store's 150 ms late dirty map), as the page's guard.
  const list = useMemo(() => unsavedFiles(dirtyPaths(), files), [ask.id]);
  // Saved meanwhile (or nothing was left by the time it showed): nothing to ask, the close goes on.
  useEffect(() => { if (list.length === 0) { allowUnload(); answer('go'); } }, [list]);
  const onAnswer = (a: UnsavedAnswer) => {
    if (a === 'cancel') { answer('cancel'); return; }
    if (a === 'discard') { allowUnload(); answer('go'); return; }
    void saveMany(a.save).then((ok) => {
      // A failed save keeps the window (its error is already shown); the rest unchecked are let go.
      if (!ok) { answer('cancel'); return; }
      allowUnload();
      answer('go');
    });
  };
  if (list.length === 0) return null;
  return <UnsavedSheet files={list} title={c.unsavedWindow} note={r.what === 'reload' ? c.keepRunning : c.saveBefore[r.what]} then={c.then[r.what]} onAnswer={onAnswer} listOne />;
}
