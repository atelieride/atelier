// Turn On: what the automation will do, said before it does it. The tasks that
// match now are baselined unless the user ticks "Also start…". After an edit that widened an automation that was on,
// Cancel turns it off.
import { useEffect, useState } from 'react';
import type { Automation } from '@shared/automations';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { Icon } from '../components/Icon';
import { turnOff, turnOn } from './actions';
import { conditionSentence, peopleWords } from './view';

const tc = t.auto.consent;
const MODELS: Record<string, string> = { default: 'Claude', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };

export function TurnOnSheet() {
  const consent = useApp((s) => s.automationConsent);
  if (!consent) return null;
  return <Sheet key={consent.automation.id} a={consent.automation} reconfirm={consent.reconfirm} />;
}

function Sheet({ a, reconfirm }: { a: Automation; reconfirm: boolean }) {
  const [count, setCount] = useState<number | null>(null);
  const [startNow, setStartNow] = useState(false);
  const accounts = useApp((s) => s.settings.claudeAccounts.list);
  const account = accounts.find((x) => x.id === a.claude.account)?.name ?? 'Claude';
  const project = a.project.split('/').pop() ?? a.project;
  const createdBy = a.conditions.find((c) => c.field === 'createdBy');
  const close = () => useApp.getState().askTurnOn(null);
  useEffect(() => {
    let gone = false;
    void window.atelier.automations.preview(a).then((p) => { if (!gone) setCount(p.error ? null : p.count); }).catch(() => {});
    return () => { gone = true; };
  }, [a]);
  const cancel = () => { if (reconfirm) turnOff(a.id); close(); };
  const where = conditionSentence({ ...a, conditions: [] }).replace(/^New (task|row) in /, '');
  return (
    <div className="palette-backdrop settings-backdrop" onMouseDown={cancel}>
      <div className="ac-sheet" role="dialog" aria-modal="true" aria-label={tc.label} onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } }}>
        <div className="ac-head">
          <span className="section-label is-violet">{tc.label}</span>
          <h2>{tc.title(a.name)}</h2>
        </div>
        <div className="ac-points">
          <div className="ac-pt"><span className="ac-ic is-violet"><Icon name="automation" size={16} /></span>
            <div><b>{tc.p1}</b><p>{tc.p1b(a.limits.checkEveryMin, where, project, MODELS[a.claude.model] ?? 'Claude', t.auto.editor.modes[a.claude.mode])}</p></div></div>
          <div className="ac-pt"><span className="ac-ic is-waiting"><Icon name="warning" size={16} /></span>
            <div><b>{tc.p2}</b><p>{tc.p2b(createdBy ? peopleWords(createdBy, true) : null)}</p></div></div>
          <div className="ac-pt"><span className="ac-ic is-worktree"><Icon name="worktree" size={16} /></span>
            <div><b>{a.isolation.worktree ? tc.p3 : tc.p3off}</b><p>{a.isolation.worktree ? tc.p3b : tc.p3offb}</p></div></div>
          <div className="ac-pt"><span className="ac-ic is-working"><Icon name="clock" size={16} /></span>
            <div><b>{tc.p4(account)}</b><p>{tc.p4b(a.limits.concurrent, a.limits.perDay, a.limits.usagePause)}</p></div></div>
          {count !== null && count > 0 && (
            <label className="ac-check">
              <input type="checkbox" checked={startNow} onChange={(e) => setStartNow(e.target.checked)} />
              <span>{tc.alsoNow(count)}</span>
            </label>
          )}
        </div>
        <footer className="ac-foot">
          <span className="ae-hint">{tc.foot}</span>
          <span className="grow" />
          <button type="button" className="btn-secondary is-ghost" onClick={cancel}>{tc.cancel}</button>
          <button type="button" className="btn-primary" autoFocus onClick={() => { close(); void turnOn(a.id, startNow); }}><Icon name="automation" size={13} />{tc.turnOn}</button>
        </footer>
      </div>
    </div>
  );
}
