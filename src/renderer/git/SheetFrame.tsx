// The git sheets' frame: the palette's centered top surface with an icon tile and the question as
// its title. Esc or a click outside closes; the element marked data-autofocus takes the focus (Enter presses it), Tab
// stays inside, and the focus goes back where it was when the sheet closes. An Enter held from before, or pressed as the
// sheet appears, never answers it (a sheet opened by an op's answer can come up under a typing hand); once text went into
// one of its fields, the hand is on the sheet and its Enter answers at once (a URL put in Add Connection, then Enter).
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Icon, type IconName } from '../components/Icon';
import { useApp } from '../store';
import { openerOf, swallowEnter, trapTab, typedText } from './sheet-keys';

export const closeGitSheet = () => useApp.getState().setGitSheet(null);

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]';

/**
 * onClose: what Esc and a click outside do (the git sheets: close the git sheet); className: the sheet's own look; aside:
 * what the head holds after the title (Add Connection's engine chip and Close).
 */
export function SheetFrame({ title, icon, tone = 'brand', onClose = closeGitSheet, className, aside, children }: { title: string; icon: IconName; tone?: 'brand' | 'warn' | 'danger'; onClose?: () => void; className?: string; aside?: ReactNode; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const mountedAt = useRef(performance.now());
  // Text went into one of its fields since it appeared: the hand is on the sheet, its Enter answers at once.
  const typed = useRef(false);
  const early = (e: KeyboardEvent) => swallowEnter({ key: e.key, repeat: e.repeat, metaKey: e.metaKey, ctrlKey: e.ctrlKey }, mountedAt.current, performance.now(), typed.current);
  // What had the focus as the sheet first rendered: read now, since a child's mount effect runs before this frame's and
  // may already have moved the focus inside (openerOf).
  const [rendered] = useState(() => {
    const a = typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null;
    return a && typeof a.focus === 'function' ? a : null;
  });
  useEffect(() => {
    const el = box.current;
    const a = document.activeElement;
    const before = openerOf(rendered, a instanceof HTMLElement && a !== document.body ? a : null, (e) => !!el?.contains(e));
    mountedAt.current = performance.now();
    const first = el?.querySelector<HTMLElement>('[data-autofocus]:not(:disabled)');
    (first ?? el)?.focus();
    // Back where it was (a row, the Sync button), unless it went away or something else took the focus meanwhile.
    return () => {
      const now = document.activeElement;
      if (before?.isConnected && (!now || now === document.body || el?.contains(now))) before.focus({ preventScroll: true });
    };
  }, [rendered]);
  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div ref={box} className={`palette git-sheet${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onInputCapture={(e) => { if (typedText(e.nativeEvent as { inputType?: string })) typed.current = true; }}
        onKeyDownCapture={(e) => {
          if (early(e)) { e.preventDefault(); e.stopPropagation(); }
        }}
        // The Enter that opened the sheet (a field's, a menu item's) reaches its focused button as a keypress: the same
        // grace, or that button answers on its own.
        onKeyPressCapture={(e) => {
          if (early(e)) { e.preventDefault(); e.stopPropagation(); }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
          if (e.key !== 'Tab' || !box.current) return;
          // One stop per control; a radio group's roving tabindex leaves only its checked radio in.
          const list = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.tabIndex >= 0 && el.offsetParent !== null);
          const to = trapTab(list.length, list.indexOf(document.activeElement as HTMLElement), e.shiftKey);
          if (to !== null) { e.preventDefault(); list[to]!.focus(); }
        }}>
        <div className="git-sheet-head">
          <span className={`git-sheet-icon is-${tone}`} aria-hidden="true"><Icon name={icon} size={15} stroke={1.9} /></span>
          <h2 className="git-sheet-title">{title}</h2>
          {aside}
        </div>
        {children}
      </div>
    </div>
  );
}

/** A commit line in a sheet: its short oid, subject and author. */
export function SheetCommit({ oid, subject, author }: { oid: string; subject: string; author: string }) {
  return (
    <li className="git-sheet-commit">
      <span className="git-sheet-oid mono">{oid.slice(0, 7)}</span>
      <span className="git-sheet-subject">{subject}</span>
      <span className="git-sheet-author">{author}</span>
    </li>
  );
}
