// The commit detail under the History list: subject, body, trailers, the meta grid, the
// changed files and the selected file's diff. A resizable panel (height remembered, double-click collapses).
import { Fragment, forwardRef, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { RepoStatus } from '@shared/git';
import type { ScmCommit, ScmCommitDetail, ScmChangeKind, ScmRef, ScmRefs } from '@shared/scm';
import { FileIcon } from '../components/FileIcon';
import { Icon } from '../components/Icon';
import { initialOf } from '../avatar';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { copy } from './actions';
import { CommitDiff } from './CommitDiff';
import { COMPARE_ROW, WORKTREE_ROW } from './history-model';
import { loadScmPrefs, saveScmPrefs } from './prefs';
import { detailBody, splitTrailers } from './detail';
import { isClaude, personColor, refPills, shortRef } from './view';

/** worktree: the file on disk (an uncommitted change), compared with `worktreeHead`, the working tree's HEAD. */
export interface DetailFile { rel: string; origRel?: string; kind: ScmChangeKind; added: number | null; removed: number | null; oldMode: string; newMode: string; oldOid: string; newOid: string; worktree?: string; worktreeHead?: string | null }
export interface DetailHandle { openFirst(): void; focusFiles(): void }

const KIND_CLASS: Record<ScmChangeKind, string> = { M: 'k-mod', A: 'k-add', D: 'k-del', R: 'k-ren', T: 'k-mod' };
const MIN_H = 180;
const DEFAULT_H = 340;
const when = (s: number) => new Date(s * 1000).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

export const CommitDetail = forwardRef<DetailHandle, {
  repo: string; commit: ScmCommit; refs: ScmRefs | undefined; byOid: Map<string, ScmRef[]>; status: RepoStatus | undefined;
  compareBase: { base: string; mergeBase: string | null | undefined } | null; against: string | null; onAgainst: (base: string | null) => void;
  onSelectParent: (oid: string) => void; onBackToList: () => void;
}>(function CommitDetail({ repo, commit, refs, byOid, status: repoStatus, compareBase, against, onAgainst, onSelectParent, onBackToList }, ref) {
  const project = useApp((s) => s.project?.root);
  const status = commit.oid === WORKTREE_ROW ? repoStatus : undefined;
  const [detail, setDetail] = useState<ScmCommitDetail | null>(null);
  const [fileAt, setFileAt] = useState(0);
  const [height, setHeight] = useState(() => (project ? loadScmPrefs(project).detailHeight : undefined) ?? DEFAULT_H);
  const [collapsed, setCollapsed] = useState(false);
  const files = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const isWt = commit.oid === WORKTREE_ROW;
  const isCompare = commit.oid === COMPARE_ROW;
  const headOid = isCompare && refs ? commitOfCompare(refs) : null;
  function commitOfCompare(r: ScmRefs): string | null {
    const scope = useApp.getState().historyTab?.scope;
    if (!scope || scope.kind !== 'compare') return null;
    return r.refs.find((x) => x.name === scope.head)?.oid ?? (/^[0-9a-f]{40,64}$/.test(scope.head) ? scope.head : null);
  }

  useEffect(() => {
    setFileAt(0);
    if (isWt) { setDetail(null); return; }
    const oid = isCompare ? headOid : commit.oid;
    const base = isCompare ? compareBase?.mergeBase ?? null : against;
    if (!oid || (isCompare && !base)) { setDetail(null); return; }
    let alive = true;
    const t0 = performance.now();
    void window.atelier.scm.commit(repo, oid, base, 'detail').then((d) => {
      if (!alive || d.error === 'aborted') return;
      setDetail(d);
      // The detail's budget: measured where tests and profiles can read it.
      performance.measure('scm:detail', { start: t0, end: performance.now() });
    }).catch(() => {});
    return () => { alive = false; };
  }, [repo, commit.oid, against, headOid, compareBase?.mergeBase]);

  const list: DetailFile[] = isWt
    ? (status?.changes ?? []).map((c) => ({ rel: c.rel, ...(c.origRel ? { origRel: c.origRel } : {}), kind: c.kind === '?' ? 'A' : c.kind === 'U' ? 'M' : c.kind, added: c.added, removed: c.removed, oldMode: '', newMode: '', oldOid: '', newOid: '', worktree: c.path, worktreeHead: status?.oid ?? null }))
    : detail && (detail.oid === commit.oid || (isCompare && detail.oid === headOid)) ? detail.files : [];
  const file = list[Math.min(fileAt, Math.max(0, list.length - 1))];
  const base = detail?.base ?? '';
  const oid = isCompare ? headOid ?? '' : commit.oid;
  const openAt = (f: DetailFile | undefined) => { if (f && !f.worktree && f.kind !== 'D' && oid) useApp.getState().openRevFile({ root: repo, oid, rel: f.rel }); };
  useImperativeHandle(ref, () => ({ openFirst: () => openAt(list[0]), focusFiles: () => files.current?.focus() }), [list, oid]);

  const step = (dir: 1 | -1) => setFileAt((i) => Math.max(0, Math.min(list.length - 1, i + dir)));
  const fileKeys = (e: ReactKeyboardEvent): boolean => {
    if (e.key === 'n') { step(1); return true; }
    if (e.key === 'p') { step(-1); return true; }
    if (e.key === 'Escape') { onBackToList(); return true; }
    return false;
  };
  const onFilesKey = (e: ReactKeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); step(1); return; }
    if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); step(-1); return; }
    if (e.key === 'Enter') { e.preventDefault(); openAt(file); return; }
    if (fileKeys(e)) e.preventDefault();
  };

  // The divider: drag to resize (min 180 px, max 70 % of the tab), double-click to collapse or bring back.
  const drag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const body = panel.current?.parentElement;
    const max = body ? body.clientHeight * 0.7 : 600;
    const y0 = e.clientY; const h0 = collapsed ? 0 : height;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    let last = h0;
    const move = (ev: PointerEvent) => { last = Math.max(MIN_H, Math.min(max, h0 - (ev.clientY - y0))); setCollapsed(false); setHeight(last); };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); if (project) saveScmPrefs(project, { detailHeight: Math.round(last) }); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const msg = isWt || isCompare ? null : splitTrailers(detail?.oid === commit.oid ? detail.message || commit.subject : commit.subject);
  const added = list.reduce((n, f) => n + (f.added ?? 0), 0);
  const removed = list.reduce((n, f) => n + (f.removed ?? 0), 0);
  const committerDiffers = commit.committer.email !== commit.author.email || commit.committer.name !== commit.author.name;
  const pills = isWt || isCompare || !refs ? [] : refPills(commit.oid, byOid, refs.head);
  const body = detailBody({ isWorktree: isWt, isCompare, detailOid: detail?.oid ?? null, commitOid: commit.oid, headOid, mergeBase: compareBase?.mergeBase, files: list.length });
  return (
    <div ref={panel} className={`cd ${collapsed ? 'is-collapsed' : ''}`} style={{ height: collapsed ? 0 : height }}>
      <div className="cd-divider" role="separator" aria-orientation="horizontal" data-tip={t.scm.detail.resize} onPointerDown={drag} onDoubleClick={() => setCollapsed((c) => !c)} />
      {!collapsed && (
        <div className="cd-body">
          <div className="cd-left">
            {isWt && <h3 className="cd-subject">{t.scm.history.uncommitted}</h3>}
            {isCompare && <h3 className="cd-subject">{t.scm.history.allChangesSince(compareBase ? compareBase.base.replace(/^refs\/(heads|remotes|tags)\//, '') : '')}</h3>}
            {msg && (
              <>
                <h3 className="cd-subject">{msg.subject}</h3>
                {msg.body && <p className="cd-body-text">{msg.body}</p>}
                <dl className="cd-meta">
                  <dt>{t.scm.detail.author}</dt>
                  <dd><span className="hv-avatar" style={{ ['--person' as string]: personColor(commit.author.email) }}>{initialOf(commit.author.name || '?')}</span>{commit.author.name}<span className="cd-dim mono">{when(commit.authorAt)}</span></dd>
                  {commit.coAuthors.length > 0 && <><dt>{t.scm.detail.with}</dt><dd className="cd-with">{commit.coAuthors.map((p) => <span key={p.name + p.email} className="cd-person">{isClaude(p) && <Icon name="sparkle" size={11} stroke={1.8} />}{p.name}</span>)}</dd></>}
                  {committerDiffers && <><dt>{t.scm.detail.committer}</dt><dd>{commit.committer.name}<span className="cd-dim mono">{when(commit.committerAt)}</span></dd></>}
                  <dt>{t.scm.detail.commit}</dt>
                  <dd><button type="button" className="cd-sha mono" data-tip={t.scm.detail.copySha} onClick={() => copy(commit.oid, t.scm.history.copied(commit.oid.slice(0, 7)))}>{commit.oid.slice(0, 10)}<Icon name="copy" size={11} stroke={1.8} /></button></dd>
                  <dt>{t.scm.detail.parents}</dt>
                  <dd>{commit.parents.length === 0 ? <span className="cd-dim">{t.scm.detail.rootCommit}</span> : commit.parents.map((p) => <button key={p} type="button" className="cd-parent mono" onClick={() => onSelectParent(p)}>{p.slice(0, 7)}</button>)}</dd>
                  {pills.length > 0 && <><dt>{t.scm.detail.refs}</dt><dd className="cd-refs">{pills.map((p) => <span key={p.kind + p.label} className={`hv-pill is-${p.kind}`}>{p.label}</span>)}</dd></>}
                  {msg.trailers.filter((x) => x.key.toLowerCase() !== 'co-authored-by').map((x, i) => <Fragment key={i}><dt className="cd-trailer">{x.key}</dt><dd>{x.value}</dd></Fragment>)}
                </dl>
              </>
            )}
            {commit.parents.length > 1 && !isWt && !isCompare && (
              <div className="cd-against">
                <span>{against ? t.scm.detail.againstSecond : t.scm.detail.againstFirst}</span>
                <button type="button" className="btn-ghost sm" onClick={() => onAgainst(against ? null : commit.parents[1]!)}>{against ? t.scm.detail.compareParent1 : t.scm.detail.compareParent2}</button>
              </div>
            )}
            <div className="cd-files-head">
              <span>{t.scm.detail.files(list.length + (detail?.more ?? 0))}</span>
              <span className="mono"><span className="hv-plus">+{added}</span> <span className="hv-minus">−{removed}</span></span>
            </div>
            <div ref={files} className="cd-files" role="listbox" aria-label={t.scm.detail.files(list.length)} tabIndex={0} onKeyDown={onFilesKey}>
              {body === 'loading' && <p className="cd-none">{t.scm.detail.loading}</p>}
              {body === 'empty' && <p className="cd-none">{t.scm.detail.noFiles}</p>}
              {body === 'noCommonHistory' && <p className="cd-none">{t.scm.detail.noCommonHistory(shortRef(compareBase?.base ?? ''))}</p>}
              {list.map((f, i) => {
                const name = f.rel.split('/').at(-1) ?? f.rel;
                const dir = f.rel.split('/').slice(0, -1).join('/');
                return (
                  <button key={f.rel} type="button" role="option" aria-selected={i === fileAt} tabIndex={-1} className={`cd-file ${i === fileAt ? 'is-selected' : ''}`}
                    onClick={() => setFileAt(i)} onDoubleClick={() => openAt(f)}>
                    <span className={`change-kind mono ${KIND_CLASS[f.kind]}`}>{f.kind}</span>
                    <FileIcon name={name} size={14} />
                    <span className="cd-file-name">{f.origRel ? <><span className="cd-dir">{f.origRel} → </span>{f.rel}</> : <>{name}{dir && <span className="cd-dir"> {dir}</span>}</>}</span>
                    <span className="cd-delta mono">{f.added !== null && f.added > 0 && <span className="hv-plus">+{f.added}</span>}{!!f.removed && <span className="hv-minus">−{f.removed}</span>}</span>
                  </button>
                );
              })}
              {(detail?.more ?? 0) > 0 && <p className="cd-none">{t.scm.detail.moreFiles(detail!.more)}</p>}
            </div>
          </div>
          {file ? <CommitDiff key={`${oid}:${base}:${file.rel}`} repo={repo} file={file} base={base} oid={oid} onOpen={() => openAt(file)} onKeyNav={fileKeys} />
            : <div className="cd-diff cd-placeholder">{t.scm.detail.selectFile}</div>}
        </div>
      )}
    </div>
  );
});
