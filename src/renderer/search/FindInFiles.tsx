// Find in Files, the sidebar view: the head (Refresh or Stop, Clear Results, Collapse or Expand All), the field with its
// three toggles and the filters' funnel, the summary (with ✦ Send to session), the notices of each state and the result
// list. Loaded on first use with its list, popover, strings and stylesheet.
import './search.css';
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { SearchSpec, SkippedFile } from '@shared/search';
import { compileSearch } from '@shared/search-match';
import { Icon } from '../components/Icon';
import { regexError } from '../editor/find/find-logic';
import { t } from '../i18n/en';
import { kbd } from '../kbd';
import { useApp } from '../store';
import { sendResults } from './actions';
import { ts } from './copy';
import { searchAreaMenu } from './menus';
import { anyExpanded, buildRows, rowTotals, runsSearch, takesFocusOnMount } from './model';
import { loadRecent } from './recent';
import { ResultList, type ResultListHandle } from './ResultList';
import { SkippedPopover } from './SkippedPopover';
import { useSearch } from './store';

type Toggle = 'matchCase' | 'wholeWord' | 'regex';
const TOGGLE_KEYS: Record<string, Toggle> = { KeyC: 'matchCase', KeyW: 'wholeWord', KeyR: 'regex' };

/** Clear Results: a list struck out. Drawn here rather than in Icon.tsx: the first paint carries none of this view. */
function ClearGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 6h8M4 10h6M4 14h5" /><path d="m12.5 12.5 4 4m0-4-4 4" />
    </svg>
  );
}

/** "ab" over the bracket the find card draws for Whole Word. */
const WholeWord = (
  <span className="fc-ww">ab<svg width="13" height="4" viewBox="0 0 13 4" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="M1 .5v2h11v-2" /></svg></span>
);

/** The store's last focus request the field answered: the store outlives the view, so a remount takes no old request. */
let answeredNonce = 0;
// What the field's description points at: a window has one Find in Files view.
const whyId = 'fif-why';
const lineId = 'fif-line';

/** The small marks of a recent query's options. */
const optionMarks = (s: SearchSpec): string => [s.matchCase && 'Aa', s.wholeWord && 'ab', s.regex && '.*'].filter(Boolean).join(' ');

export function FindInFiles() {
  const root = useApp((s) => s.project?.root ?? null);
  if (!root) return <NoProject />;
  return <SearchView root={root} />;
}

function Head({ children }: { children?: ReactNode }) {
  return (
    <div className="sidebar-head">
      <span className="section-label">{ts.title}</span>
      <span className="grow" />
      {children}
    </div>
  );
}

function NoProject() {
  return (
    <>
      <Head />
      <div className="fif-empty">
        <p className="fif-state">{ts.noProject}</p>
        <button type="button" className="btn-ghost sm" onClick={() => void window.atelier.openFolder()}>{ts.openFolder}</button>
      </div>
    </>
  );
}

function SearchView({ root }: { root: string }) {
  const spec = useSearch((s) => s.spec);
  const phase = useSearch((s) => s.phase);
  const searchId = useSearch((s) => s.searchId);
  const files = useSearch((s) => s.files);
  const collapsed = useSearch((s) => s.collapsed);
  const dismissed = useSearch((s) => s.dismissed);
  const progress = useSearch((s) => s.progress);
  const skipped = useSearch((s) => s.skipped);
  const limitHit = useSearch((s) => s.limitHit);
  const fileCap = useSearch((s) => s.fileCap);
  const stale = useSearch((s) => s.stale);
  const error = useSearch((s) => s.error);
  const include = useSearch((s) => s.include);
  const exclude = useSearch((s) => s.exclude);
  const includeIgnored = useSearch((s) => s.includeIgnored);
  const filtersOpen = useSearch((s) => s.filtersOpen);
  const focusNonce = useSearch((s) => s.focusNonce);
  // The search whose files-not-searched list is open: another search closes it.
  const [skippedFor, setSkippedFor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<ResultListHandle>(null);
  const st = useSearch.getState;

  // The keyboard in the field, its text selected, when the view opens on purpose or nothing has the keyboard; the
  // sidebar merely shown again (⌘B) over a terminal or an editor leaves the keyboard with them.
  useLayoutEffect(() => {
    const a = document.activeElement;
    const active = !a || a === document.body ? 'none' : a.closest('.activity-bar') ? 'activity' : 'other';
    const asked = takesFocusOnMount(active, focusNonce !== answeredNonce);
    answeredNonce = focusNonce;
    if (!asked) return;
    input.current?.focus();
    input.current?.select();
  }, [focusNonce]);

  const kind = useMemo(() => compileSearch(spec).kind, [spec]);
  // One pass over the results: the rows, and the totals read off them (a collapsed file's row carries its count).
  const { rows, count } = useMemo(() => {
    const built = buildRows(files, collapsed, dismissed);
    return { rows: built, count: rowTotals(built) };
  }, [files, collapsed, dismissed]);
  const recent = useMemo(() => (spec.query === '' ? loadRecent(root) : []), [root, spec.query === '', searchId]);
  const running = searchId !== 0 && phase === 'running';
  const live = searchId !== 0 && kind === 'ok';
  // Paths narrow the search ("Search the whole project" clears them); Include ignored files widens it: the funnel is
  // lit for both.
  const narrowed = include.trim() !== '' || exclude.trim() !== '';
  const filtered = narrowed || includeIgnored;
  const anyOpen = anyExpanded(rows);
  const empty = live && !running && phase !== 'error' && count.results === 0;
  const skippedOpen = skippedFor !== 0 && skippedFor === searchId;
  const skippedNote = live && !running && skipped.length > 0
    ? <SkippedNote files={skipped} open={skippedOpen} onOpen={() => setSkippedFor(searchId)} onClose={() => setSkippedFor(0)} />
    : null;

  // The last rows gone with the keyboard on one of them (⌘⌫, ×): it goes back to the field rather than nowhere.
  const hadRows = useRef(rows.length > 0);
  useLayoutEffect(() => {
    const has = rows.length > 0;
    if (hadRows.current && !has && (!document.activeElement || document.activeElement === document.body)) input.current?.focus();
    hadRows.current = has;
  }, [rows.length > 0]);
  const cap = live && limitHit && !running;
  // Where the cap stopped: every match listed, dismissed ones too.
  const listed = useMemo(() => (cap ? files.reduce((n, f) => n + f.lines.reduce((m, l) => m + l.ranges.length, 0), 0) : 0), [files, cap]);
  const capped = live && fileCap !== null && !running;
  const failed = searchId !== 0 && phase === 'error' && error !== null;
  const stopped = live && phase === 'stopped';
  const changed = live && stale && !running;

  const toggle = (k: Toggle) => st().setSpec({ [k]: !st().spec[k] });
  const toField = () => { input.current?.focus(); };
  const clear = () => { st().setQuery(''); toField(); };
  const areaMenu = (e: React.MouseEvent) => { e.preventDefault(); useApp.getState().openMenu(e, searchAreaMenu()); };

  const onFieldKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const k = e.nativeEvent;
    if (k.isComposing) return;
    const opt = k.altKey && !k.metaKey && !k.ctrlKey && !k.shiftKey ? TOGGLE_KEYS[k.code] : undefined;
    if (opt) toggle(opt);
    else if (runsSearch(k)) { if (st().spec.query) st().run(); }
    else if (e.key === 'ArrowDown' && rows.length > 0) list.current?.focusRow();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const onFilterKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!runsSearch(e.nativeEvent) || !st().spec.query) return;
    e.preventDefault();
    st().run();
  };

  const opt = (k: Toggle, label: string, keys: string, body: ReactNode) => (
    <button type="button" className={`fc-opt fif-opt${spec[k] ? ' is-on' : ''}`} aria-label={label} aria-pressed={spec[k]} data-tip={label} data-kbd={kbd(keys)}
      onMouseDown={(e) => e.preventDefault()} onClick={() => toggle(k)}>{body}</button>
  );

  const refreshButton = (
    <button type="button" className="link-btn fif-refresh" onClick={() => st().run()}>{ts.refresh}</button>
  );

  return (
    <>
      <Head>
        {running
          ? <button type="button" className="icon-btn" aria-label={ts.stop} data-tip={ts.stop} onClick={() => st().stop()}><Icon name="stop" size={14} /></button>
          : <button type="button" className="icon-btn" aria-label={ts.refresh} data-tip={ts.refresh} disabled={kind !== 'ok'} onClick={() => st().run()}><Icon name="refresh" size={14} /></button>}
        <button type="button" className="icon-btn" aria-label={ts.clear} data-tip={ts.clear} disabled={spec.query === '' && files.length === 0} onClick={clear}><ClearGlyph /></button>
        <button type="button" className="icon-btn" aria-label={anyOpen || rows.length === 0 ? ts.collapseAll : ts.expandAll} data-tip={anyOpen || rows.length === 0 ? ts.collapseAll : ts.expandAll}
          disabled={rows.length === 0} onClick={() => st().setAllCollapsed(anyOpen)}><Icon name={anyOpen || rows.length === 0 ? 'collapseAll' : 'unfoldAll'} size={14} /></button>
      </Head>
      <div className="fif-query">
        <div className="fif-qrow">
          <div className={`fif-field${kind === 'invalid' ? ' is-error' : ''}`}>
            <span className="fif-lead" aria-hidden="true"><Icon name="search" size={14} stroke={1.8} /></span>
            <input ref={input} type="text" aria-label={ts.field} placeholder={ts.field} spellCheck={false} autoComplete="off" value={spec.query}
              aria-invalid={kind === 'invalid' || undefined} aria-describedby={kind === 'invalid' ? whyId : kind === 'multiline' ? lineId : undefined}
              onChange={(e) => st().setQuery(e.target.value)} onKeyDown={onFieldKey} />
            {opt('matchCase', t.find.matchCase, '⌥C', 'Aa')}
            {opt('wholeWord', t.find.wholeWord, '⌥W', WholeWord)}
            {opt('regex', t.find.regexp, '⌥R', '.*')}
          </div>
          <button type="button" className={`icon-btn fif-funnel${filtered ? ' is-lit' : ''}${filtersOpen ? ' is-open' : ''}`} aria-label={ts.filters} data-tip={ts.filters}
            aria-expanded={filtersOpen} onClick={() => st().toggleFilters()}><Icon name="filter" size={14} /></button>
        </div>
        {filtersOpen && (
          <div className="fif-filters">
            <label className="fif-flab">{ts.include}
              <input type="text" className="fif-glob" spellCheck={false} autoComplete="off" value={include} placeholder={ts.includeHint}
                onChange={(e) => st().setFilters({ include: e.target.value })} onKeyDown={onFilterKey} />
            </label>
            <label className="fif-flab">{ts.exclude}
              <input type="text" className="fif-glob" spellCheck={false} autoComplete="off" value={exclude} placeholder={ts.excludeHint}
                onChange={(e) => st().setFilters({ exclude: e.target.value })} onKeyDown={onFilterKey} />
            </label>
            <button type="button" className="cf-switch fif-ignored" role="switch" aria-checked={includeIgnored} onClick={() => st().setFilters({ includeIgnored: !includeIgnored })}>
              <span>{ts.includeIgnored}</span><span className="cf-toggle" aria-hidden="true"><i /></span>
            </button>
          </div>
        )}
        {running && (
          <div className="fif-progress" role="progressbar" aria-label={ts.searching} aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.searched}>
            <i style={{ width: `${progress.total > 0 ? Math.max(4, Math.round((progress.searched / progress.total) * 100)) : 4}%` }} />
          </div>
        )}
      </div>

      {live && (count.results > 0 || running) && (
        <div className="fif-summary" onContextMenu={areaMenu}>
          <span className="fif-totals">
            {count.results === 0 && running ? ts.searching : <Totals results={count.results} files={count.files} more={limitHit} />}
          </span>
          {skippedNote}
          {running
            ? <><span className="grow" /><span className="fif-counter mono">{ts.progress(progress.searched, progress.total)}</span></>
            // Its room is what the summary leaves: short of it, the sparkle alone, the name in its tip.
            : <span className="fif-send-slot">
                <button type="button" className="fif-send" aria-label={ts.send} data-tip={ts.send} onClick={sendResults}>
                  <Icon name="sparkle" size={12} stroke={1.8} /><span className="fif-send-label">{ts.send}</span>
                </button>
              </span>}
        </div>
      )}

      {kind === 'invalid' && (
        <div className="fif-notice is-error" role="alert" id={whyId}>
          <span className="fif-why">{regexError(spec.query) ?? t.find.invalid}</span>
          <span>{ts.regexOff[0]} <code className="mono">.*</code> {ts.regexOff[1]}</span>
        </div>
      )}
      {spec.query === '' && <FirstOpen recent={recent} onPick={(r) => { st().setSpec(r); toField(); }} />}
      {kind === 'multiline' && <p className="fif-state" id={lineId}>{ts.multiline}</p>}
      {empty && (
        <div className="fif-state">
          {include.trim()
            ? <>{ts.noResultsIn} <code className="mono">{include.trim()}</code>. </>
            : <>{ts.noResults} </>}
          {narrowed && <button type="button" className="link-btn fif-whole" onClick={() => st().setFilters({ include: '', exclude: '' })}>{ts.wholeProject}</button>}
          {narrowed && skippedNote && ' '}
          {skippedNote}
        </div>
      )}
      {rows.length > 0 && <ResultList ref={list} rows={rows} onEscape={toField} />}
      {/* What arrives with the end of a search, or after it: right below the list, so the rows on screen stay put. */}
      {(cap || capped || failed || stopped || changed) && (
        <div className="fif-foot">
          {failed && error && <div className="fif-notice is-error" role="alert"><span className="fif-why">{error.message}</span>{refreshButton}</div>}
          {cap && <div className="fif-notice is-amber"><Icon name="warning" size={14} stroke={1.7} /><span>{ts.limit(listed)}</span></div>}
          {capped && fileCap !== null && <div className="fif-notice is-amber"><Icon name="warning" size={14} stroke={1.7} /><span>{includeIgnored ? ts.fileCapIgnored(fileCap) : ts.fileCap(fileCap)}</span></div>}
          {stopped && <p className="fif-quiet">{ts.stopped(progress.searched, progress.total)}</p>}
          {changed && <p className="fif-quiet">{ts.stale} <span aria-hidden="true">·</span> {refreshButton}</p>}
        </div>
      )}
      {/* The rest of the sidebar under the results: their empty area, with its menu. */}
      {rows.length > 0 && <div className="fif-rest" onContextMenu={areaMenu} />}
    </>
  );
}

/** "· 2 files not searched": a link to the list of them; closed with Esc or its ×, the keyboard comes back to it. */
function SkippedNote({ files, open, onOpen, onClose }: { files: SkippedFile[]; open: boolean; onOpen: () => void; onClose: () => void }) {
  const link = useRef<HTMLButtonElement>(null);
  return (
    <>
      <span className="fif-sep" aria-hidden="true">·</span>{' '}
      <button ref={link} type="button" className="link-btn fif-skipped-link" aria-expanded={open} onClick={() => (open ? onClose() : onOpen())}>{ts.notSearched(files.length)}</button>
      {open && <SkippedPopover files={files} onClose={(back) => { onClose(); if (back) link.current?.focus(); }} />}
    </>
  );
}

/** "19 results in 5 files", its numbers in mono. */
function Totals({ results, files, more }: { results: number; files: number; more: boolean }) {
  const [a, mid, b, tail] = ts.totals(results, files, more);
  return <><span className="fif-n mono">{a}</span>{mid}<span className="fif-n mono">{b}</span>{tail}</>;
}

/** An empty field: the project's recent searches (a click runs one), and what a search covers. */
function FirstOpen({ recent, onPick }: { recent: SearchSpec[]; onPick: (s: SearchSpec) => void }) {
  return (
    <div className="fif-empty">
      {recent.length > 0 && (
        <div className="fif-recent">
          <span className="section-label fif-recent-label">{ts.recent}</span>
          {recent.map((r) => (
            <button key={`${r.query}\n${optionMarks(r)}`} type="button" className="fif-recent-item" onClick={() => onPick(r)}>
              <Icon name="clock" size={12} stroke={1.7} />
              <span className="fif-recent-q mono">{r.query}</span>
              {optionMarks(r) && <span className="fif-recent-opts mono">{optionMarks(r)}</span>}
            </button>
          ))}
        </div>
      )}
      <p className="fif-about">{ts.about}</p>
      <p className="fif-about is-keys">{ts.selectAndPress} <span className="kbd mono">{kbd('⌘⇧F')}</span>.</p>
    </div>
  );
}
