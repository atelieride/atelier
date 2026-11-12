// Find in Files, the sidebar view: the head (Refresh or Stop, Clear Results, Collapse or Expand All), the field with its
// three toggles and the filters' funnel, the summary, the notices of each state and the result list. Loaded on first use
// with its list, popover, strings and stylesheet.
import './search.css';
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { SEARCH_LIMITS, type SearchSpec } from '@shared/search';
import { compileSearch } from '@shared/search-match';
import { Icon } from '../components/Icon';
import { regexError } from '../editor/find/find-logic';
import { t } from '../i18n/en';
import { kbd } from '../kbd';
import { useApp } from '../store';
import { ts } from './copy';
import { searchAreaMenu } from './menus';
import { buildRows, fileKey, totals } from './model';
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
  const [skippedOpen, setSkippedOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<ResultListHandle>(null);
  const st = useSearch.getState;

  // The keyboard in the field, its text selected: when the view opens, and each time it is asked for again.
  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusNonce]);

  const kind = useMemo(() => compileSearch(spec).kind, [spec]);
  const rows = useMemo(() => buildRows(files, collapsed, dismissed), [files, collapsed, dismissed]);
  const count = useMemo(() => totals(files, dismissed), [files, dismissed]);
  const recent = useMemo(() => (spec.query === '' ? loadRecent(root) : []), [root, spec.query === '', searchId]);
  const running = searchId !== 0 && phase === 'running';
  const live = searchId !== 0 && kind === 'ok';
  const filtered = include.trim() !== '' || exclude.trim() !== '' || includeIgnored;
  const anyOpen = files.some((f) => !collapsed.has(fileKey(f.path)) && !dismissed.has(fileKey(f.path)));
  const empty = live && !running && phase !== 'error' && count.results === 0;
  const cap = live && limitHit && !running;
  const capped = live && fileCap !== null && !running;
  const failed = searchId !== 0 && phase === 'error' && error !== null;
  const stopped = live && phase === 'stopped';
  const changed = live && stale && !running;

  const toggle = (k: Toggle) => st().setSpec({ [k]: !st().spec[k] });
  const toField = () => { input.current?.focus(); };
  const clear = () => { st().setQuery(''); setSkippedOpen(false); toField(); };

  const onFieldKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const k = e.nativeEvent;
    if (k.isComposing) return;
    const opt = k.altKey && !k.metaKey && !k.ctrlKey && !k.shiftKey ? TOGGLE_KEYS[k.code] : undefined;
    if (opt) toggle(opt);
    else if (e.key === 'Enter' && !k.altKey && !k.metaKey && !k.ctrlKey && !k.shiftKey) { if (st().spec.query) st().run(); }
    else if (e.key === 'ArrowDown' && rows.length > 0) list.current?.focusRow();
    else return;
    e.preventDefault();
    e.stopPropagation();
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
          : <button type="button" className="icon-btn" aria-label={ts.refresh} data-tip={ts.refresh} disabled={spec.query === ''} onClick={() => st().run()}><Icon name="refresh" size={14} /></button>}
        <button type="button" className="icon-btn" aria-label={ts.clear} data-tip={ts.clear} disabled={spec.query === '' && files.length === 0} onClick={clear}><ClearGlyph /></button>
        <button type="button" className="icon-btn" aria-label={anyOpen || rows.length === 0 ? ts.collapseAll : ts.expandAll} data-tip={anyOpen || rows.length === 0 ? ts.collapseAll : ts.expandAll}
          disabled={rows.length === 0} onClick={() => st().setAllCollapsed(anyOpen)}><Icon name={anyOpen || rows.length === 0 ? 'collapseAll' : 'unfoldAll'} size={14} /></button>
      </Head>
      <div className="fif-query">
        <div className="fif-qrow">
          <div className={`fif-field${kind === 'invalid' ? ' is-error' : ''}`}>
            <span className="fif-lead" aria-hidden="true"><Icon name="search" size={14} stroke={1.8} /></span>
            <input ref={input} type="text" aria-label={ts.field} placeholder={ts.field} spellCheck={false} autoComplete="off" value={spec.query}
              aria-invalid={kind === 'invalid' || undefined} onChange={(e) => st().setQuery(e.target.value)} onKeyDown={onFieldKey} />
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
                onChange={(e) => st().setFilters({ include: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter' && st().spec.query) st().run(); }} />
            </label>
            <label className="fif-flab">{ts.exclude}
              <input type="text" className="fif-glob" spellCheck={false} autoComplete="off" value={exclude} placeholder={ts.excludeHint}
                onChange={(e) => st().setFilters({ exclude: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter' && st().spec.query) st().run(); }} />
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
        <div className="fif-summary" onContextMenu={(e) => { e.preventDefault(); useApp.getState().openMenu(e, searchAreaMenu()); }}>
          <span className="fif-totals">
            {count.results === 0 && running ? ts.searching : <Totals results={count.results} files={count.files} more={limitHit} />}
          </span>
          {skipped.length > 0 && !running && (
            <>
              <span className="fif-sep" aria-hidden="true">·</span>
              <button type="button" className="link-btn fif-skipped-link" aria-expanded={skippedOpen} onClick={() => setSkippedOpen((v) => !v)}>{ts.notSearched(skipped.length)}</button>
            </>
          )}
          <span className="grow" />
          {running && <span className="fif-counter mono">{ts.progress(progress.searched, progress.total)}</span>}
          {skippedOpen && skipped.length > 0 && <SkippedPopover files={skipped} onClose={() => setSkippedOpen(false)} />}
        </div>
      )}

      {kind === 'invalid' && (
        <div className="fif-notice is-error" role="alert">
          <span className="fif-why">{regexError(spec.query) ?? t.find.invalid}</span>
          <span>{ts.regexOff[0]} <code className="mono">.*</code> {ts.regexOff[1]}</span>
        </div>
      )}
      {spec.query === '' && <FirstOpen recent={recent} onPick={(r) => { st().setSpec(r); toField(); }} />}
      {kind === 'multiline' && <p className="fif-state">{ts.multiline}</p>}
      {empty && (
        <p className="fif-state">
          {include.trim()
            ? <>{ts.noResultsIn} <code className="mono">{include.trim()}</code>. </>
            : <>{ts.noResults} </>}
          {filtered && <button type="button" className="link-btn fif-whole" onClick={() => st().setFilters({ include: '', exclude: '', includeIgnored: false })}>{ts.wholeProject}</button>}
        </p>
      )}
      {rows.length > 0 && <ResultList ref={list} rows={rows} onEscape={toField} />}
      {/* What arrives with the end of a search, or after it: below the list, so the rows on screen stay where they are. */}
      {(cap || capped || failed || stopped || changed) && (
        <div className="fif-foot">
          {failed && error && <div className="fif-notice is-error" role="alert"><span className="fif-why">{error.message}</span>{refreshButton}</div>}
          {cap && <div className="fif-notice is-amber"><Icon name="warning" size={14} stroke={1.7} /><span>{ts.limit(SEARCH_LIMITS.maxResults)}</span></div>}
          {capped && fileCap !== null && <div className="fif-notice is-amber"><Icon name="warning" size={14} stroke={1.7} /><span>{includeIgnored ? ts.fileCapIgnored(fileCap) : ts.fileCap(fileCap)}</span></div>}
          {stopped && <p className="fif-quiet">{ts.stopped(progress.searched, progress.total)}</p>}
          {changed && <p className="fif-quiet">{ts.stale} <span aria-hidden="true">·</span> {refreshButton}</p>}
        </div>
      )}
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
      <p className="fif-about is-keys">{ts.selectAndPress} <span className="kbd mono">{kbd('⇧⌘F')}</span>.</p>
    </div>
  );
}
