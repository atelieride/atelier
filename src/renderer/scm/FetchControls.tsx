// Fetch controls: the History toolbar's chip ("origin fetched 12m ago", "Fetching…", "Fetch needs
// sign-in") and the sidebar's ↻ button. Both fetch the repository by hand; the minute ticker keeps the age honest.
import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { fetchRepo } from './actions';
import { fetchChip } from './view';

/** Re-renders every 30 s while shown, so "12m ago" moves on. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(id); }, []);
  return now;
}

function useChip(root: string) {
  const refs = useApp((s) => s.scmRefs[root]);
  const common = useApp((s) => s.scmRepos?.find((e) => e.root === root)?.common);
  const state = useApp((s) => (common ? s.scmFetch[common] : undefined));
  const now = useMinute();
  return refs ? fetchChip(refs, state, Math.max(now, Date.now())) : null;
}

/** The History toolbar's fetch chip: a button. */
export function FetchChip({ root }: { root: string }) {
  const chip = useChip(root);
  if (!chip) return null;
  const running = chip.tone === 'running';
  return (
    <button type="button" className={`hv-fetch is-${chip.tone}`} data-tip={chip.tip} aria-label={`${chip.text}. ${chip.tip}`} aria-busy={running}
      onClick={() => { if (!running) void fetchRepo(root, 'manual'); }}>
      <span className="hv-fetch-icon" aria-hidden="true"><Icon name="fetch" size={12} stroke={1.8} /></span>
      {chip.text}
    </button>
  );
}

/** The sidebar head's ↻: fetches the selected repository; a rose dot when Atelier's last fetch failed. */
export function FetchButton({ root }: { root: string }) {
  const chip = useChip(root);
  if (!chip) return null;
  const running = chip.tone === 'running';
  const tip = running ? chip.tip : chip.tone === 'failed' ? `${chip.text} · ${chip.tip}` : `${t.scm.fetch.label} · ${chip.text}`;
  return (
    <button type="button" className={`icon-btn scm-fetch-btn is-${chip.tone}`} aria-label={t.scm.fetch.label} data-tip={tip} aria-busy={running}
      onClick={() => { if (!running) void fetchRepo(root, 'manual'); }}>
      <Icon name="fetch" size={14} />
      {chip.tone === 'failed' && <i className="scm-fetch-dot" aria-hidden="true" />}
    </button>
  );
}
