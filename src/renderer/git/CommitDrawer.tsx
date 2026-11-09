import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { trackedCounts } from '@shared/git-write';
import { buildRows } from '../changes';
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';
import { newTerminalIn } from '../launch';
import type { MenuItem } from '../menu-model';
import { useApp } from '../store';
import { branchLabel } from '../worktrees';
import { cancelOp, commit, openCommitAll, push, refreshFacts, stage, undoCommit } from './actions';
import { stageAllPlan, type StageAllOffer } from './stage-all';
import { StageAllConfirm } from './StageAllConfirm';
import { changesInWorkspace } from '../workspace-view';
import { CommitButton } from './CommitButton';
import {
  AMEND_OFF, amendFollow, amendOffer, amendStart, coAuthorShown, commitBlock, dragEnd, drawerLog, drawerNotices, liveHeight, othersLine, RESULT_MS,
  type AmendState, type Notice
} from './drawer';
import { liveFiles } from './live';
import { stale as staleWrite } from './message';
import { messageApplied, messageEdited, stopMessage, writeMessage } from './message-run';
import { MessageField } from './MessageField';
import { Sparkle, WriteLines } from './MessageWrite';
import { OpLog } from './OpLog';
import { RepoPicker } from './RepoPicker';
import { stagedCount } from './target';
import { useMessage } from './use-message';
import { isMod } from '@shared/keys';
import { idStyle } from '../avatar';

/** How much of the Changes panel the drawer may take when dragged taller. */
const MAX_SHARE = 0.6;

/**
 * The 32×3 grab handle on the top edge. `onMove`: the pointer's travel while dragging (up is negative);
 * `onEnd`: at release. A press that doesn't travel is a click on what is under it.
 */
export function Handle({ onMove, onEnd }: { onMove?: (dy: number) => void; onEnd: (dy: number) => void }) {
  const start = useRef<number | null>(null);
  return (
    <span className="git-handle" aria-hidden="true" data-tip={t.git.bar.handle}
      onPointerDown={(e) => { if (e.button !== 0) return; e.preventDefault(); e.stopPropagation(); start.current = e.clientY; e.currentTarget.setPointerCapture(e.pointerId); }}
      onPointerMove={(e) => { if (start.current !== null) onMove?.(e.clientY - start.current); }}
      onPointerUp={(e) => { if (start.current === null) return; const dy = e.clientY - start.current; start.current = null; onEnd(dy); }}
      onPointerCancel={() => { start.current = null; onMove?.(0); }}
      onClick={(e) => e.stopPropagation()}><i /></span>
  );
}

/** Re-renders when `at + ms` passes, so a notice that lasts `ms` goes by itself. */
function useExpiry(at: number | null, ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === null) return;
    const left = at + ms - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), left + 50);
    return () => clearTimeout(timer);
  }, [at, ms]);
  return Math.max(now, Date.now());
}

/**
 * The commit drawer, top to bottom: handle, target chip, notices, message, toggles, others
 * line, the split button. `Esc` closes it (the draft stays); `⌘↵` commits; the handle drags it taller or closed.
 */
export function CommitDrawer() {
  const repos = useApp((s) => s.repos);
  const target = useApp((s) => s.gitTarget);
  const height = useApp((s) => s.gitDrawer.height);
  const allFacts = useApp((s) => s.gitFacts);
  const facts = target ? allFacts[target] : undefined;
  const results = useApp((s) => s.gitResult);
  const ops = useApp((s) => s.gitOps);
  const actedAt = useApp((s) => s.gitActedAt);
  const terminals = useApp((s) => s.terminals);
  const attributions = useApp((s) => s.attributions);
  const coAuthorDefault = useApp((s) => s.settings.commitCoAuthor);
  const messagesOn = useApp((s) => s.settings.commitMessages !== 'off');
  const nothingMode = useApp((s) => s.settings.commitNothingStaged);
  // Changes showing This workspace: Stage All takes only the rows shown.
  const wsF = useApp((s) => (s.ws?.on && !s.popout ? s.ws : null));
  const scope = useApp((s) => s.changesScope);
  const anyWrite = useApp((s) => s.gitWrite);
  const repo = repos.find((r) => r.root === target) ?? null;
  const toPush = repo ? trackedCounts(repo).ahead : 0;
  const name = repo?.name ?? '';
  const [draft, setDraft] = useMessage(target);
  // Amend: HEAD's message in the field, apart from the draft (amend never touches it); off brings the draft back.
  // It remembers the commit it showed: main amends only that one (expectHead).
  const [amend, setAmend] = useState<AmendState>(AMEND_OFF);
  const [amendMoved, setAmendMoved] = useState(false);
  const message = amend.on ? amend.text : draft;
  const messageNow = useRef(message);
  messageNow.current = message;
  const setMessage = (text: string) => (amend.on ? setAmend({ ...amend, text }) : setDraft(text));
  const [coAuthorOn, setCoAuthorOn] = useState(coAuthorDefault);
  const [busy, setBusy] = useState(false);
  // Commit with nothing staged, asking: how it was asked (Commit, or Commit and Push).
  const [ask, setAsk] = useState<{ push: boolean; noVerify: boolean } | null>(null);
  const [picking, setPicking] = useState(false);
  const [drag, setDrag] = useState<{ start: number; natural: number; max: number; dy: number } | null>(null);
  const ref = useRef<HTMLElement>(null);
  const chip = useRef<HTMLButtonElement>(null);

  // What a commit needs to know about the target (HEAD, identity, an operation in progress, Undo), read when it
  // changes and when its HEAD or upstream moves (a commit or a push from a terminal).
  useEffect(() => { if (target) void refreshFacts(target); }, [target, repo?.oid, repo?.ahead, repo?.upstream]);
  // Opening on a failure is looking at it: the bar stops showing it (its log is in the drawer).
  useEffect(() => { if (target) useApp.getState().seeGitResult(target); }, [target, results]);

  const offer = amendOffer(facts);
  const running = Object.values(ops).some((e) => e.root === target && e.op !== 'stage' && e.op !== 'unstage');
  // Another repository: back to the draft.
  useEffect(() => { setAmend(AMEND_OFF); setAmendMoved(false); }, [target]);
  // Amend no longer possible (pushed meanwhile), or HEAD moved under it (a commit from a terminal or a session): back to
  // the draft, the latter with a notice. Not while a commit runs here: its own new HEAD isn't a move.
  useEffect(() => {
    if (busy || running) return;
    const next = amendFollow(amend, facts);
    if (next.amend === amend) return;
    setAmend(next.amend);
    if (next.moved) setAmendMoved(true);
  }, [facts, busy, running, amend]);
  const toggleAmend = (on: boolean) => {
    const next = on ? amendStart(facts) : AMEND_OFF;
    if (!next) return;
    setAmend(next);
    setAmendMoved(false);
    ref.current?.querySelector('textarea')?.focus();
  };

  const live = useMemo(() => liveFiles(terminals, attributions), [terminals, attributions]);
  const lastAt = Math.max(0, ...Object.values(results).map((r) => ('sha' in r ? r.at : 0)));
  const now = useExpiry(lastAt || null, RESULT_MS);
  const rows = useMemo(() => (repo ? buildRows([repo], attributions) : []), [repo, attributions]);
  // What Stage All would take here: the whole repository, or the rows This workspace shows.
  const stageAll: StageAllOffer = repo
    ? stageAllPlan({ repo, shown: wsF && scope === 'ws' ? changesInWorkspace(wsF, rows) : null, writes: true })
    : { offered: false, why: 'nothing' };
  const notices = drawerNotices({ target, repos, facts, allFacts, live, results, actedAt, now, amendMoved, unstaged: stageAll.offered && !ask ? stageAll.plan.changes : 0 });
  const staged = repo ? stagedCount(repo) : 0;
  // ✦: the target's run only; while it writes, the field is Claude's and Commit waits.
  const write = anyWrite && anyWrite.root === target && messagesOn ? anyWrite : null;
  const writing = write?.phase === 'writing';
  const nothingStaged = { mode: nothingMode, offered: stageAll.offered, conflicts: !stageAll.offered && stageAll.why === 'conflicts' };
  const block = writing ? t.git.write.busy : commitBlock({ target, name, staged, message, running, notices, amend: amend.on, nothingStaged });
  // The question goes once there is nothing left to ask: something staged meanwhile, another repository, Amend on.
  useEffect(() => { if (ask && (!stageAll.offered || amend.on || staged > 0)) setAsk(null); }, [ask, stageAll.offered, amend.on, staged]);
  useEffect(() => { setAsk(null); }, [target]);
  const showCoAuthor = coAuthorShown(rows);
  const others = othersLine(repos, target);
  const log = drawerLog({ target, name, ops: Object.values(ops), results });

  /**
   * The commit itself; `coAuthor`: a staged file is surely a session's (judged after a Stage All, when there was one).
   * The message as it is now: text typed while Stage All ran goes in too.
   */
  const commitNow = async (root: string, o: { push?: boolean; noVerify?: boolean }, coAuthor: boolean) => {
    setAmendMoved(false);
    const r = await commit({
      root, message: messageNow.current, amend: amend.on, coAuthor: coAuthor && coAuthorOn, noVerify: !!o.noVerify, push: !!o.push,
      ...(amend.on && amend.head ? { expectHead: amend.head } : {})
    });
    if (r?.outcome === 'ok') setAmend(AMEND_OFF);
  };
  /** Nothing staged: everything Stage All takes, then the commit; a failed stage says so and stops. */
  const stageThenCommit = async (o: { push?: boolean; noVerify?: boolean }) => {
    setAsk(null);
    if (!target || !stageAll.offered || busy) return;
    setBusy(true);
    try {
      const r = await stage(target, stageAll.plan.what);
      if (r?.outcome !== 'ok') return;
      const st = useApp.getState();
      const now = st.repos.find((x) => x.root === target);
      await commitNow(target, o, now ? coAuthorShown(buildRows([now], st.attributions)) : false);
    } finally {
      setBusy(false);
      // The question (and its focused button) is gone: the focus back where you type, so Esc and ⌘↵ work after a
      // failed stage or commit (a drawer closed by a commit has no field: nothing happens).
      focusField();
    }
  };
  const run = async (o: { push?: boolean; noVerify?: boolean } = {}) => {
    if (block || busy || !target) return;
    if (staged === 0 && !amend.on && stageAll.offered) {
      if (nothingMode === 'ask') setAsk({ push: !!o.push, noVerify: !!o.noVerify });
      else await stageThenCommit(o);
      return;
    }
    setBusy(true);
    try { await commitNow(target, o, showCoAuthor); } finally { setBusy(false); }
  };
  const cancelAsk = () => { setAsk(null); focusField(); };
  const menu = (): MenuItem[] => [
    { id: 'git-commit-push', label: t.git.drawer.commitAndPush, icon: 'arrowUp', disabled: !!block || busy, ...(block ? { tip: block } : {}), run: () => void run({ push: true }) },
    { id: 'git-amend-last', label: t.git.drawer.amendLast, icon: 'edit', disabled: !offer.ok || amend.on, ...(!offer.ok ? { tip: offer.tip } : {}), run: () => toggleAmend(true) },
    'sep',
    { id: 'git-commit-all', label: t.git.drawer.commitAllRepos, icon: 'commit', run: () => openCommitAll() }
  ];
  const focusField = () => ref.current?.querySelector('textarea')?.focus({ preventScroll: true });
  // From the drawer, ✦ keeps the focus in the field: Esc stops it there, the result lands where you type.
  const startWrite = (tweak?: Parameters<typeof writeMessage>[1]) => { if (!target) return; focusField(); void writeMessage(target, tweak); };
  // Typing ends the target's ✦ (its pills), never a run kept for another repository.
  const edit = (text: string) => { setMessage(text); if (write) messageEdited(text); };
  const closePicker = () => { setPicking(false); focusField(); };
  const retry = log?.kind === 'failed' && target
    ? log.op === 'commit' ? () => void run() : log.op === 'push' ? () => void push(target) : undefined
    : undefined;

  const measure = () => {
    const el = ref.current!;
    const prev = el.style.height;
    el.style.height = '';
    const natural = el.offsetHeight;
    el.style.height = prev;
    const panel = el.parentElement?.clientHeight ?? 0;
    return { start: el.offsetHeight, natural, max: Math.max(natural, Math.floor(panel * MAX_SHARE)) };
  };
  const shown = drag ? liveHeight(drag) : height;
  // A height remembered from a taller window still fits this one.
  useLayoutEffect(() => {
    if (height === null || !ref.current) return;
    const panel = ref.current.parentElement?.clientHeight ?? 0;
    if (panel && height > panel * MAX_SHARE) ref.current.style.height = `${Math.floor(panel * MAX_SHARE)}px`;
  });

  return (
    <section ref={ref} className={`git-drawer ${shown !== null ? 'is-sized' : ''} ${drag ? 'is-dragging' : ''}`} aria-label={t.git.drawer.label}
      style={shown !== null ? { height: shown } : undefined}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        // Esc while ✦ writes stops it; the drawer stays. Esc while Stage All asks closes the question only.
        if (e.key === 'Escape' && writing) { e.preventDefault(); e.stopPropagation(); stopMessage(); }
        else if (e.key === 'Escape' && ask) { e.preventDefault(); e.stopPropagation(); cancelAsk(); }
        else if (e.key === 'Escape' && !useApp.getState().menu && !picking) { e.preventDefault(); e.stopPropagation(); useApp.getState().closeGitDrawer(); }
        // ⌘↵ while it asks: its answer (Stage All and Commit), as the focused button's ↵ is.
        else if (e.key === 'Enter' && isMod(e)) { e.preventDefault(); if (!e.repeat) void (ask ? stageThenCommit(ask) : run()); }
      }}>
      <Handle
        onMove={(dy) => setDrag((d) => ({ ...(d ?? measure()), dy }))}
        onEnd={(dy) => {
          const m = drag ?? measure();
          setDrag(null);
          const out = dragEnd({ open: true, ...m, dy });
          if (out.kind === 'close') useApp.getState().closeGitDrawer();
          else if (out.kind === 'height') useApp.getState().setGitDrawerHeight(out.height);
        }} />
      <div className="git-drawer-top">
        <button ref={chip} type="button" className={`git-chip ${picking ? 'is-open' : ''}`} data-tip={picking ? undefined : t.git.drawer.chooseRepo}
          aria-haspopup="listbox" aria-expanded={picking} onClick={() => setPicking(!picking)} disabled={repos.length === 0}>
          <Icon name="git" size={12} stroke={1.8} />
          {/* Keyed by the target: a new repository (picked, or staged in) cross-fades in. */}
          <span key={target ?? ''} className="git-chip-body">
            <span className="git-chip-name">{name}</span>
            {repo && <span className="git-chip-branch mono">{branchLabel(repo)}</span>}
          </span>
          <Icon name="chevronDown" size={11} stroke={2} />
        </button>
        {toPush > 0 && <span className="git-ahead mono" data-tip={t.git.drawer.aheadTip(toPush)}>↑{toPush}</span>}
        <span className="grow" />
        <button type="button" className="icon-btn git-drawer-close" aria-label={t.git.drawer.close} data-tip={t.git.drawer.close}
          onClick={() => useApp.getState().closeGitDrawer()}><Icon name="chevronDown" size={14} stroke={2} /></button>
      </div>
      {picking && chip.current && (
        <RepoPicker anchor={chip.current} onClose={closePicker}
          onPick={(root) => { useApp.getState().setGitTarget(root); closePicker(); }} />
      )}
      {notices.length > 0 && (
        <div className="git-notices">
          {notices.map((n) => <NoticeLine key={`${n.kind}-${n.text}`} n={n} onStageAll={() => { if (target && stageAll.offered) void stage(target, stageAll.plan.what); }} />)}
        </div>
      )}
      {log && (
        <OpLog key={log.kind === 'running' ? log.id : `failed-${target}`} log={log} onCancel={(id) => void cancelOp(id)} onRetry={retry}
          onWithoutHooks={() => void run({ noVerify: true })} onDismiss={() => { if (target) useApp.getState().dismissGitResult(target); }} />
      )}
      {amend.on && amend.head && (
        <div className="git-amending"><Icon name="edit" size={11} stroke={2} /><span>{t.git.drawer.amending} <span className="mono">{amend.head.slice(0, 7)}</span></span></div>
      )}
      <MessageField value={message} onChange={edit} onCommit={() => void (ask ? stageThenCommit(ask) : run())} onPicker={() => { if (repos.length) setPicking(true); }} autoFocus
        stream={writing ? write.text : null} apply={write?.apply ?? null} onApplied={messageApplied}
        accessory={messagesOn && repo ? <Sparkle w={write} empty={!message.trim()} staged={staged} onWrite={() => startWrite()} onStop={stopMessage} /> : undefined} />
      {messagesOn && (
        <WriteLines w={write} stale={staleWrite(write, repo ?? undefined)} onRewrite={() => startWrite()}
          onTweak={(kind) => startWrite({ kind, current: message })} />
      )}
      <div className="git-toggles">
        {showCoAuthor && (
          <button type="button" className={`git-toggle ${coAuthorOn ? 'is-on' : ''}`} aria-pressed={coAuthorOn} data-tip={t.git.drawer.coAuthorTip}
            onClick={() => setCoAuthorOn(!coAuthorOn)}>
            <span className="git-toggle-box">{coAuthorOn && <Icon name="check" size={10} stroke={2.6} />}</span>
            <span className="git-toggle-full">{t.git.drawer.coAuthor}</span><span className="git-toggle-short">{t.git.drawer.coAuthorShort}</span>
          </button>
        )}
        <button type="button" className={`git-toggle ${amend.on ? 'is-on' : ''}`} aria-pressed={amend.on} aria-disabled={!offer.ok || undefined}
          data-tip={offer.ok ? t.git.drawer.amendTip : offer.tip} onClick={() => toggleAmend(!amend.on)}>
          <span className="git-toggle-box">{amend.on && <Icon name="check" size={10} stroke={2.6} />}</span>{t.git.drawer.amend}
        </button>
      </div>
      {others && (
        <div className="git-others">
          <span className="git-others-dots" aria-hidden="true"><i /><i /><i /></span>
          <span className="git-others-text">{t.git.drawer.others(others.files, others.repos)}</span>
          <button type="button" className="git-others-all" onClick={() => openCommitAll()}>{t.git.drawer.commitAll}</button>
        </div>
      )}
      {ask && stageAll.offered && (
        <StageAllConfirm name={name} plan={stageAll.plan} push={ask.push} onCancel={cancelAsk}
          onAlways={() => { void window.atelier.settings.set({ commitNothingStaged: 'stage-all' }); void stageThenCommit(ask); }}
          onGo={() => void stageThenCommit(ask)} />
      )}
      <CommitButton count={staged} block={block} busy={busy || running} onCommit={() => void run()} menu={menu}
        {...(amend.on ? { label: { full: t.git.drawer.amendCommit, short: t.git.drawer.amend } } : {})} />
    </section>
  );
}

/**
 * One notice line: live (sky dot), state (amber, rose when it blocks), failed (rose), result (green, Undo),
 * nothing staged (neutral).
 */
function NoticeLine({ n, onStageAll }: { n: Notice; onStageAll: () => void }) {
  if (n.kind === 'unstaged') {
    return (
      <div className="git-notice is-unstaged">
        <Icon name="commit" size={12} stroke={2} /><span className="git-notice-text">{n.text}</span>
        <button type="button" className="git-notice-action" onClick={onStageAll}>{t.git.drawer.stageAll}</button>
      </div>
    );
  }
  if (n.kind === 'result') {
    return (
      <div className="git-notice is-result" role="status">
        <Icon name="check" size={12} stroke={2.4} /><span className="git-notice-text"><span className="mono">{n.sha}</span>{n.text.slice(n.sha.length)}</span>
        {n.undo && <button type="button" className="git-notice-action" onClick={() => void undoCommit(n.root, n.undo!.oid)}>{t.git.undo}</button>}
      </div>
    );
  }
  if (n.kind === 'live') {
    return <div className="git-notice is-live"><i className="git-notice-dot id-dot" style={idStyle(n.color)} /><span className="git-notice-text" data-tip={n.text}>{n.text}</span></div>;
  }
  const tone = n.kind === 'failed' || n.blocks ? 'is-block' : 'is-warn';
  return (
    <div className={`git-notice ${tone}`} role={n.kind === 'failed' ? 'alert' : undefined}>
      <Icon name="warning" size={12} stroke={2} /><span className="git-notice-text" data-tip={n.text}>{n.text}</span>
      {n.kind === 'state' && n.terminal && <button type="button" className="git-notice-action" onClick={() => void newTerminalIn(n.terminal)}>{t.git.drawer.openInTerminal}</button>}
    </div>
  );
}
