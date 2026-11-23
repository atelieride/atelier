// What a window shows of the phones connected now, outside Settings: the footer pill, the badge on the tabs and rows
// of terminals a phone has open, and the note on a terminal a phone sized. Small: they are in the first paint.
import { useShallow } from 'zustand/react/shallow';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { Icon } from '../components/Icon';
import { getLiveTerminal } from '../terminal/registry';
import { useIphone } from './store';
import { connectedDevices, pillView } from './view';

/** The footer pill while a phone is connected: a click opens Settings › iPhone; its tooltip names the phones. */
export function IphonePill() {
  const pill = useIphone(useShallow((x) => (x.marksReady ? pillView(connectedDevices(x.status), x.deviceTitle) : null)));
  if (!pill) return null;
  return (
    <button type="button" className="foot-iphone" data-tip={pill.tip} aria-label={pill.name} onClick={() => useApp.getState().setSettingsOpen('iphone')}>
      <Icon name="phone" size={11} stroke={2} /><span>{pill.label}</span><i aria-hidden="true" />
    </button>
  );
}

/** On a tab or a sidebar row: a phone has this terminal open now. */
export function PhoneBadge({ id }: { id: string }) {
  const on = useIphone((x) => x.marksReady && x.attached.has(id));
  if (!on) return null;
  return <span className="phone-badge" role="img" aria-label={t.iphone.badge} data-tip={t.iphone.badge}><Icon name="phone" size={14} stroke={1.8} /></span>;
}

/**
 * Over a terminal whose size a phone owns: it is drawn at the phone's size until this window takes the size back,
 * by typing, or here with Fit to Window (this view's own size).
 */
export function SizeNote({ id }: { id: string }) {
  const on = useIphone((x) => x.marksReady && x.sized.has(id));
  if (!on) return null;
  const fit = () => {
    const lt = getLiveTerminal(id);
    try { lt.fit.fit(); } catch { /* not laid out: its own size as it is */ }
    window.atelier.terminals.resize(id, lt.term.cols, lt.term.rows);
    lt.term.focus();
  };
  return (
    <div className="size-note" role="status" data-tip={t.iphone.sizedTip}>
      <Icon name="phone" size={12} stroke={1.9} /><span>{t.iphone.sized}</span>
      <button type="button" className="size-note-fit" onClick={fit}><Icon name="fit" size={12} stroke={1.9} />{t.iphone.fit}</button>
    </div>
  );
}
