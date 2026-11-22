// Settings › iPhone: access on or off, how the relay connection stands, Pair iPhone…, the paired phones (connected
// now or last seen, Remove), the relay this computer dials, and Forget All. Loaded with its section, not the first paint.
import { useEffect, useRef, useState } from 'react';
import { DEFAULT_RELAY, relayBase, type RemoteDeviceInfo } from '@shared/remote';
import type { Settings as S } from '@shared/settings';
import { t } from '../i18n/en';
import { Icon } from '../components/Icon';
import { Row, Toggle } from '../components/Settings';
import { ConfirmActions, onEscCancel, useDismiss } from '../confirms/InlineConfirm';
import { useAgo } from '../minute';
import { openPairing, refreshIphone, useIphone } from './store';
import { deviceSubtitle, deviceTitle, relayLine, relayProblem, seenText } from './view';
import './iphone.css';

const set = (patch: Partial<S>) => void window.atelier.settings.set(patch);

export function IphoneSettings({ s }: { s: S }) {
  const status = useIphone((x) => x.status);
  // Opening the section asks main how things stand (the one moment access off may touch the Keychain).
  useEffect(refreshIphone, []);
  const line = relayLine(status);
  const unavailable = status?.available === false;
  const devices = status?.devices ?? [];
  return (
    <>
      <Row label={t.iphone.access} hint={t.iphone.accessHint} disabled={unavailable && !s.remoteAccess}>
        <Toggle label={t.iphone.access} value={s.remoteAccess} disabled={unavailable && !s.remoteAccess} onChange={(v) => set({ remoteAccess: v })} />
      </Row>
      {line && (
        <div className={`upd-card iph-status tone-${line.tone}`} role="status" aria-live="polite" aria-label={t.iphone.statusLabel}>
          <span className="upd-dot" />
          <div className="upd-text">
            <span className="upd-title">{line.text}</span>
            {!unavailable && <span className="upd-detail mono">{relayHost(s.remoteRelay)}</span>}
          </div>
        </div>
      )}
      <Row label={t.iphone.pairLabel} hint={t.iphone.pairHint}>
        <button type="button" className="btn-primary" disabled={unavailable} onClick={openPairing}><Icon name="qr" size={13} stroke={1.9} />{t.iphone.pair}</button>
      </Row>
      <div className="set-group-title">{t.iphone.devices}</div>
      {status && devices.length === 0 && (
        <div className="iph-empty">
          <span className="iph-empty-glyph"><Icon name="phone" size={18} stroke={1.6} /></span>
          <span className="set-text"><span className="set-label">{t.iphone.devicesNone}</span><span className="set-hint">{t.iphone.devicesNoneHint}</span></span>
        </div>
      )}
      {devices.length > 0 && <ul className="iph-devices" aria-label={t.iphone.devices}>{devices.map((d) => <DeviceRow key={d.id} d={d} live={!!status?.enabled} />)}</ul>}
      <div className="set-group-title">{t.iphone.advanced}</div>
      <RelayField saved={s.remoteRelay} />
      <ForgetAll />
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
  const sub = [deviceSubtitle(d), connected && d.attached.length ? t.iphone.openCount(d.attached.length) : null].filter(Boolean).join(' · ');
  return (
    <li className={`iph-device${connected ? ' is-connected' : ''}${asking ? ' is-asking' : ''}`}>
      <span className="iph-device-glyph"><Icon name="phone" size={16} stroke={1.7} /></span>
      <span className="iph-device-text">
        <span className="iph-device-name">{title}</span>
        {sub && <span className="iph-device-sub">{sub}</span>}
      </span>
      {asking ? <RemoveConfirm d={d} title={title} onDone={() => setAsking(false)} /> : (
        <>
          {connected ? <span className="iph-chip"><i />{t.iphone.connected}</span> : <span className="iph-seen">{seenText({ ...d, connected: false }, now)}</span>}
          <button ref={removeBtn} type="button" className="btn-ghost sm iph-remove" aria-label={t.iphone.removeTip(title)} onClick={() => setAsking(true)}>{t.iphone.remove}</button>
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
    <div ref={box} className="iph-confirm" role="group" aria-label={t.iphone.removeAsk(title)} data-own-esc="" onKeyDown={onEscCancel(onDone)}>
      <p><b>{t.iphone.removeAsk(title)}</b> {t.iphone.removeBody}</p>
      <ConfirmActions confirm={t.iphone.remove} onConfirm={() => { onDone(); void window.atelier.remote.removeDevice(d.id); }} onCancel={onDone} end />
    </div>
  );
}

/**
 * The relay's address: saved on Enter or blur when Atelier can dial it (https anywhere; http to this computer or the
 * local network), else the field says why and the saved one stays. Esc puts the saved one back.
 */
function RelayField({ saved }: { saved: string }) {
  const [draft, setDraft] = useState(saved);
  const field = useRef<HTMLInputElement>(null);
  // Changed elsewhere (another window, Restore Defaults): shown unless the field is being edited.
  useEffect(() => { if (document.activeElement !== field.current) setDraft(saved); }, [saved]);
  const problem = draft.trim() === saved ? null : relayProblem(draft);
  const commit = () => { const v = draft.trim(); if (!relayProblem(v) && v !== saved) set({ remoteRelay: v }); };
  // The text above, the field the row's whole width under it: an address is long, and the hint stays readable.
  return (
    <div className="set-row iph-relay-row">
      <div className="set-text">
        <span className="set-label">{t.iphone.relayServer}</span><span className="set-hint">{t.iphone.relayServerHint}</span>
      </div>
      <div className="iph-relay">
        <input ref={field} className="set-text-input mono" value={draft} spellCheck={false} aria-label={t.iphone.relayServer} aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? 'iph-relay-warn' : undefined} placeholder={DEFAULT_RELAY} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            else if (e.key === 'Escape' && draft !== saved) { e.preventDefault(); e.stopPropagation(); setDraft(saved); }
          }} />
        {saved !== DEFAULT_RELAY && <button type="button" className="btn-ghost sm" onClick={() => { setDraft(DEFAULT_RELAY); set({ remoteRelay: DEFAULT_RELAY }); }}>{t.iphone.relayDefault}</button>}
      </div>
      {problem && <span id="iph-relay-warn" className="set-warn" role="note"><Icon name="info" size={12} stroke={1.8} />{problem}</span>}
    </div>
  );
}

/** Forget All: a new identity, every phone unpaired; asked in a card in its place. */
function ForgetAll() {
  const [asking, setAsking] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const asked = useRef(false);
  useEffect(() => { if (!asking && asked.current) button.current?.focus({ preventScroll: true }); asked.current = asking; }, [asking]);
  // Asked, the question takes the row's place, the row's whole width.
  if (asking) return <div className="set-row"><ForgetCard box={box} onDone={() => setAsking(false)} /></div>;
  return (
    <Row label={t.iphone.forget} hint={t.iphone.forgetHint}>
      <button ref={button} type="button" className="btn-ghost is-danger iph-forget" onClick={() => setAsking(true)}>{t.iphone.forgetButton}</button>
    </Row>
  );
}

function ForgetCard({ box, onDone }: { box: React.RefObject<HTMLDivElement | null>; onDone: () => void }) {
  useDismiss(box, onDone);
  return (
    <div ref={box} className="iph-confirm is-card" role="group" aria-label={t.iphone.forgetAsk} data-own-esc="" onKeyDown={onEscCancel(onDone)}>
      <p><b>{t.iphone.forgetAsk}</b> {t.iphone.forgetBody}</p>
      <ConfirmActions confirm={t.iphone.forgetConfirm} onConfirm={() => { onDone(); void window.atelier.remote.reset(); }} onCancel={onDone} end />
    </div>
  );
}
