// A connection in the Databases sidebar: its row — glyph with the state dot, name,
// environment tag, sub line — and under it what it needs: a password, a fix for what stopped it, or the note
// that its role can write. A state change updates the row where it is: rows never move by themselves, and a note
// whose own action runs (Connect, Try Again, a TLS fix) stays as it is until main answers — no collapse mid-action.
import { useEffect, useRef, useState, type RefObject } from 'react';
import { envLabel, type DbConnView, type DbProblem } from '@shared/databases';
import { Icon } from '../components/Icon';
import { tdb } from '../i18n/db';
import { useApp } from '../store';
import { attempt, connMenu, problemAction, selectConn } from './menus';
import { connSub, noteFor, problemActions, problemParts, stateDot, type NoteKind, type ProblemAction } from './side';
import { envClass } from './view';

const s = tdb.side;
const f = tdb.fail;
const api = () => window.atelier.databases;
/** Main's word for a refused answer or a warning: said as a toast, the row says the rest. */
const toast = (text: string) => useApp.getState().showToast(text);
type Pending = (k: NoteKind | null) => void;

/**
 * A note's button: its label ellipsizes when the sidebar is narrower than it (a long one keeps it in a tooltip). While
 * an action runs it stays enabled — the focus stays on it — and says it's busy; the note ignores clicks meanwhile.
 */
function NoteButton({ label, primary = false, long = false, busy = false, waiting = false, onClick }: {
  label: string; primary?: boolean; long?: boolean; busy?: boolean; waiting?: boolean; onClick: () => void;
}) {
  return (
    <button type="button" className={`${primary ? 'btn-primary' : 'btn-ghost'} sm`} data-tip={long ? label : undefined}
      aria-busy={busy || undefined} aria-disabled={waiting || undefined} onClick={onClick}><span>{label}</span></button>
  );
}

/**
 * Needs a password: the field, Save in Keychain (on), Connect. Focused when the row's click asked for it; while
 * Connect runs the value stays and the note with it; refused, the field is focused with its text selected.
 */
function PasswordNote({ v, row, onPending }: { v: DbConnView; row: RefObject<HTMLButtonElement | null>; onPending: Pending }) {
  const [password, setPassword] = useState('');
  const [save, setSave] = useState(true);
  const [busy, setBusy] = useState(false);
  // What the note said when Connect was pressed: kept while main says "connecting", so the note keeps its height.
  const [said, setSaid] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => { if (row.current && document.activeElement === row.current) field.current?.focus(); }, [row]);
  // A refused password is said here; "needs a password" is on the row already (decided by kind, never by main's words).
  const wrong = v.problem?.kind === 'auth' ? v.problem.message : null;
  const shown = busy ? said : wrong;
  const submit = async () => {
    if (!password || busy) return;
    const hadFocus = !!form.current?.contains(document.activeElement);
    setBusy(true);
    setSaid(wrong);
    onPending('password');
    // A typed password lets main's hold go too.
    const r = await attempt(() => api().password({ connId: v.conn.id, password, save }), f.connect);
    setBusy(false);
    onPending(null);
    if (r?.ok) {
      setPassword('');
      if (r.warning) toast(r.warning);
      if (hadFocus) row.current?.focus();
    } else {
      field.current?.focus();
      field.current?.select();
    }
  };
  return (
    <form ref={form} className="db-note is-pass" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      {shown && <p className="db-note-err is-err" role="alert">{shown}</p>}
      <input ref={field} className="db-pass-input" type="password" value={password} placeholder={s.password} aria-label={s.passwordFor(v.conn.name)}
        autoComplete="off" spellCheck={false} readOnly={busy} onChange={(e) => setPassword(e.target.value)} />
      <div className="db-pass-row">
        <label className="db-pass-save">
          <button type="button" role="switch" aria-checked={save} className={`switch${save ? ' is-on' : ''}`} onClick={() => setSave((x) => !x)}><i /></button>
          <span data-tip={s.saveInKeychain}>{s.saveInKeychain}</span>
        </label>
        <button type="submit" className="btn-primary sm" disabled={!password} aria-busy={busy || undefined}>{s.connect}</button>
      </div>
    </form>
  );
}

const ACTION_LABEL: Record<ProblemAction, string> = {
  retry: s.tryAgain, edit: s.edit, tlsOff: s.tlsOff, useTls: s.useTls, useRequire: s.useRequire, refresh: s.refreshCatalog
};
const FIXES: readonly ProblemAction[] = ['tlsOff', 'useTls', 'useRequire'];

/**
 * A problem: the cause, its detail (and Postgres's SQLSTATE) and hint, what to do. Under a
 * row, or above the picked connection's catalog when main couldn't read it (`actions`: Refresh). While a button's action
 * runs, the note shows what it showed when pressed and that button says it's busy.
 */
export function ProblemNote({ v, p, actions, row, onPending }: {
  v: DbConnView; p: DbProblem | null; actions?: readonly ProblemAction[]; row?: RefObject<HTMLButtonElement | null>; onPending?: Pending;
}) {
  const [busy, setBusy] = useState<ProblemAction | null>(null);
  const [held, setHeld] = useState<DbProblem | null>(null);
  const shown = busy ? held : p;
  if (!shown) return null;
  const { title, detail, code } = problemParts(shown);
  const list = actions ?? problemActions(shown.kind);
  const run = async (a: ProblemAction) => {
    if (busy) return;
    const hadFocus = !!(document.activeElement as HTMLElement | null)?.closest?.('.db-note');
    setBusy(a);
    setHeld(shown);
    onPending?.('problem');
    const ok = await problemAction(v, a);
    setBusy(null);
    setHeld(null);
    onPending?.(null);
    // The note goes once it worked: the focus goes back to its row.
    if (ok && hadFocus && a !== 'edit') row?.current?.focus();
  };
  return (
    <div className="db-note is-err" role="status">
      <p className="db-note-title">{title}</p>
      {detail && <p className="db-note-detail mono">{detail}</p>}
      {code && <p className="db-note-code mono">{s.sqlState(code)}</p>}
      {shown.hint && <p className="db-note-hint">{shown.hint}</p>}
      {list.length > 0 && (
        <div className="db-note-actions">
          {/* A TLS fix is the way out: it leads; the others are as calm as the board's Try Again. */}
          {list.map((a) => (
            <NoteButton key={a} label={ACTION_LABEL[a]} primary={FIXES.includes(a)} busy={busy === a} waiting={busy !== null && busy !== a} onClick={() => void run(a)} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The role can write: one quiet line — an amber dot, the sentence (its reason in the tooltip),
 * a × that dismisses it for this connection. The read-only role's script is in the connection's menu.
 */
function WriteNote({ v }: { v: DbConnView }) {
  return (
    <div className="db-write" role="note">
      <i className="db-write-dot" aria-hidden="true" />
      <span className="db-write-text" data-tip={s.writeTip}>{s.writeLine}</span>
      <button type="button" className="db-write-x" aria-label={s.dismiss} data-tip={s.dismiss}
        onClick={() => void attempt(() => api().noteWrite(v.conn.id), f.dismiss)}><Icon name="x" size={12} stroke={1.9} /></button>
    </div>
  );
}

export function ConnRow({ v, selected }: { v: DbConnView; selected: boolean }) {
  const row = useRef<HTMLButtonElement>(null);
  // The note whose own action is running: it stays until main answers (static UI).
  const [pending, setPending] = useState<NoteKind | null>(null);
  const c = v.conn;
  const sub = connSub(v, selected);
  const note = noteFor(v, pending);
  const cls = `db-conn${selected ? ' is-selected' : ''}${v.state === 'connected' ? ' is-connected' : ''}${v.state === 'idle' ? ' is-idle' : ''}`
    + `${v.state === 'error' ? ' is-error' : ''}${c.env === 'prod' ? ' is-prod' : ''}`;
  return (
    <>
      {/* data-conn: where Remove Connection… asks (ConnectionSheet.tsx). */}
      <button ref={row} type="button" className={cls} data-nav="" data-conn={c.id} aria-current={selected || undefined} data-tip={`${c.name}\n${sub}`}
        onClick={() => void selectConn(c.id)} onContextMenu={(e) => useApp.getState().openMenu(e, connMenu(v))}>
        <span className="db-glyph"><Icon name="databases" size={16} /><i className={`db-st is-${stateDot(v)}`} aria-hidden="true" /></span>
        <span className="db-conn-text">
          <span className="db-conn-name"><span className="db-name">{c.name}</span><span className={`db-env ${envClass(c.env)}`}>{envLabel(c.env)}</span></span>
          <span className="db-conn-sub">{sub}</span>
        </span>
      </button>
      {note === 'password' && <PasswordNote key={c.id} v={v} row={row} onPending={setPending} />}
      {note === 'problem' && <ProblemNote v={v} p={v.problem} row={row} onPending={setPending} />}
      {note === 'write' && <WriteNote v={v} />}
    </>
  );
}
