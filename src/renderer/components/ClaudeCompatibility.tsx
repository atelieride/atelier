import { Fragment, useEffect, useRef, useState, type MouseEvent } from 'react';
import type { SignalEntry } from '@shared/claude-signals';
import { compatStatus, copyText, entryParts } from '../claude-signals-view';
import { copyText as toClipboard } from '../clipboard';
import { useApp } from '../store';
import { t } from '../i18n/en';
import { Icon } from './Icon';
import { Row } from './Settings';
import { reducedMotion } from './background/parts';

// Settings › Claude › Claude Code compatibility: what Claude Code sent that
// Atelier doesn't recognize yet, as atelierd noted it. Quiet on purpose: this row is the only place it shows.

/** Settings › Claude, scrolled to the row, the keyboard's focus on it (palette "Claude Code Compatibility…"). */
export function openClaudeCompat(): void {
  useApp.getState().setSettingsOpen('claude');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    // The last row: `start` scrolls the section to its end, the row and the note under it in full.
    const row = document.querySelector<HTMLElement>('.compat');
    row?.scrollIntoView({ block: 'start' });
    // The list's toggle when something is noted, else Copy (as openLaunchFlags focuses its field).
    (row?.querySelector<HTMLElement>('.compat-fold') ?? row?.querySelector<HTMLElement>('.compat-copy'))?.focus({ preventScroll: true });
  }));
}

/** For a bug report, through main's clipboard (the renderer has none of its own). */
async function copyBook(): Promise<void> {
  const book = useApp.getState().claudeSignals;
  if (!book) return;
  const version = await window.atelier.appInfo().then((i) => i?.version ?? 'unknown', () => 'unknown');
  if (await toClipboard(copyText(book, version))) useApp.getState().showToast(t.set.compatCopied, undefined, 'info');
}

const keyOf = (e: SignalEntry) => `${e.kind}\u0000${e.event ?? ''}\u0000${e.value}\u0000${e.version ?? ''}`;

/** One entry as one mono line, the value set apart; a long one wraps under itself (nothing hidden behind an ellipsis). */
function EntryLine({ e }: { e: SignalEntry }) {
  return (
    <li>
      {entryParts(e).map((part, i) => (
        <Fragment key={i}>{i > 0 && <span className="compat-sep"> · </span>}<span className={i === 2 ? 'compat-value' : undefined}>{part}</span></Fragment>
      ))}
    </li>
  );
}

export function ClaudeCompatibility() {
  const book = useApp((s) => s.claudeSignals);
  // The capability, not the book: get() is null too while atelierd is away or before its first book.
  const available = useApp((s) => !(s.daemon.connected && !s.daemon.signalsAvailable));
  const status = compatStatus(book, available);
  const [open, setOpen] = useState(false);
  const copyButton = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  // Nothing left to list (a Clear, here or in another window): the next entries start closed again.
  useEffect(() => { if (status.count === 0) setOpen(false); }, [status.count]);
  // The row is the section's last: an opened list would start below the fold.
  useEffect(() => { if (open) list.current?.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' }); }, [open]);
  const clear = (e: MouseEvent<HTMLButtonElement>) => {
    // Clear disables itself once the empty book is back: the keyboard's focus goes to Copy (as the Stepper's does).
    if (document.activeElement === e.currentTarget) copyButton.current?.focus();
    void window.atelier.claudeSignals.clear().catch(() => {});
  };
  const n = String(status.count);
  return (
    <div className={`compat${status.disabled ? ' is-off' : ''}`} data-testid="claude-compat">
      <Row label={t.set.compat} hint={t.set.compatHint} disabled={status.disabled}>
        <div className="compat-actions">
          <button ref={copyButton} type="button" className="btn-ghost sm compat-copy" disabled={status.disabled || !book} onClick={() => void copyBook()}>
            <Icon name="copy" size={12} stroke={1.8} />{t.set.compatCopy}
          </button>
          <button type="button" className="btn-ghost sm" disabled={status.disabled || status.count === 0} onClick={clear}>
            <Icon name="eraser" size={12} stroke={1.8} />{t.set.compatClear}
          </button>
        </div>
      </Row>
      {status.count > 0 ? (
        <button type="button" className={`compat-status compat-fold${open ? ' is-open' : ''}`} aria-expanded={open} aria-controls={open ? 'compat-list' : undefined} onClick={() => setOpen((v) => !v)}>
          <Icon name="chevron" size={11} stroke={2.2} />
          {/* "**3** values Atelier doesn't recognize yet": the count stands out. */}
          <span>{status.text.startsWith(n) ? <><b className="mono">{n}</b>{status.text.slice(n.length)}</> : status.text}</span>
        </button>
      ) : (
        <p className={`compat-status${status.disabled ? ' is-off' : ' is-ok'}`}>
          <Icon name={status.disabled ? 'info' : 'check'} size={12} stroke={2} />{status.text}
        </p>
      )}
      {open && book && status.count > 0 && (
        <ul ref={list} id="compat-list" className="compat-list mono" aria-label={status.text}>
          {book.entries.map((e) => <EntryLine key={keyOf(e)} e={e} />)}
        </ul>
      )}
    </div>
  );
}
