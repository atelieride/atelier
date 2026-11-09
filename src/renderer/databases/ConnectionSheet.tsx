// Add / Edit Connection and Remove Connection…. Add is a centered sheet in two
// steps — a connection URL or an engine, then the form — and Edit is the form alone; both
// test with the form's values and save, then connect. The password lives in this sheet's own state only: never in the
// store past the moment the sheet reads it, never in a DOM attribute (the field gets it through its property), never in
// a toast. Remove asks in place, under its row. Loaded on demand with the view's stylesheet.
import '../databases.css';
import { useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { DB_ENGINES, type DbConnView, type DbEnv, type DbProblem, type DbTls } from '@shared/databases';
import { Icon } from '../components/Icon';
import { Segmented } from '../components/Segmented';
import { ConfirmPopover } from '../confirms/ConfirmPopover';
import { ConfirmActions } from '../confirms/InlineConfirm';
import { SheetFrame } from '../git/SheetFrame';
import { tdb } from '../i18n/db';
import { useApp } from '../store';
import {
  IDLE_RUN, chipOf, controlsOf, draftFrom, draftOfConn, formErrors, formToConnection, hostText, passwordMode, patchDraft, removedElsewhere, runStep,
  settles, startFromUrlField, takePastedPassword, testArgs, urlFieldError, withHostText, type DbDraft, type DraftBase, type DraftField, type DraftStart,
  type TestResult
} from './form';
import { attempt, selectConn } from './menus';
import { problemParts } from './side';
import { useDb, type DbSheet } from './store';

const s = tdb.sheet;
const api = () => window.atelier.databases;
const close = () => useDb.getState().setSheet(null);
const toast = (text: string) => useApp.getState().showToast(text);
const PG = DB_ENGINES.find((e) => e.id === 'postgres')!;

/** A string with `code` in backticks, as nodes. */
function withCode(text: string): ReactNode[] {
  return text.split('`').map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));
}

/** The open sheet: Add (two steps), Edit, or Remove's confirm. */
export function DbSheets() {
  const sheet = useDb((st) => st.sheet);
  if (!sheet) return null;
  if (sheet.kind === 'remove') return <RemoveConfirm key={`remove:${sheet.id}`} id={sheet.id} />;
  if (sheet.kind === 'edit') return <EditSheet key={`edit:${sheet.id}`} id={sheet.id} />;
  return <AddSheet sheet={sheet} />;
}

/** The head's end: the engine (step 2) and Close. */
function Aside({ engine }: { engine: boolean }) {
  return (
    <span className="db-sheet-aside">
      {engine && <span className="db-chip is-vio"><b className="mono">{PG.mono}</b>{PG.label}</span>}
      <button type="button" className="icon-btn" aria-label={s.close} data-tip={s.close} onClick={close}><Icon name="x" size={14} /></button>
    </span>
  );
}

function AddSheet({ sheet }: { sheet: Extract<DbSheet, { kind: 'add' }> }) {
  // ⌘V with a URL opens at the form; its password is read only to know there is one.
  const [start, setStart] = useState<DraftStart | null>(() => (sheet.step === 2
    ? { draft: draftFrom(sheet.form ?? {}), password: '', pasted: true, hasPassword: !!sheet.password, prefilled: sheet.form !== undefined, base: null }
    : null));
  // On the sheet's mount the frame focuses its [data-autofocus] field; a step changed by them, the step does.
  const [moved, setMoved] = useState(false);
  const go = (next: DraftStart | null) => {
    setMoved(true);
    setStart(next);
  };
  return (
    <SheetFrame title={s.addTitle} icon="databases" onClose={close} className="db-sheet" aside={<Aside engine={start !== null} />}>
      {start ? <ConnectionForm start={start} base={start.base} focusOnMount={moved} onBack={() => go(null)} /> : <PickStep focusOnMount={moved} onNext={go} />}
    </SheetFrame>
  );
}

function EditSheet({ id }: { id: string }) {
  const v = useDb((st) => st.snap.connections.find((c) => c.conn.id === id) ?? null);
  const loaded = useDb((st) => st.loaded);
  // Never this window's: nothing to edit.
  useEffect(() => { if (!v && loaded) close(); }, [v, loaded]);
  // Removed in another window while open (concurrent edits, the last write wins), or no longer shown here (a
  // move to another project's scope, Never): said apart, then closed.
  useEffect(() => useDb.subscribe((now, prev) => {
    const app = useApp.getState();
    const gone = now.loaded ? removedElsewhere(id, prev.snap, now.snap, app.project?.root ?? '', app.settings.showDatabases === 'never') : null;
    if (gone === null || now.sheet?.kind !== 'edit' || now.sheet.id !== id) return;
    toast(gone.removed ? s.removedElsewhere(gone.name) : s.notShownHere(gone.name));
    close();
  }), [id]);
  return v ? <EditForm v={v} /> : null;
}

function EditForm({ v }: { v: DbConnView }) {
  const [start] = useState<DraftStart>(() => ({ draft: draftOfConn(v.conn), password: '', pasted: false, hasPassword: false, prefilled: true, base: null }));
  return (
    <SheetFrame title={s.editTitle} icon="databases" onClose={close} className="db-sheet" aside={<Aside engine />}>
      <ConnectionForm start={start} base={{ kind: 'edit', conn: v.conn, hasPassword: v.hasPassword }} editId={v.conn.id} focusOnMount={false} />
    </SheetFrame>
  );
}

/** Focuses a step's first field when the user moved to it (Continue, Back); on the sheet's mount the frame does. */
function useStepFocus(body: React.RefObject<HTMLDivElement | null>, focusOnMount: boolean): void {
  useEffect(() => {
    if (focusOnMount) body.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }, [body, focusOnMount]);
}

/** Step 1: a URL (paste, or type and Enter) or an engine. */
function PickStep({ onNext, focusOnMount }: { onNext: (s: DraftStart) => void; focusOnMount: boolean }) {
  const body = useRef<HTMLDivElement>(null);
  // Not a controlled field: a typed URL's password never becomes an attribute.
  const url = useRef<HTMLInputElement>(null);
  // What the field says when Continue can't take its text (null: the hint).
  const [bad, setBad] = useState<string | null>(null);
  useStepFocus(body, focusOnMount);
  const next = (via: 'continue' | 'engine') => {
    const text = url.current?.value ?? '';
    const st = startFromUrlField(text, via);
    if (st) onNext(st);
    else {
      setBad(urlFieldError(text));
      url.current?.focus();
    }
  };
  return (
    <>
      <div ref={body} className="db-sheet-body">
        <div className="db-field">
          <label htmlFor="db-f-url">{s.url}</label>
          <div className={`db-input is-url${bad ? ' is-invalid' : ''}`}>
            <Icon name="plug" size={14} />
            <input ref={url} id="db-f-url" placeholder={s.urlPlaceholder} spellCheck={false} autoComplete="off" data-autofocus aria-invalid={bad !== null || undefined}
              onChange={() => setBad(null)}
              onPaste={(e) => {
                const text = e.clipboardData.getData('text/plain');
                const st = text.trim() ? startFromUrlField(text, 'continue') : null;
                if (!st) return;
                e.preventDefault();
                onNext(st);
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); next('continue'); } }} />
          </div>
          {bad ? <span className="db-field-err" role="alert">{withCode(bad)}</span> : <span className="db-field-hint">{s.urlHint}</span>}
        </div>
        <div className="db-or"><span className="section-label">{s.pickEngine}</span></div>
        <div className="db-engines">
          {DB_ENGINES.map((e) => (e.ready ? (
            // The engine opens its form: filled from a valid URL in the field above, blank otherwise — never the URL error.
            <button key={e.id} type="button" className="db-engine is-on" aria-pressed="true" onClick={() => next('engine')}>
              <span className="db-engine-mono">{e.mono}</span>
              <span className="db-engine-text"><b>{e.label}</b><span>{e.note}</span></span>
            </button>
          ) : (
            // "Later" under the name and what it reads: beside them it squeezed both at the sheet's width.
            <button key={e.id} type="button" className="db-engine" disabled data-tip={s.laterTip(e.label)}>
              <span className="db-engine-mono">{e.mono}</span>
              <span className="db-engine-text"><b>{e.label}</b><span>{e.note}</span><span className="db-later">{s.later}</span></span>
            </button>
          )))}
        </div>
        <div className="db-sheet-note is-vio">
          <Icon name="check" size={14} />
          <span>{s.speaks} <b>{s.speaksList}</b></span>
        </div>
      </div>
      <div className="db-sheet-foot">
        <span className="db-sheet-lock"><Icon name="lock" size={14} /><span>{s.opensReadOnly}</span></span>
        <button type="button" className="btn-ghost" onClick={close}>{s.cancel}</button>
        <button type="button" className="btn-primary" onClick={() => next('continue')}>{s.continue}</button>
      </div>
    </>
  );
}

const ENVS: DbEnv[] = ['local', 'dev', 'staging', 'prod'];
const TLS: DbTls[] = ['off', 'prefer', 'require', 'verify'];

/** A problem: its title, the detail in mono, Postgres's SQLSTATE quiet, a hint. */
function ProblemText({ p, lead }: { p: DbProblem; lead?: string }) {
  const { title, detail, code } = problemParts(p);
  return (
    <span className="db-sheet-note-text">
      {lead && <span className="db-sheet-note-code">{lead}</span>}
      <span className="db-sheet-note-title">{title}</span>
      {detail && <span className="db-sheet-note-mono">{detail}</span>}
      {code && <span className="db-sheet-note-code">{tdb.side.sqlState(code)}</span>}
      {p.hint && <span className="db-sheet-note-hint">{p.hint}</span>}
    </span>
  );
}

/** Test Connection's answer: connected, with the server's line; or the problem. */
export function TestNote({ result }: { result: TestResult }) {
  if (result.kind === 'err') {
    return <div className="db-sheet-note is-err" role="alert"><Icon name="warning" size={16} /><ProblemText p={result.problem} /></div>;
  }
  const v = result.server;
  return (
    <div className="db-sheet-note is-ok" role="status">
      <Icon name="check" size={16} />
      <span className="db-sheet-note-text">
        <span className="db-sheet-note-title">{s.connectedIn(Math.round(v.latencyMs))}</span>
        <span className="db-sheet-note-mono">{s.server(v.version, v.tls, v.role)}{v.canWrite ? <span className="db-sheet-warn">{s.canWrite}</span> : s.canRead}</span>
      </span>
    </div>
  );
}

/** Main refused the save: a save problem, led by "Not saved" — never mistaken for a test's answer. */
export function SaveProblem({ problem }: { problem: DbProblem }) {
  return <div className="db-sheet-note is-err" role="alert"><Icon name="warning" size={16} /><ProblemText p={problem} lead={s.notSaved} /></div>;
}

interface FormState { draft: DbDraft; root: string; password: string; base: DraftBase }

/** Test Connection: connects with the form's values and closes; null when the call itself failed (said). */
export async function testConnection(f: FormState): Promise<TestResult | null> {
  const r = await attempt(() => api().test(testArgs(f.draft, f.root, f.password, f.base)), s.fail.test);
  return r && (r.ok ? { kind: 'ok', server: r.value } : { kind: 'err', problem: r.problem });
}

/**
 * Save and Connect: saved as typed (a new connection, or the edit of `editId`), then picked and connected, the sheet
 * closed and a warning said (the Keychain refused the password). The problem main refused with, for the
 * sheet to show; null otherwise (a call that failed is said in a toast).
 */
export async function saveAndConnect(f: FormState & { editId: string | null }): Promise<DbProblem | null> {
  const form = formToConnection(f.draft, f.root);
  const r = await attempt(() => api().save({ form, password: f.password || null, id: f.editId }), s.fail.save);
  if (!r) return null;
  if (!r.ok) return r.problem;
  close();
  if (r.warning) toast(r.warning);
  await selectConn(r.value.id);
  return null;
}

/**
 * Remove: the sheet goes at once; main removes the connection's entry, its pick and its Keychain secret, and
 * this window closes its tabs. A call that failed is said, and the tabs stay.
 */
export async function removeConnection(id: string): Promise<void> {
  close();
  // A void call: undefined once done, null when it failed (and said so).
  if ((await attempt(() => api().remove(id), s.fail.remove)) === null) return;
  useApp.getState().closeDbTabs((r) => r.connId === id);
}

/** The field focused first: what is missing, else the password when none is known yet, else the name. */
function firstField(st: DraftStart, base: DraftBase): DraftField | 'password' {
  if (base?.kind === 'edit') return 'name';
  const errs = formErrors(st.draft);
  const missing = (['host', 'port', 'database', 'user'] as const).find((k) => errs[k]);
  if (missing) return missing;
  return st.hasPassword ? 'name' : 'password';
}

/** Step 2, and Edit: the form, the read-only note, the answers; Test, Cancel, Save and Connect. */
function ConnectionForm({ start, base, editId = null, focusOnMount, onBack }: {
  start: DraftStart; base: DraftBase; editId?: string | null; focusOnMount: boolean; onBack?: () => void;
}) {
  const root = useApp((x) => x.project?.root ?? '');
  const projectName = useApp((x) => x.project?.name ?? '');
  const timeout = useApp((x) => x.settings.dbTimeoutSec);
  const [d, setD] = useState(start.draft);
  // The last draft whose ports read as numbers: a port half-typed keeps the password field's decision (passwordMode).
  const [settled, setSettled] = useState(start.draft);
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState<ReadonlySet<DraftField>>(() => new Set());
  const [run, dispatch] = useReducer(runStep, IDLE_RUN);
  const [focus] = useState(() => firstField(start, base));
  const body = useRef<HTMLDivElement>(null);
  const pw = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  // The password into the field through its property, never an attribute; a pasted one out of the store at once.
  useLayoutEffect(() => {
    const p = start.pasted ? takePastedPassword() : start.password;
    if (p && pw.current) {
      pw.current.value = p;
      setPassword(p);
    }
  }, [start]);
  useStepFocus(body, focusOnMount);

  const errs = formErrors(d);
  const ok = Object.keys(errs).length === 0;
  const c = controlsOf(run, ok);
  const shown = (k: DraftField) => (start.prefilled || touched.has(k) ? errs[k] : undefined);
  const touch = (k: DraftField) => setTouched((t) => (t.has(k) ? t : new Set(t).add(k)));
  /** A change the user made; one that reaches the server drops the test's answer (it was for other values). */
  const change = (next: DbDraft, server = true) => {
    setD(next);
    if (settles(next)) setSettled(next);
    dispatch({ type: 'change', server });
  };
  const mode = passwordMode(d, base, settled);
  const placeholder = mode === 'saved' ? s.saved : '';
  const pwHint = password || c.locked ? null : mode === 'new-server' ? s.newServer : null;

  const test = async () => {
    if (!c.canTest) return;
    const gen = run.gen;
    dispatch({ type: 'test' });
    const result = await testConnection({ draft: d, root, password, base });
    if (alive.current) dispatch({ type: 'tested', gen, result });
  };

  const save = async () => {
    if (!c.canSave) return;
    dispatch({ type: 'save' });
    const problem = await saveAndConnect({ draft: d, root, password, base, editId });
    // The sheet stays with the problem; closed meanwhile, the problem is said anyway.
    if (alive.current) dispatch({ type: 'saved', problem });
    else if (problem) toast(problem.message);
  };

  const input = (k: DraftField, value: string, set: (v: string) => void, o: { placeholder?: string; text?: boolean; max?: number; numeric?: boolean; end?: ReactNode } = {}) => {
    const err = shown(k);
    return (
      <div className={`db-input${o.text ? ' is-text' : ''}${err ? ' is-invalid' : ''}`}>
        <input id={`db-f-${k}`} value={value} placeholder={o.placeholder} maxLength={o.max} inputMode={o.numeric ? 'numeric' : undefined} spellCheck={false} autoComplete="off"
          readOnly={c.locked} aria-invalid={err ? true : undefined} aria-describedby={err ? `db-e-${k}` : undefined} data-autofocus={focus === k ? '' : undefined}
          onChange={(e) => set(e.currentTarget.value)} onBlur={() => touch(k)} />
        {o.end}
      </div>
    );
  };
  const field = (k: DraftField, label: string, control: ReactNode) => (
    <div className="db-field">
      <label htmlFor={`db-f-${k}`}>{label}</label>
      {control}
      {shown(k) && <span className="db-field-err" id={`db-e-${k}`}>{shown(k)}</span>}
    </div>
  );
  const chip = chipOf(d);

  return (
    <>
      <div ref={body} className={`db-sheet-body${c.locked ? ' is-locked' : ''}`}>
        <div className="db-grid">
          {field('name', s.name, input('name', d.name, (v) => change(patchDraft(d, { name: v }), false), { text: true, max: 120 }))}
          <div className="db-field">
            <span className="db-label">{s.showIn}</span>
            <Segmented label={s.showIn} value={d.scope} className="db-seg is-fill" labelClass="db-seg-label" disabled={c.locked}
              onChange={(v) => change(patchDraft(d, { scope: v }), false)} options={[
                { value: 'project', label: projectName || s.thisProject, ...(projectName ? { tip: projectName } : {}) }, { value: 'all', label: s.everyProject }
              ]} />
          </div>
        </div>
        <div className="db-field">
          <span className="db-label">{s.environment}</span>
          <Segmented label={s.environment} value={d.env} className="db-seg" labelClass="db-seg-label" disabled={c.locked}
            onChange={(v) => change(patchDraft(d, { env: v }), false)}
            options={ENVS.map((e) => ({ value: e, label: s.envs[e], dot: `db-seg-dot is-${e}`, ...(e === 'prod' ? { cls: 'is-prod' } : {}) }))} />
          <span className="db-field-hint">{s.prodHint}</span>
        </div>
        <div className="db-grid is-port">
          {field('host', s.host, input('host', hostText(d), (v) => change(withHostText(d, v)), {
            placeholder: s.hostPlaceholder, end: chip && <span className="db-chip" data-tip={chip}>{chip}</span>
          }))}
          {field('port', s.port, input('port', d.port, (v) => change(patchDraft(d, { port: v })), { max: 5, numeric: true }))}
        </div>
        <div className="db-grid">
          {field('database', s.database, input('database', d.database, (v) => change(patchDraft(d, { database: v })), { max: 128 }))}
          {field('user', s.user, input('user', d.user, (v) => change(patchDraft(d, { user: v })), { max: 128 }))}
        </div>
        <div className="db-field">
          <label htmlFor="db-f-password">{s.password}</label>
          <div className="db-input">
            {/* Not controlled: the value reaches the field through its property only (useLayoutEffect), never an attribute. */}
            <input ref={pw} id="db-f-password" type="password" placeholder={placeholder || undefined} maxLength={1024} spellCheck={false} autoComplete="off"
              readOnly={c.locked} data-autofocus={focus === 'password' ? '' : undefined}
              onChange={(e) => { setPassword(e.currentTarget.value); dispatch({ type: 'change', server: true }); }} />
            <span className="db-input-tag"><Icon name="lock" size={12} /><span>{s.keychain}</span></span>
          </div>
          {pwHint && <span className="db-field-hint is-ask">{pwHint}</span>}
        </div>
        <div className="db-field">
          <span className="db-label">{s.tls}</span>
          <div className="db-tls">
            <Segmented label={s.tls} value={d.tls} className="db-seg" labelClass="db-seg-label" disabled={c.locked}
              onChange={(v) => change(patchDraft(d, { tls: v }))} options={TLS.map((m) => ({ value: m, label: s.tlsModes[m] }))} />
            <span className="db-field-hint">{s.tlsHints[d.tls]}</span>
          </div>
        </div>
        <div className={`db-ssh${d.ssh ? ' is-on' : ''}`}>
          <button type="button" role="switch" aria-checked={d.ssh} className="db-sect" disabled={c.locked} onClick={() => change(patchDraft(d, { ssh: !d.ssh }))}>
            <span className={`switch${d.ssh ? ' is-on' : ''}`} aria-hidden="true"><i /></span>
            <span className="db-sect-text"><span className="db-sect-title">{s.ssh}</span><span className="db-sect-hint">{s.sshHint}</span></span>
          </button>
          {d.ssh && (
            <div className="db-ssh-fields">
              {field('sshHost', s.sshHost, input('sshHost', d.sshHost, (v) => change(patchDraft(d, { sshHost: v })), { placeholder: s.sshHostPlaceholder, max: 255 }))}
              <div className="db-grid">
                {field('sshPort', s.sshPort, input('sshPort', d.sshPort, (v) => change(patchDraft(d, { sshPort: v })), { placeholder: s.sshPortPlaceholder, max: 5, numeric: true }))}
                {field('sshUser', s.sshUser, input('sshUser', d.sshUser, (v) => change(patchDraft(d, { sshUser: v })), { placeholder: s.sshUserPlaceholder, max: 128 }))}
              </div>
            </div>
          )}
        </div>
        <div className="db-sheet-note is-vio">
          <Icon name="lock" size={16} />
          <span><b>{s.readOnlyTitle}</b> {withCode(s.readOnly(timeout))}</span>
        </div>
        {run.tested && <TestNote result={run.tested} />}
        {run.refused && <SaveProblem problem={run.refused} />}
      </div>
      <div className="db-sheet-foot">
        {onBack && <button type="button" className="btn-ghost" disabled={c.locked} onClick={onBack}><Icon name="chevronLeft" size={14} />{s.back}</button>}
        {/* While one runs, both stay focusable (the focus stays on the one pressed): busy, or not pressable now. */}
        <button type="button" className="btn-ghost" disabled={!ok} aria-busy={run.busy === 'test' || undefined} aria-disabled={(c.locked && run.busy !== 'test') || undefined}
          onClick={() => void test()}>
          <Icon name="plug" size={14} />{c.test}
        </button>
        <span className="db-sheet-gap" />
        <button type="button" className="btn-ghost" onClick={close}>{s.cancel}</button>
        <button type="button" className="btn-primary" disabled={!ok} aria-busy={run.busy === 'save' || undefined} aria-disabled={(c.locked && run.busy !== 'save') || undefined}
          onClick={() => void save()}>{s.save}</button>
      </div>
    </>
  );
}

/**
 * Remove Connection…: asked under its row (centered when the row isn't on screen). Main removes its entry,
 * its pick and its Keychain secret; this window closes its tabs.
 */
function RemoveConfirm({ id }: { id: string }) {
  const v = useDb((st) => st.snap.connections.find((c) => c.conn.id === id) ?? null);
  const loaded = useDb((st) => st.loaded);
  useEffect(() => { if (!v && loaded) close(); }, [v, loaded]);
  if (!v) return null;
  const title = s.removeTitle(v.conn.name);
  return (
    // Connection ids are `c` + 12 hex characters: nothing to escape in the selector.
    <ConfirmPopover anchor={`.db-conn[data-conn="${id}"]`} align="start" label={title} onCancel={close}>
      <div className="confirm-pop-text">
        <b>{title}</b>
        {v.hasPassword && <span>{s.removeBody}</span>}
      </div>
      <ConfirmActions confirm={s.remove} onConfirm={() => void removeConnection(id)} onCancel={close} end />
    </ConfirmPopover>
  );
}
