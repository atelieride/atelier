// The floating find and replace card. Pure view: the panel in find-ext.ts
// owns the query (CodeMirror's) and passes everything in.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import { t } from '../../i18n/en';
import { counterText, shortcutAction, swapEnter, type FindAction, type FindSpec, type MatchCount } from './find-logic';
import { kbd } from '../../kbd';
import { cardHandsOver } from '../../search/open';

export interface FindCardProps {
  spec: FindSpec;
  valid: boolean;
  regexError: string | null;
  count: MatchCount;
  /** After Replace all: an empty result isn't an error. */
  quiet: boolean;
  readOnly: boolean;
  replaceOpen: boolean;
  /** Bumped to move the keyboard into a field (and select its text). */
  focus: { field: 'find' | 'replace'; nonce: number };
  onSpec: (patch: Partial<FindSpec>) => void;
  onAction: (a: FindAction) => void;
  onToggleReplace: () => void;
  /** Keys the card doesn't use (⌘F, ⌘G…): the editor's search-panel bindings. */
  onOtherKey: (e: KeyboardEvent) => boolean;
  /** ↵ goes up and ⇧↵ down (a terminal's card: the newest text is at the bottom). */
  enterUp?: boolean;
  /** One neutral line under the field (a terminal on its alternate screen). */
  note?: string | null;
  /** "Search in all files" under the card: its query and options to Find in Files (⇧⌘F in the card does the same). */
  onSearchAll?: () => void;
}

/** A text field whose text is local while typing; the query wins when it changes from outside (⌘F on a selection). */
function useField(value: string): [string, (v: string) => void] {
  const [text, setText] = useState(value);
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) { last.current = value; setText(value); }
  }, [value]);
  return [text, (v) => { last.current = v; setText(v); }];
}

export function FindCard(p: FindCardProps) {
  const findRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useField(p.spec.search);
  const [replace, setReplace] = useField(p.spec.replace);
  const showReplace = p.replaceOpen && !p.readOnly;
  const card = useRef<HTMLDivElement>(null);
  const searchAll = useRef(p.onSearchAll);
  searchAll.current = p.onSearchAll;
  const handsOver = !!p.onSearchAll;
  useLayoutEffect(() => (handsOver && card.current ? cardHandsOver(card.current, () => searchAll.current?.()) : undefined), [handsOver]);

  useLayoutEffect(() => {
    const el = p.focus.field === 'replace' && showReplace ? replaceRef.current : findRef.current;
    el?.focus();
    el?.select();
  }, [p.focus.nonce]);

  const c = { ...p.count, empty: !p.spec.search, valid: p.valid, quiet: p.quiet };
  const wide = counterText(c, false);
  const narrow = counterText(c, true);
  const none = !p.valid || p.count.total === 0;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const field = target === findRef.current ? 'find' : target === replaceRef.current ? 'replace' : 'other';
    const found = shortcutAction(e.nativeEvent, field, p.readOnly);
    const action = found && swapEnter(found, !!p.enterUp);
    if (action) {
      e.preventDefault();
      e.stopPropagation();
      p.onAction(action);
    } else if (p.onOtherKey(e)) {
      e.preventDefault();
    }
  };

  const opt = (on: boolean, label: string, kbd: string, action: FindAction, body: ReactNode) => (
    <button type="button" className={`fc-opt${on ? ' is-on' : ''}`} aria-label={label} aria-pressed={on} data-tip={label} data-kbd={kbd}
      onMouseDown={(e) => e.preventDefault()} onClick={() => p.onAction(action)}>{body}</button>
  );

  return (
    <>
    {/* The editor's context menu (Copy, Select All of the code) is not the card's. */}
    <div ref={card} className={`find-card cm-search${p.readOnly ? ' is-readonly' : ''}`} role="search" aria-label={t.find.card} onKeyDown={onKeyDown}
      onContextMenu={(e) => e.stopPropagation()}>
      <span className="fc-hair" aria-hidden="true" />
      <div className="fc-grid">
        <div className={`fc-field${p.valid && !(p.spec.search && p.count.total === 0 && !p.quiet) ? '' : ' is-error'}`}>
          <span className="fc-lead"><Icon name="search" size={14} stroke={1.8} /></span>
          {/* main-field: CodeMirror's own commands (⌘G with nothing to find) focus it. */}
          <input ref={findRef} type="text" aria-label={t.find.find} placeholder={t.find.find} spellCheck={false} autoComplete="off" value={search} main-field="true"
            onChange={(e) => { setSearch(e.target.value); p.onSpec({ search: e.target.value }); }} />
          {opt(p.spec.caseSensitive, t.find.matchCase, kbd('⌥C'), 'toggleCase', 'Aa')}
          {opt(p.spec.wholeWord, t.find.wholeWord, kbd('⌥W'), 'toggleWord',
            <span className="fc-ww">ab<svg width="13" height="4" viewBox="0 0 13 4" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="M1 .5v2h11v-2" /></svg></span>)}
          {opt(p.spec.regexp, t.find.regexp, kbd('⌥R'), 'toggleRegex', '.*')}
        </div>
        <div className="fc-tail">
          {/* Screen readers hear the full form at any width. */}
          <span className="fc-sr" aria-live="polite">{wide.text}</span>
          <span className={`fc-count is-${wide.tone}`} aria-hidden="true">
            <span className="fc-wide">{wide.text}</span>
            <span className="fc-narrow">{narrow.text}</span>
          </span>
          <button type="button" className="fc-icon" aria-label={t.find.prev} data-tip={t.find.prev} data-kbd={p.enterUp ? '↵' : kbd('⇧↵')} disabled={none}
            onMouseDown={(e) => e.preventDefault()} onClick={() => p.onAction('prev')}><Icon name="chevronUp" size={15} stroke={1.8} /></button>
          <button type="button" className="fc-icon" aria-label={t.find.next} data-tip={t.find.next} data-kbd={p.enterUp ? kbd('⇧↵') : '↵'} disabled={none}
            onMouseDown={(e) => e.preventDefault()} onClick={() => p.onAction('next')}><Icon name="chevronDown" size={15} stroke={1.8} /></button>
          <span className="fc-sep" aria-hidden="true" />
          <button type="button" className="fc-icon" aria-label={t.find.close} data-tip={t.find.close} data-kbd="Esc"
            onClick={() => p.onAction('close')}><Icon name="x" size={14} stroke={1.8} /></button>
        </div>
        {p.regexError && <div className="fc-error" role="alert"><span className="fc-error-dot" />{p.regexError}</div>}
        {p.note && !p.regexError && <div className="fc-note">{p.note}</div>}
        {showReplace && (
          <>
            <div className="fc-field">
              <span className="fc-lead"><Icon name="swap" size={14} stroke={1.7} /></span>
              <input ref={replaceRef} type="text" aria-label={t.find.replace} placeholder={t.find.replace} spellCheck={false} autoComplete="off" value={replace}
                onChange={(e) => { setReplace(e.target.value); p.onSpec({ replace: e.target.value }); }} />
            </div>
            <div className="fc-btns">
              {/* The keyboard stays in the field: a button that ends up disabled would drop focus to the page. */}
              <button type="button" className="fc-btn" data-tip={t.find.replace} data-kbd="↵" disabled={none}
                onMouseDown={(e) => e.preventDefault()} onClick={() => p.onAction('replace')}>{t.find.replace}</button>
              <button type="button" className="fc-btn is-brand" aria-label={t.find.replaceAll} data-tip={t.find.replaceAll} data-kbd={kbd('⌘↵')} disabled={none}
                onMouseDown={(e) => e.preventDefault()} onClick={() => p.onAction('replaceAll')}>
                <span className="fc-wide">{t.find.replaceAll}</span><span className="fc-narrow" aria-hidden="true">{t.find.replaceAllShort}</span>
              </button>
            </div>
          </>
        )}
      </div>
      {/* Drawn first (CSS order), reached after the find row by Tab. */}
      {!p.readOnly && (
        <button type="button" className={`fc-chev${showReplace ? ' is-open' : ''}`} aria-label={t.find.toggleReplace} aria-expanded={showReplace}
          data-tip={t.find.toggleReplace} data-kbd={kbd('⌥⌘F')} onClick={p.onToggleReplace}>
          <Icon name="chevron" size={13} stroke={2} />
        </button>
      )}
    </div>
    {p.onSearchAll && (
      <button type="button" className="fc-all" data-tip={t.find.searchAll} data-kbd={kbd('⇧⌘F')} onClick={p.onSearchAll}
        onContextMenu={(e) => e.stopPropagation()}>
        <Icon name="search" size={12} stroke={1.8} />{t.find.searchAll}
      </button>
    )}
    </>
  );
}
