// The automation editor: a sheet over the window. Left, the automation in five
// sections; right, what matches now (live from the source) and what Claude gets. Saved through main, which validates.
import { useEffect, useMemo, useState } from 'react';
import { conditionFields, type Automation, type AutomationPreview, type Condition, type ConditionField, type ConditionValues } from '@shared/automations';
import type { ConnectorId } from '@shared/tasks';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { Icon } from '../components/Icon';
import { Stepper, Toggle } from '../components/Settings';
import { Segmented } from '../components/Segmented';
import { askTurnOn, saveAutomation } from './actions';
import { daysValue, isChips, withPeopleLabels } from './chips';
import { FolderPicker } from './FolderPicker';
import { ScopePicker } from './ScopePicker';
import { ValueChips } from './ValueChips';
import { needsConsent, whatClaudeGets } from './view';
import { automationServiceKeys } from '../jira-view';

const te = t.auto.editor;
const SOURCE_NAMES: Record<ConnectorId, string> = { clickup: 'ClickUp', notion: 'Notion', jira: 'Jira' };
const SCOPE_NOUNS: Record<ConnectorId, string> = { clickup: 'list', notion: 'database', jira: 'project' };

function Section({ n, title, extra, children }: { n: number; title: string; extra?: string; children: React.ReactNode }) {
  return (
    <section className="ae-sec">
      <div className="ae-sec-head"><span className="ae-k mono">{n}</span><span className="section-label">{title}</span>{extra && <span className="ae-hint ae-right">{extra}</span>}</div>
      {children}
    </section>
  );
}

function Field({ label, children, top = false }: { label: string; children: React.ReactNode; top?: boolean }) {
  return <div className={`ae-row ${top ? 'is-top' : ''}`}><span className="ae-label">{label}</span><div className="ae-control">{children}</div></div>;
}

function ConditionRow({ c, fields, known, noun, onChange, onRemove }: {
  c: Condition; fields: ConditionField[]; known: ConditionValues | null; noun: string; onChange: (c: Condition) => void; onRemove: () => void;
}) {
  const due = Number(c.values[0] ?? 3);
  return (
    <div className="ae-cond">
      <select className="ae-select" value={c.field} aria-label={te.matching} onChange={(e) => {
        const field = e.target.value as ConditionField;
        onChange(field === 'assignee' || field === 'createdBy' ? { field, values: ['me'], labels: ['Me'] } : { field, values: field === 'due' ? ['3'] : field === 'priority' ? ['high'] : [] });
      }}>
        {fields.map((f) => <option key={f} value={f}>{te.fields[f]}</option>)}
      </select>
      <span className="ae-op">{te.ops[c.field]}</span>
      {isChips(c.field) ? <ValueChips c={c} known={known} noun={noun} onChange={onChange} />
        : c.field === 'priority'
          ? <select className="ae-select" value={c.values[0] ?? 'high'} aria-label={te.fields.priority} onChange={(e) => onChange({ ...c, values: [e.target.value] })}>
            {['urgent', 'high', 'normal', 'low'].map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          : c.field === 'due'
            ? <span className="ae-line"><DaysInput value={due} onChange={(n) => onChange({ ...c, values: [String(n)] })} />{te.days(due)}</span>
            : <TitleInput c={c} onChange={onChange} />}
      {c.field === 'createdBy' && <span className="au-chip is-violet"><Icon name="lock" size={10} />{te.recommended}</span>}
      <button type="button" className="icon-btn" aria-label="Remove condition" onClick={onRemove}><Icon name="x" size={12} /></button>
    </div>
  );
}

/** Due within: days typed (↑↓ step them), kept on Enter or when the field is left. */
function DaysInput({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => { const n = daysValue(text, value); setText(String(n)); if (n !== value) onChange(n); };
  return <input className="ae-input ae-days mono" type="number" min={0} max={365} step={1} inputMode="numeric" value={text} aria-label={te.fields.due}
    onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit(); }} />;
}

/** Title contains: one text, kept when the field is left. */
function TitleInput({ c, onChange }: { c: Condition; onChange: (c: Condition) => void }) {
  const [text, setText] = useState(c.values[0] ?? '');
  return <input className="ae-input" value={text} spellCheck={false} aria-label={te.fields.title}
    onChange={(e) => setText(e.target.value)} onBlur={() => onChange({ ...c, values: text.trim() ? [text.trim()] : [] })} />;
}

export function AutomationEditor() {
  const editor = useApp((s) => s.automationEditor);
  if (!editor) return null;
  return <Sheet key={editor.draft.id} initial={editor.draft} prev={editor.prev} />;
}

function Sheet({ initial, prev }: { initial: Automation; prev: Automation | null }) {
  const [a, setA] = useState<Automation>(initial);
  const [scopes, setScopes] = useState<{ id: string; label: string }[]>([]);
  const [preview, setPreview] = useState<AutomationPreview | null>(null);
  // The chips' suggestions for this source and scopes: kept across a preview that fails after a change.
  const [known, setKnown] = useState<{ key: string; values: ConditionValues } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mcp, setMcp] = useState<{ state: 'found' | 'notFound' | 'unknown'; name?: string } | null>(null);
  const connectors = useApp((s) => s.connectors);
  const accounts = useApp((s) => s.settings.claudeAccounts.list);
  const project = useApp((s) => s.project);
  const close = () => useApp.getState().editAutomation(null);
  const patch = (p: Partial<Automation>) => setA((x) => ({ ...x, ...p }));
  const source = connectors.find((c) => c.id === a.source.connector);
  const live = source?.status === 'connected';
  // Notion: no creator read yet (its "Created by" isn't offered).
  const fields = conditionFields(a.source.connector, false);
  // Jira: a service project keeps it off until Created by names people.
  const serviceKeys = automationServiceKeys(a, connectors);
  const jira = a.source.connector === 'jira';
  const noProjects = jira && live && source?.projects?.length === 0;
  const openSource = () => { const st = useApp.getState(); st.setSettingsOpen('connectors'); st.openConnector(a.source.connector); };

  // The places to watch: ClickUp's lists, Notion's chosen databases (main reads both).
  useEffect(() => {
    if (!live) { setScopes([]); return; }
    let gone = false;
    void window.atelier.automations.scopes(a.source.connector).then((l) => { if (!gone) setScopes(l); }).catch(() => {});
    return () => { gone = true; };
  }, [a.source.connector, live]); // eslint-disable-line react-hooks/exhaustive-deps

  // Is the source set up in Claude Code for this account?
  useEffect(() => {
    let gone = false;
    setMcp(null);
    void window.atelier.automations.sourceMcp(a.source.connector, a.claude.account, a.id).then((r) => { if (!gone) setMcp(r); }).catch(() => {});
    return () => { gone = true; };
  }, [a.source.connector, a.claude.account, a.id]);

  // Matching now: read again 400 ms after the last change of what decides it.
  const key = JSON.stringify([a.source, a.conditions.map((c) => [c.field, c.values])]);
  const valuesKey = JSON.stringify([a.source.connector, a.source.scopes]);
  useEffect(() => {
    if (!live || a.source.scopes.length === 0) { setPreview(null); return; }
    let gone = false;
    const asked = valuesKey;
    const h = setTimeout(() => {
      void window.atelier.automations.preview(a).then((p) => {
        if (gone) return;
        setPreview(p);
        if (p.values) setKnown({ key: asked, values: p.values });
      }).catch(() => {});
    }, 400);
    return () => { gone = true; clearTimeout(h); };
  }, [key, live]); // eslint-disable-line react-hooks/exhaustive-deps

  const addScope = (id: string) => {
    const s = scopes.find((x) => x.id === id);
    if (!s || a.source.scopes.includes(id)) return;
    patch({ source: { ...a.source, scopes: [...a.source.scopes, id], labels: [...(a.source.labels ?? a.source.scopes.map(() => '…')), s.label] } });
  };
  const removeScope = (i: number) => patch({ source: { ...a.source, scopes: a.source.scopes.filter((_, j) => j !== i), ...(a.source.labels ? { labels: a.source.labels.filter((_, j) => j !== i) } : {}) } });
  const scopeLabel = a.source.connector === 'notion' ? te.addDatabase : jira ? te.addProject : te.addList;
  const setCondition = (i: number, c: Condition) => patch({ conditions: a.conditions.map((x, j) => (j === i ? c : x)) });
  const knownNow = known?.key === valuesKey ? known.values : null;
  const firstMatch = preview?.matching[0] ?? null;
  const claudeGets = useMemo(() => whatClaudeGets(a, firstMatch), [a, firstMatch]);

  async function save(turnOn: boolean) {
    if (a.source.scopes.length === 0) { setError(jira ? te.needsProject : te.needsScope); return; }
    if (turnOn && serviceKeys.length) return;
    const next = { ...a, conditions: withPeopleLabels(a.conditions, knownNow), enabled: prev?.enabled ?? false };
    if (!(await saveAutomation(next))) return;
    close();
    const widened = !!prev?.enabled && needsConsent(prev, next);
    if (turnOn && !prev?.enabled) askTurnOn(next);
    else if (widened) askTurnOn(next, true);
  }

  return (
    <div className="palette-backdrop settings-backdrop" onMouseDown={close}>
      <div className="ae-sheet" role="dialog" aria-modal="true" aria-label={prev ? te.editTitle : te.newTitle} onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
        <header className="ae-head">
          <span className="au-head-mark is-small"><Icon name="automation" size={15} /></span>
          <div className="au-head-text"><h2>{prev ? te.editTitle : te.newTitle}</h2><span className="au-faint">{te.inProject(project?.name ?? '')}</span></div>
          <span className="grow" />
          <button type="button" className="icon-btn" aria-label={te.cancel} onClick={close}><Icon name="x" size={14} /></button>
        </header>
        <div className="ae-body">
          <div className="ae-form">
            <div className="ae-sec is-first">
              <Field label={te.name}><input className="ae-input is-wide" value={a.name} maxLength={60} placeholder={te.namePlaceholder} autoFocus onChange={(e) => patch({ name: e.target.value })} /></Field>
            </div>
            <Section n={1} title={te.s1}>
              <Field label={te.source}>
                <Segmented label={te.source} value={a.source.connector} options={connectors.map((c) => ({ value: c.id, label: c.name }))}
                  onChange={(connector) => patch({ source: { connector, scopes: [] }, conditions: a.conditions.filter((c) => conditionFields(connector, false).includes(c.field)) })} />
                <span className="ae-hint">{live ? source?.account ? `${source.account}${source.workspace ? ` · ${source.workspace}` : ''}` : '' : ''}</span>
              </Field>
              {!live && (
                <div className="ae-banner is-warn">
                  <span>{SOURCE_NAMES[a.source.connector]} isn't connected in Atelier. Connect it to pick where to watch.</span>
                  <button type="button" className="btn-small is-warn" onClick={() => { const st = useApp.getState(); st.setSettingsOpen('connectors'); st.openConnector(a.source.connector); }}>{t.auto.connect(SOURCE_NAMES[a.source.connector])}</button>
                </div>
              )}
              <Field label={te.where}>
                <div className="ae-chips">
                  {a.source.scopes.map((id, i) => (
                    <span key={id} className="ae-scope"><Icon name={a.source.connector} size={11} />{a.source.labels?.[i] ?? id}
                      <button type="button" aria-label="Remove" onClick={() => removeScope(i)}><Icon name="x" size={10} /></button></span>
                  ))}
                  {noProjects
                    ? <button type="button" className="btn-small is-ghost" onClick={openSource}><Icon name="jira" size={11} />{te.chooseProjects}</button>
                    : live && <ScopePicker connector={a.source.connector} label={scopeLabel} scopes={scopes} chosen={a.source.scopes} onAdd={addScope} />}
                </div>
              </Field>
              {serviceKeys.length > 0 && (
                <div className="ae-banner is-err" role="alert">
                  <Icon name="warning" size={14} />
                  <span>{te.serviceAlert(serviceKeys)}</span>
                </div>
              )}
              <Field label={te.matching} top>
                <div className="ae-conds">
                  {a.conditions.map((c, i) => <ConditionRow key={`${i}-${c.field}`} c={c} fields={fields} known={knownNow} noun={SCOPE_NOUNS[a.source.connector]} onChange={(x) => setCondition(i, x)} onRemove={() => patch({ conditions: a.conditions.filter((_, j) => j !== i) })} />)}
                  {a.conditions.length < 8 && (
                    <button type="button" className="btn-small is-ghost" onClick={() => patch({ conditions: [...a.conditions, { field: 'status', values: [] }] })}><Icon name="plus" size={11} />{te.addCondition}</button>
                  )}
                </div>
              </Field>
            </Section>
            <Section n={2} title={te.s2}>
              <Field label={te.folder}><FolderPicker value={a.folder} projectRoot={a.project} onChange={(folder) => patch({ folder })} /></Field>
              <Field label={te.account}>
                <Segmented label={te.account} value={a.claude.account} options={accounts.map((x) => ({ value: x.id, label: x.name }))} onChange={(account) => patch({ claude: { ...a.claude, account } })} />
              </Field>
              <Field label={te.model}>
                <Segmented label={te.model} value={a.claude.model} options={[{ value: 'default', label: 'Default' }, { value: 'opus', label: 'Opus' }, { value: 'sonnet', label: 'Sonnet' }, { value: 'haiku', label: 'Haiku' }]}
                  onChange={(model) => patch({ claude: { ...a.claude, model } })} />
              </Field>
              <Field label={te.permissions} top>
                <Segmented label={te.permissions} value={a.claude.mode} options={(['plan', 'auto', 'acceptEdits', 'default'] as const).map((m) => ({ value: m, label: te.modes[m] }))}
                  onChange={(mode) => patch({ claude: { ...a.claude, mode } })} />
                <span className="ae-hint">{te.modeHint}</span>
              </Field>
              <Field label={te.questions} top>
                <span className="ae-line"><Toggle label={te.decideAlone} value={a.claude.decideAlone} onChange={(decideAlone) => patch({ claude: { ...a.claude, decideAlone } })} />{te.decideAlone}</span>
                <span className="ae-hint">{te.decideHint}</span>
              </Field>
            </Section>
            <Section n={3} title={te.s3}>
              <div className="ae-line">
                <Toggle label={te.worktree} value={a.isolation.worktree} onChange={(worktree) => patch({ isolation: { ...a.isolation, worktree } })} />
                <span>{te.worktree}</span>
                {a.isolation.worktree && <>
                  <span className="ae-hint">{te.base}</span>
                  <Segmented label={te.base} value={a.isolation.base === 'current' ? 'current' : 'default'} options={[{ value: 'default', label: te.baseDefault }, { value: 'current', label: te.baseCurrent }]}
                    onChange={(base) => patch({ isolation: { ...a.isolation, base } })} />
                </>}
                <span className="au-chip is-violet">{te.recommended}</span>
              </div>
              <div className="ae-line is-row"><span className="switch is-on is-locked" aria-hidden="true"><i /></span><span className="ae-line-text">{te.neverMerge} <span className="au-faint">{te.neverMergeHint}</span></span><Icon name="lock" size={12} /></div>
              <div className="ae-line is-row">
                <Toggle label={te.useSource(SOURCE_NAMES[a.source.connector])} value={a.claude.useSourceMcp} onChange={(useSourceMcp) => patch({ claude: { ...a.claude, useSourceMcp } })} />
                <span className="ae-line-text">{te.useSource(SOURCE_NAMES[a.source.connector])} <span className="au-faint">{te.useSourceHint}</span>
                  {mcp && <span className={`ae-mcp is-${mcp.state}`}>
                    {mcp.state === 'found' ? <span className="au-chip is-done"><i />{te.mcpFound(mcp.name ?? SOURCE_NAMES[a.source.connector], accounts.find((x) => x.id === a.claude.account)?.name ?? 'Claude')}</span>
                      : mcp.state === 'notFound' ? <span className="au-chip is-waiting"><i />{te.mcpNotFound(SOURCE_NAMES[a.source.connector])}</span>
                      : <span className="au-chip is-muted">{te.mcpUnknown(SOURCE_NAMES[a.source.connector])}</span>}
                  </span>}
                </span>
              </div>
            </Section>
            <Section n={4} title={te.s4} extra={te.instructionsHint}>
              <textarea className="ae-text" value={a.instructions} maxLength={8192} placeholder={te.instructionsPlaceholder} rows={5} onChange={(e) => patch({ instructions: e.target.value })} />
            </Section>
            <Section n={5} title={te.s5}>
              <div className="ae-limits">
                <span className="ae-line">{te.atMost}<Stepper label={te.atATime} value={a.limits.concurrent} min={1} max={5} step={1} format={String} onChange={(concurrent) => patch({ limits: { ...a.limits, concurrent } })} />{te.atATime}</span>
                <span className="ae-line"><Stepper label={te.perDay} value={a.limits.perDay} min={1} max={50} step={1} format={String} onChange={(perDay) => patch({ limits: { ...a.limits, perDay } })} />{te.perDay}</span>
                <span className="ae-line">{te.checkEvery}<Segmented label={te.checkEvery} value={String(a.limits.checkEveryMin) as '1' | '2' | '5' | '15'}
                  options={[{ value: '1', label: '1 min' }, { value: '2', label: '2 min' }, { value: '5', label: '5 min' }, { value: '15', label: '15 min' }]}
                  onChange={(v) => patch({ limits: { ...a.limits, checkEveryMin: Number(v) as 1 | 2 | 5 | 15 } })} /></span>
                <span className="ae-line"><Toggle label={te.pauseAbove} value={a.limits.usagePause !== null} onChange={(on) => patch({ limits: { ...a.limits, usagePause: on ? 80 : null } })} />{te.pauseAbove}
                  {a.limits.usagePause !== null && <Stepper label={te.pauseAbove} value={a.limits.usagePause} min={50} max={95} step={5} format={(v) => `${v}%`} onChange={(usagePause) => patch({ limits: { ...a.limits, usagePause } })} />}{te.ofFiveHour}</span>
              </div>
            </Section>
          </div>
          <aside className="ae-side">
            <div className="ae-side-head"><span className="section-label">{te.matchingNow}</span>{preview && <span className="mono au-count">{preview.count}</span>}<span className="grow" />{live && <span className="ae-hint">{te.liveFrom(SOURCE_NAMES[a.source.connector])}</span>}</div>
            {a.source.scopes.length === 0 ? <p className="ae-hint">{te.pickSource}</p>
              : preview?.error ? <p className="ae-banner is-warn">{preview.error}</p>
              : (
                <div className="ae-matches">
                  {preview?.matching.map((m) => (
                    <div key={m.id} className="ae-match"><i className="au-dot" /><span className="mono au-id">{m.displayId}</span><span className="au-title">{m.title}</span></div>
                  ))}
                  {preview?.leftOut.map((m) => (
                    <div key={m.task.id} className="ae-match is-out"><Icon name="lock" size={11} /><span className="mono au-id">{m.task.displayId}</span><span className="au-title">{te.leftOut(m.reason)}</span></div>
                  ))}
                  {preview && preview.matching.length === 0 && preview.leftOut.length === 0 && <p className="ae-hint">{te.nothingMatches}</p>}
                  {preview && preview.count > 0 && <p className="ae-hint">{te.notRunNote}</p>}
                </div>
              )}
            <div className="ae-side-head"><span className="section-label">{te.whatClaudeGets}</span>{firstMatch && <span className="ae-hint ae-right">for {firstMatch.displayId}</span>}</div>
            <pre className="ae-code mono">{claudeGets}</pre>
          </aside>
        </div>
        <footer className="ae-foot">
          {error && <span className="ae-error" role="alert">{error}</span>}
          <span className="grow" />
          <button type="button" className="btn-secondary is-ghost" onClick={close}>{te.cancel}</button>
          <button type="button" className="btn-secondary" onClick={() => void save(false)}>{te.save}</button>
          {!prev?.enabled && (
            <button type="button" className="btn-primary" disabled={serviceKeys.length > 0} data-tip={serviceKeys.length ? te.serviceBlocked : undefined}
              onClick={() => void save(true)}><Icon name="automation" size={13} />{te.saveOn}</button>
          )}
        </footer>
      </div>
    </div>
  );
}
