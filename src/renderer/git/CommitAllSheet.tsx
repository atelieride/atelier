// The Commit all sheet: a centered top sheet, 700 px, over the dimmed window. Editing: the
// header (badge, title, whose work, One message | One per repository), ✦ Write All, one card per repository (include,
// path, branch, counts, its message, live and overlap notes, file chips that unstage), the footer's toggles and Commit
// N Repositories ⌘↵. Then the run (progress, rows, Stop After This One) and the results (Undo All, failed rows with
// their log, Ask <session> to Fix, Commit Without Hooks, Retry, the pushes). The run lives in the store: closing keeps it.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { GitOpResult } from '@shared/git-write';
import { Avatar } from '../components/Avatar';
import { FileIcon } from '../components/FileIcon';
import { Icon } from '../components/Icon';
import { Segmented } from '../components/Segmented';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { branchLabel } from '../worktrees';
import { failText } from './actions';
import * as M from './commit-all';
import {
  askToFix, closeCommitAll, commitAllNow, doneCommitAll, fixer, pushAll, pushOne, resolveRejected, retryCard, rowsOf, setCardMessage, setMode,
  setPushAfter, stopAfterThisOne, stopWrites, undoAll, unstageFile, writeAll
} from './commit-all-run';
import { coAuthorShown, elapsed } from './drawer';
import { liveFiles } from './live';
import { repoPathOf } from './rows';
import { stagedCount } from './target';
import { isMod } from '@shared/keys';
import { kbd } from '../kbd';

const c = t.git.commitAll;
/** A message grows to this many lines while focused, then scrolls. */
const MAX_LINES = 8;
/** Lines of a failed commit's log shown before "Full log". */
const LOG_LINES = 4;

/** Re-renders every second while `on` (elapsed times). */
function useTick(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

/** The commit bar's line while the sheet is closed: "Committing 3 of 4…", or results left to retry. */
export function CommitAllBarText({ bar }: { bar: NonNullable<ReturnType<typeof M.commitAllBar>> }) {
  return bar.kind === 'running'
    ? <><i className="git-spin is-working" aria-hidden="true" /><span className="git-bar-text">{c.barRunning(bar.current, bar.total)}</span></>
    : <><i className="git-bar-dot" aria-hidden="true" /><span className="git-bar-text">{c.barResults(bar.committed, bar.total)}</span></>;
}

/** Read-only (Settings › Source Control): none, like every other write. */
export function CommitAllSheet() {
  const s = useApp((x) => x.commitAll);
  const on = useApp((x) => x.settings.gitActions === 'on');
  if (!s?.open || !on) return null;
  return <Sheet s={s} />;
}

function Sheet({ s }: { s: M.CommitAllState }) {
  const repos = useApp((x) => x.repos);
  const project = useApp((x) => x.project?.realRoot ?? x.project?.root ?? null);
  const terminals = useApp((x) => x.terminals);
  const box = useRef<HTMLDivElement>(null);
  const stagedOf = (root: string) => { const r = repos.find((x) => x.root === root); return r ? stagedCount(r) : 0; };
  const nameOf = (root: string) => repoPathOf(root, project);
  const included = M.included(s, stagedOf);
  const editing = s.phase === 'edit';
  // Editing: what is staged now; once it runs, what it set out to commit (the commits empty the index).
  const files = editing ? included.reduce((n, card) => n + stagedOf(card.root), 0) : s.files;
  const session = s.session ? terminals.find((x) => x.id === s.session) : undefined;

  useEffect(() => {
    // The first empty message takes the focus (else the first one); the sheet itself while running.
    const el = box.current;
    const fields = [...(el?.querySelectorAll<HTMLTextAreaElement>('.commit-all-msg') ?? [])];
    (fields.find((f) => !f.value.trim() && !f.readOnly) ?? fields[0] ?? el)?.focus({ preventScroll: true });
  }, [s.phase]);

  const onKey = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeCommitAll(); }
    else if (e.key === 'Enter' && isMod(e) && editing) { e.preventDefault(); e.stopPropagation(); commitAllNow(); }
  };

  return (
    <div className="palette-backdrop commit-all-backdrop" onMouseDown={closeCommitAll}>
      <div ref={box} className="palette commit-all" role="dialog" aria-modal="true" aria-label={c.title(s.cards.length)} tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <header className="commit-all-head">
          <span className="commit-all-badge" aria-hidden="true"><Icon name="commit" size={16} stroke={2} /></span>
          <div className="commit-all-heading">
            <h2 className="commit-all-title">{s.phase === 'running' ? c.runningTitle(s.cards.filter((x) => x.run).length) : c.title(editing ? included.length : s.cards.filter((x) => x.run).length)}</h2>
            <p className="commit-all-sub">
              {session && <Avatar title={session.title} color={session.color} size={16} />}
              <span>{session ? c.subWork(session.title, files) : c.subStaged(files)}</span>
            </p>
          </div>
          {editing && (
            <Segmented label={c.messages} value={s.mode} onChange={setMode}
              options={[{ value: 'one', label: c.modeOne }, { value: 'per-repo', label: c.modePerRepo }]} />
          )}
        </header>
        {editing ? <Editing s={s} stagedOf={stagedOf} nameOf={nameOf} /> : <Run s={s} nameOf={nameOf} />}
      </div>
    </div>
  );
}

// ── Editing ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function Editing({ s, stagedOf, nameOf }: { s: M.CommitAllState; stagedOf: (root: string) => number; nameOf: (root: string) => string }) {
  const repos = useApp((x) => x.repos);
  const terminals = useApp((x) => x.terminals);
  const attributions = useApp((x) => x.attributions);
  const live = useMemo(() => liveFiles(terminals, attributions), [terminals, attributions]);
  const sessionTitle = s.session ? terminals.find((x) => x.id === s.session)?.title ?? null : null;
  const writes = M.writeProgress(s);
  const canWrite = M.writeTargets(s).length > 0;
  const included = M.included(s, stagedOf);
  const block = M.commitBlock(s, stagedOf);
  const why = writes ? c.blockWriting
    : !block ? null : block.kind === 'none' ? c.blockNone : block.root ? c.blockMessage(nameOf(block.root)) : c.blockOne;
  const showCoAuthor = useMemo(() => included.some((card) => coAuthorShown(rowsOf(card.root))), [included.map((x) => x.root).join('\n'), repos, attributions]);
  const messagesOn = useApp((x) => x.settings.commitMessages !== 'off');
  const showWrite = s.mode === 'per-repo' && messagesOn;

  return (
    <>
      {showWrite && (
        <div className="commit-all-tools">
          {writes ? (
            <>
              <span className="commit-all-written" role="status"><Icon name="sparkle" size={12} stroke={2} />{c.written(writes.done, writes.total)}</span>
              <span className="grow" />
              <button type="button" className="commit-all-link" onClick={stopWrites}>{c.writeStop}</button>
            </>
          ) : (
            <button type="button" className={`commit-all-write ${canWrite ? 'is-due' : ''}`} disabled={!canWrite} data-tip={c.writeAllTip} onClick={writeAll}>
              <Icon name="sparkle" size={12} stroke={2} />{c.writeAll}
            </button>
          )}
        </div>
      )}
      {s.mode === 'one' && (
        <div className="commit-all-one">
          <MessageInput label={c.oneMessage} value={s.message} onChange={(text) => useApp.getState().updateCommitAll((x) => ({ ...x, message: text }))} />
        </div>
      )}
      <ul className="commit-all-list">
        {s.cards.map((card) => (
          <Card key={card.root} s={s} card={card} name={nameOf(card.root)} staged={stagedOf(card.root)} live={live} sessionTitle={sessionTitle} />
        ))}
      </ul>
      <footer className="commit-all-foot">
        <div className="commit-all-foot-row">
          {showCoAuthor && (
            <button type="button" className={`git-toggle ${s.coAuthor ? 'is-on' : ''}`} aria-pressed={s.coAuthor} data-tip={c.coAuthorTip}
              onClick={() => useApp.getState().updateCommitAll((x) => ({ ...x, coAuthor: !x.coAuthor }))}>
              <span className="git-toggle-box">{s.coAuthor && <Icon name="check" size={10} stroke={2.6} />}</span>{c.coAuthor}
            </button>
          )}
          <button type="button" className={`git-toggle ${s.pushAfter ? 'is-on' : ''}`} aria-pressed={s.pushAfter} data-tip={c.pushAfterTip}
            onClick={() => setPushAfter(!s.pushAfter)}>
            <span className="git-toggle-box">{s.pushAfter && <Icon name="check" size={10} stroke={2.6} />}</span>{c.pushAfter}
          </button>
          <span className="grow" />
          <button type="button" className="btn-ghost" onClick={closeCommitAll}>{c.cancel}</button>
          <button type="button" className="btn-primary commit-all-go" aria-disabled={why ? true : undefined} data-tip={why ?? undefined}
            onClick={() => { if (!why) commitAllNow(); }}>
            <Icon name="check" size={13} stroke={2.4} />{c.commit(included.length)}<span className="commit-all-keys mono">{kbd('⌘↵')}</span>
          </button>
        </div>
        <p className="commit-all-note">{c.note}</p>
      </footer>
    </>
  );
}

function Card({ s, card, name, staged, live, sessionTitle }: {
  s: M.CommitAllState; card: M.CommitAllCard; name: string; staged: number; live: ReturnType<typeof liveFiles>; sessionTitle: string | null;
}) {
  const repo = useApp((x) => x.repos.find((r) => r.root === card.root));
  const attributions = useApp((x) => x.attributions);
  const [open, setOpen] = useState(false);
  const rows = useMemo(() => rowsOf(card.root), [repo, attributions]);
  const info = useMemo(() => M.cardInfo({ rows, session: s.session, live }), [rows, s.session, live]);
  const empty = staged === 0;
  const on = card.include && !empty;
  const toggle = () => { if (!empty) useApp.getState().updateCommitAll((x) => ({ ...x, cards: x.cards.map((k) => (k.root === card.root ? { ...k, include: !k.include } : k)) })); };
  const overlap = info.files.find((f) => f.also.length > 0);
  return (
    <li className={`commit-all-card ${on ? '' : 'is-out'} ${card.write === 'writing' ? 'is-writing' : ''}`}>
      <div className="commit-all-card-head">
        <button type="button" role="checkbox" aria-checked={on} aria-label={c.include(name)} aria-disabled={empty || undefined}
          className={`git-check is-${on ? 'all' : 'none'} ${empty ? 'is-disabled' : ''}`} data-tip={empty ? c.nothingStaged : undefined} onClick={toggle}>
          {on && <Icon name="check" size={11} stroke={2.6} />}
        </button>
        <span className="commit-all-path" data-tip={card.root}>{name}</span>
        {s.mode === 'per-repo' && repo && <span className="commit-all-branch mono"><Icon name="git" size={10} stroke={1.8} />{branchLabel(repo)}</span>}
        <span className="grow" />
        <span className="commit-all-counts mono">
          {empty ? c.nothingStaged : <>{c.files(info.files.length)}{s.mode === 'per-repo' && <> · <i className="is-add">+{info.added}</i> <i className="is-del">−{info.removed}</i></>}</>}
        </span>
        {!empty && (
          <button type="button" className={`icon-btn commit-all-chev ${open ? 'is-open' : ''}`} aria-expanded={open} aria-label={open ? c.hideFiles : c.showFiles}
            data-tip={open ? c.hideFiles : c.showFiles} onClick={() => setOpen(!open)}>
            <Icon name="chevronDown" size={12} stroke={2} />
          </button>
        )}
      </div>
      {s.mode === 'per-repo' && (
        <MessageInput label={c.message(name)} value={card.message} writing={card.write === 'writing'} disabled={!on}
          onChange={(text) => setCardMessage(card.root, text)} />
      )}
      {on && (info.live || overlap || (info.alsoStaged > 0 && sessionTitle)) && (
        <div className="commit-all-notes">
          {info.live && <span className="commit-all-note-line is-live"><i />{c.live(info.live.title, info.live.rel.split('/').pop() ?? info.live.rel, info.live.n)}</span>}
          {overlap && <span className="commit-all-note-line is-overlap"><Icon name="swap" size={11} stroke={2} />{overlap.rel.split('/').pop()} {c.also(overlap.also)}</span>}
          {info.alsoStaged > 0 && sessionTitle && <span className="commit-all-note-line">{c.alsoStaged(info.alsoStaged, sessionTitle)}</span>}
        </div>
      )}
      {open && !empty && (
        <ul className="commit-all-files">
          {info.files.map((f) => (
            <li key={f.rel} className={`commit-all-file ${f.also.length ? 'is-overlap' : ''}`} data-tip={f.also.length ? c.also(f.also) : f.rel}>
              <FileIcon name={f.rel} size={13} />
              <span className="commit-all-file-name">{f.rel}</span>
              <button type="button" className="commit-all-file-x" aria-label={c.unstageFile(f.rel)} onClick={() => unstageFile(card.root, f.rel)}>
                <Icon name="x" size={10} stroke={2.2} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * A message: one line while it rests, subject + body (at least three lines, growing up to eight) while focused. `Tab`
 * moves to the next message (`Shift+Tab` back), past the last one to the footer.
 */
function MessageInput({ label, value, onChange, writing = false, disabled = false }: {
  label: string; value: string; onChange: (text: string) => void; writing?: boolean; disabled?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [focused, setFocused] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const line = parseFloat(cs.lineHeight) || 18;
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    if (!focused) { el.style.height = `${line + pad + 2}px`; return; }
    el.style.height = '0px';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, line * 3 + pad), line * MAX_LINES + pad) + 2}px`;
  }, [value, focused]);
  const tab = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Tab' || e.altKey || e.metaKey || e.ctrlKey) return;
    const all = [...(e.currentTarget.closest('.commit-all')?.querySelectorAll<HTMLTextAreaElement>('.commit-all-msg:not(:disabled)') ?? [])];
    const next = all[all.indexOf(e.currentTarget) + (e.shiftKey ? -1 : 1)];
    if (!next) return;
    e.preventDefault();
    next.focus();
  };
  return (
    <textarea ref={ref} className={`commit-all-msg ${writing ? 'is-writing' : ''} ${focused ? 'is-focused' : ''}`} rows={1} spellCheck aria-label={label}
      value={value} readOnly={writing} disabled={disabled} placeholder={writing ? c.writing : c.placeholder}
      onFocus={() => setFocused(true)} onKeyDown={tab}
      // Back to one line: its subject, never where the caret left it.
      onBlur={(e) => { setFocused(false); e.currentTarget.scrollTop = 0; e.currentTarget.scrollLeft = 0; }} onChange={(e) => onChange(e.target.value)} />
  );
}

// ── Running and results ──────────────────────────────────────────────────────────────────────────────────────────────

function Run({ s, nameOf }: { s: M.CommitAllState; nameOf: (root: string) => string }) {
  const running = s.phase === 'running';
  const pushing = s.cards.some((x) => x.push?.kind === 'running');
  const now = useTick(running || pushing);
  const p = M.progress(s);
  const sum = M.summary(s);
  const pushN = M.pushTargets(s).length;
  const undoN = M.undoTargets(s).length;
  const pct = p.total ? Math.round(((p.done + (running ? 0.35 : 0)) / p.total) * 100) : 0;
  return (
    <>
      <div className={`commit-all-progress ${running ? 'is-running' : sum.committed === sum.total ? 'is-done' : 'is-partial'}`}>
        <div className="commit-all-meter" role="progressbar" aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.done}><i style={{ width: `${Math.min(100, pct)}%` }} /></div>
        {running ? <span className="commit-all-count mono">{c.progress(p.done, p.total)}</span> : <span className="commit-all-summary">{c.summary(sum.committed, sum.total)}</span>}
        <span className="grow" />
        {running && (s.stopAfter
          ? <span className="commit-all-stopping">{c.stopping}</span>
          : <button type="button" className="commit-all-link" onClick={stopAfterThisOne}>{c.stopAfter}</button>)}
      </div>
      <ul className="commit-all-list commit-all-rows">
        {s.cards.filter((x) => x.run).map((card) => <Row key={card.root} card={card} name={nameOf(card.root)} now={now} />)}
      </ul>
      <footer className="commit-all-foot">
        <div className="commit-all-foot-row">
          {!running && undoN > 0 && <button type="button" className="btn-ghost" data-tip={c.undoAllTip} onClick={() => void undoAll()}>{c.undoAll(undoN)}</button>}
          <span className="grow" />
          {!running && pushN > 0 && !pushing && (
            <button type="button" className="btn-ghost commit-all-push" onClick={() => void pushAll()}><Icon name="arrowUp" size={12} stroke={2.2} />{c.pushN(pushN)}</button>
          )}
          <button type="button" className={running ? 'btn-ghost' : 'btn-primary'} onClick={running ? closeCommitAll : doneCommitAll}>{running ? t.git.sync.close : c.done}</button>
        </div>
      </footer>
    </>
  );
}

function Row({ card, name, now }: { card: M.CommitAllCard; name: string; now: number }) {
  const op = useApp((x) => Object.values(x.gitOps).find((e) => e.root === card.root && e.op === 'commit'));
  const run = card.run!;
  const text = run.kind === 'committed' ? null
    : run.kind === 'running' ? (op?.phase === 'hook' && op.hook ? c.hook(op.hook) : op?.phase === 'signing' ? c.signing : c.committing)
    : run.kind === 'waiting' ? c.waiting : run.kind === 'skipped' ? c.skipped : run.kind === 'undone' ? c.undone
    // The row names the repository already.
    : run.result.outcome === 'hook' ? c.hookFailed(run.result.hook ?? 'A hook') : failText('commit', card.root, run.result);
  return (
    <li className={`commit-all-row is-${run.kind}`}>
      <div className="commit-all-row-main">
        <span className="commit-all-row-icon" aria-hidden="true">
          {run.kind === 'committed' ? <Icon name="check" size={11} stroke={2.6} />
            : run.kind === 'running' ? <i className="git-spin is-working" />
            : run.kind === 'failed' ? <Icon name="warning" size={11} stroke={2.2} /> : <i className="commit-all-dot" />}
        </span>
        <span className="commit-all-path">{name}</span>
        {run.kind === 'committed'
          ? <span className="commit-all-sha mono">{run.sha.slice(0, 7)}</span>
          : <span className="commit-all-row-text">{text}</span>}
        {run.kind === 'running' && <span className="commit-all-time mono">{elapsed(now - run.startedAt)}</span>}
        <span className="grow" />
        {card.push && <PushState card={card} />}
      </div>
      {run.kind === 'failed' && <Failed card={card} result={run.result} />}
    </li>
  );
}

function PushState({ card }: { card: M.CommitAllCard }) {
  const p = card.push!;
  switch (p.kind) {
    case 'running': return <span className="commit-all-pushing"><i className="git-spin" />{c.pushing}</span>;
    case 'pushed': return <span className="commit-all-pushed"><Icon name="arrowUp" size={11} stroke={2.2} />{p.published ? c.published(p.to) : c.pushed(p.to)}</span>;
    case 'ask': return (
      <span className="commit-all-ask">{c.pushWhere}
        {p.remotes.map((r) => <button key={r} type="button" className="git-sheet-remote" onClick={() => void pushOne(card.root, r)}>{r}</button>)}
      </span>
    );
    default: return (
      <span className="commit-all-push-failed" data-tip={p.result.message ?? undefined}>
        <Icon name="warning" size={11} stroke={2} />{failText('push', card.root, p.result)}
        {p.result.outcome === 'rejected' && <button type="button" className="commit-all-link" onClick={() => resolveRejected(card.root)}>{c.resolve}</button>}
      </span>
    );
  }
}

/** A failed row, open in place: the first lines of the log, Full log, Ask <session> to Fix, Without Hooks, Retry. */
function Failed({ card, result }: { card: M.CommitAllCard; result: GitOpResult }) {
  const [full, setFull] = useState(false);
  const terminals = useApp((x) => x.terminals);
  const attributions = useApp((x) => x.attributions);
  const who = useMemo(() => fixer(card.root), [card.root, terminals, attributions]);
  const output = result.output ?? result.message ?? '';
  const preview = M.logLines(output, LOG_LINES);
  const lines = full ? M.logLines(output, Number.MAX_SAFE_INTEGER).lines : preview.lines;
  return (
    <div className={`commit-all-fail ${full ? 'is-full' : ''}`}>
      {lines.length > 0 ? <pre className="commit-all-log mono" tabIndex={full ? 0 : undefined}>{lines.join('\n')}</pre> : <p className="commit-all-nolog">{c.noLog}</p>}
      <div className="commit-all-fail-actions">
        {/* Full log: the whole output in place, scrolling. */}
        {lines.length > 0 && (
          <button type="button" className="commit-all-link" aria-expanded={full} onClick={() => setFull(!full)}>
            {full ? c.lessLog : c.fullLog}{!full && preview.more > 0 && <span className="commit-all-more mono">{c.more(preview.more)}</span>}
          </button>
        )}
        <span className="grow" />
        {who && <button type="button" className="btn-ghost sm" data-tip={c.askTip} onClick={() => askToFix(card.root)}><Icon name="send" size={11} stroke={2} />{c.ask(who.title)}</button>}
        {result.outcome === 'hook' && <button type="button" className="btn-ghost sm" data-tip={c.withoutHooksTip} onClick={() => retryCard(card.root, true)}>{c.withoutHooks}</button>}
        <button type="button" className="btn-primary sm" onClick={() => retryCard(card.root, false)}>{c.retry}</button>
      </div>
    </div>
  );
}
