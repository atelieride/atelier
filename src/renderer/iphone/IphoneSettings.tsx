// Settings › iPhone: the beta it is, access on or off, how the relay connection stands, Pair iPhone…, the paired phones
// (connected now or last seen, Remove), the relay this computer dials, and Forget All. Loaded with its section, not the
// first paint.
import { useEffect, useRef, useState } from 'react';
import { DEFAULT_RELAY, relayBase, type RemoteDeviceInfo } from '@shared/remote';
import type { Settings as S } from '@shared/settings';
import { tiph } from '../i18n/iphone';
import { Icon } from '../components/Icon';
import { Row, Toggle } from '../components/Settings';
import { ConfirmActions, onEscCancel, useDismiss } from '../confirms/InlineConfirm';
import { useAgo } from '../minute';
import { useApp } from '../store';
import { openPairing, refreshIphone, useIphone } from './store';
import { deviceSubtitle, deviceTitle, relayLine, relayProblem, seenText } from './sheet-view';
import './iphone.css';

const set = (patch: Partial<S>) => void window.atelier.settings.set(patch);

/** Settings › iPhone shown this long (not passed through with the arrow keys) before it asks main how things stand. */
const SHOWN_MS = 250;

export function IphoneSettings({ s }: { s: S }) {
  const status = useIphone((x) => x.status);
  // The section shown asks main how things stand: with access off, the one moment main may touch the Keychain, so not
  // for a section only passed through on the way to another. With access on, main has said already: asked at once.
  useEffect(() => {
    if (s.remoteAccess) { void refreshIphone(); return; }
    const timer = setTimeout(() => void refreshIphone(), SHOWN_MS);
    return () => clearTimeout(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const line = relayLine(status);
  const unavailable = status?.available === false;
  const devices = status?.devices ?? [];
  return (
    <>
      <p className="iph-beta" role="note"><Icon name="info" size={13} stroke={1.8} />{tiph.beta}</p>
      <Row label={tiph.access} hint={tiph.accessHint} disabled={unavailable && !s.remoteAccess}>
        <Toggle label={tiph.access} value={s.remoteAccess} disabled={unavailable && !s.remoteAccess} onChange={(v) => set({ remoteAccess: v })} />
      </Row>
      {line && (
        <div className={`upd-card iph-status tone-${line.tone}`} role="status" aria-live="polite" aria-label={tiph.statusLabel}>
          <span className="upd-dot" />
          <div className="upd-text">
            <span className="upd-title">{line.text}</span>
            {!unavailable && <span className="upd-detail mono">{relayHost(s.remoteRelay)}</span>}
          </div>
        </div>
      )}
      <Row label={tiph.pairLabel} hint={tiph.pairHint}>
        <button type="button" className="btn-primary" disabled={unavailable} onClick={openPairing}><Icon name="qr" size={13} stroke={1.9} />{tiph.pair}</button>
      </Row>
      <div className="set-group-title">{tiph.devices}</div>
      {status && devices.length === 0 && (
        <div className="iph-empty">
          <span className="iph-empty-glyph"><Icon name="phone" size={18} stroke={1.6} /></span>
          <span className="set-text"><span className="set-label">{tiph.devicesNone}</span><span className="set-hint">{tiph.devicesNoneHint}</span></span>
        </div>
      )}
      {devices.length > 0 && <ul className="iph-devices" aria-label={tiph.devices}>{devices.map((d) => <DeviceRow key={d.id} d={d} live={!!status?.enabled} />)}</ul>}
      <Notifications s={s} />
      <div className="set-group-title">{tiph.advanced}</div>
      <RelayField saved={s.remoteRelay} />
      {/* Nothing to forget with no phone paired and access off: offered, disabled, in its place. */}
      <ForgetAll disabled={!s.remoteAccess && devices.length === 0} />
    </>
  );
}

/**
 * What wakes a paired iPhone when Atelier on it is closed: each kind on its own, and by default only while you are away
 * from this computer. The notifications are sealed for the phone: neither the relay nor Apple reads them.
 */
function Notifications({ s }: { s: S }) {
  const row = (key: 'remoteNotifyWaiting' | 'remoteNotifyDone' | 'remoteNotifyError' | 'remoteNotifyAway', label: string, hint: string) => (
    <Row label={label} hint={hint}><Toggle label={label} value={s[key]} onChange={(v) => set({ [key]: v })} /></Row>
  );
  const any = s.remoteNotifyWaiting || s.remoteNotifyDone || s.remoteNotifyError;
  return (
    <>
      <div className="set-group-title">{tiph.notifications}</div>
      {row('remoteNotifyWaiting', tiph.notifyWaiting, tiph.notifyWaitingHint)}
      {row('remoteNotifyDone', tiph.notifyDone, tiph.notifyDoneHint)}
      {row('remoteNotifyError', tiph.notifyError, tiph.notifyErrorHint)}
      <Row label={tiph.notifyAway} hint={tiph.notifyAwayHint} disabled={!any}>
        <Toggle label={tiph.notifyAway} value={s.remoteNotifyAway} disabled={!any} onChange={(v) => set({ remoteNotifyAway: v })} />
      </Row>
    </>
  );
}

/** The relay's host as the status card names it: relay.useatelier.dev, localhost:8787. */
function relayHost(url: string): string {
  const base = relayBase(url);
  try { return base ? new URL(base).host : url; } catch { return url; }
}

function DeviceRow({ d, live }: { d: RemoteDeviceInfo; live: boolean }) {
  const [asking, setAsking] = useState(false);
  const removeBtn = useRef<HTMLButtonElement>(null);
  // Cancelled: the keyboard goes back to Remove (confirmed, the row goes).
  const asked = useRef(false);
  useEffect(() => { if (!asking && asked.current) removeBtn.current?.focus({ preventScroll: true }); asked.current = asking; }, [asking]);
  const now = useAgo(d.connected ? null : d.lastSeenAt);
  const title = deviceTitle(d);
  const connected = live && d.connected;
  const sub = [deviceSubtitle(d), connected && d.attached.length ? tiph.openCount(d.attached.length) : null].filter(Boolean).join(' · ');
  return (
    <li className={`iph-device${connected ? ' is-connected' : ''}${asking ? ' is-asking' : ''}`}>
      <span className="iph-device-glyph"><Icon name="phone" size={16} stroke={1.7} /></span>
      <span className="iph-device-text">
        <span className="iph-device-name">{title}</span>
        {sub && <span className="iph-device-sub">{sub}</span>}
      </span>
      {asking ? <RemoveConfirm d={d} title={title} onDone={() => setAsking(false)} /> : (
        <>
          {connected ? <span className="iph-chip"><i />{tiph.connected}</span> : <span className="iph-seen">{seenText({ ...d, connected: false }, now)}</span>}
          <button ref={removeBtn} type="button" className="btn-ghost sm iph-remove" aria-label={tiph.removeTip(title)} onClick={() => setAsking(true)}>{tiph.remove}</button>
        </>
      )}
    </li>
  );
}

/** Remove, asked in the row: the phone's connection ends at once, and it must pair again. */
function RemoveConfirm({ d, title, onDone }: { d: RemoteDeviceInfo; title: string; onDone: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useDismiss(box, onDone);
  return (
    <div ref={box} className="iph-confirm" role="group" aria-label={tiph.removeAsk(title)} data-own-esc="" onKeyDown={onEscCancel(onDone)}>
      <p><b>{tiph.removeAsk(title)}</b> {tiph.removeBody}</p>
      <ConfirmActions confirm={tiph.remove} onConfirm={() => { onDone(); void window.atelier.remote.removeDevice(d.id); }} onCancel={onDone} end />
    </div>
  );
}

/** Why `draft` can't be the relay; null when it can, or when it is the saved address. */
const problemOf = (draft: string, saved: string) => (draft.trim() === saved ? null : relayProblem(draft));

/**
 * The relay's address: saved on Enter or blur when Atelier can dial it (https anywhere; http to this computer or the
 * local network), else the field says why and the saved one stays. Said then, not while the address is being typed
 * (its first letter is no address yet); once said, it follows the typing until the address is one Atelier can use.
 * Esc puts the saved one back; with the saved one there, Esc closes Settings as it does anywhere else.
 */
function RelayField({ saved }: { saved: string }) {
  const [draft, setDraft] = useState(saved);
  const [warned, setWarned] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  // Changed elsewhere (another window, Restore Defaults): shown unless the field is being edited.
  useEffect(() => { if (document.activeElement !== field.current) { setDraft(saved); setWarned(false); } }, [saved]);
  const problem = warned ? problemOf(draft, saved) : null;
  const commit = () => {
    const v = draft.trim();
    if (problemOf(v, saved)) { setWarned(true); return; }
    if (v !== saved) set({ remoteRelay: v });
  };
  const change = (v: string) => {
    setDraft(v);
    // Fixed: the warning goes, and waits for the next Enter or blur.
    if (warned && !problemOf(v, saved)) setWarned(false);
  };
  // The text above, the field the row's whole width under it: an address is long, and the hint stays readable.
  return (
    <div className="set-row iph-relay-row">
      <div className="set-text">
        <span className="set-label">{tiph.relayServer}</span><span className="set-hint">{tiph.relayServerHint}</span>
      </div>
      <div className="iph-relay">
        <input ref={field} className="set-text-input mono" value={draft} spellCheck={false} aria-label={tiph.relayServer} aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? 'iph-relay-warn' : undefined} placeholder={DEFAULT_RELAY} onChange={(e) => change(e.target.value)} onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              if (draft !== saved) { setDraft(saved); setWarned(false); } else useApp.getState().setSettingsOpen(null);
            }
          }} />
        {saved !== DEFAULT_RELAY && <button type="button" className="btn-ghost sm" onClick={() => { setDraft(DEFAULT_RELAY); setWarned(false); set({ remoteRelay: DEFAULT_RELAY }); }}>{tiph.relayDefault}</button>}
      </div>
      {problem && <span id="iph-relay-warn" className="set-warn" role="note"><Icon name="info" size={12} stroke={1.8} />{problem}</span>}
    </div>
  );
}

/** Forget All: a new identity, every phone unpaired; asked in a card in its place. */
function ForgetAll({ disabled }: { disabled: boolean }) {
  const [asking, setAsking] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const asked = useRef(false);
  useEffect(() => { if (!asking && asked.current) button.current?.focus({ preventScroll: true }); asked.current = asking; }, [asking]);
  // Asked, the question takes the row's place, the row's whole width.
  if (asking) return <div className="set-row"><ForgetCard box={box} onDone={() => setAsking(false)} /></div>;
  return (
    <Row label={tiph.forget} hint={tiph.forgetHint} disabled={disabled}>
      <button ref={button} type="button" className="btn-ghost is-danger iph-forget" disabled={disabled} onClick={() => setAsking(true)}>{tiph.forgetButton}</button>
    </Row>
  );
}

function ForgetCard({ box, onDone }: { box: React.RefObject<HTMLDivElement | null>; onDone: () => void }) {
  useDismiss(box, onDone);
  return (
    <div ref={box} className="iph-confirm is-card" role="group" aria-label={tiph.forgetAsk} data-own-esc="" onKeyDown={onEscCancel(onDone)}>
      <p><b>{tiph.forgetAsk}</b> {tiph.forgetBody}</p>
      <ConfirmActions confirm={tiph.forgetConfirm} onConfirm={() => { onDone(); void window.atelier.remote.reset(); }} onCancel={onDone} end />
    </div>
  );
}
