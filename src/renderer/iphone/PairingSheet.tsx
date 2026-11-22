// Pair iPhone…: the modal sheet with the code (QR and text) and its countdown, then the question when a phone presents
// it. Its own chunk (the QR encoder with it): never in the first paint, the app's nor the live demo's. Closing it ends
// the pairing (stopPairing): the code on screen dies with the sheet.
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { RemotePairing } from '@shared/remote';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { Icon } from '../components/Icon';
import { PAIR_START, pairReducer, type PairSheet } from './pairing';
import { qrPath } from './qr';
import { useIphone } from './store';
import { countdown, deviceSubtitle, deviceTitle } from './view';
import './iphone.css';

/** What is left until `until` (ms), re-rendered as each second turns. */
function useLeft(until: number | null): number {
  const [, tick] = useReducer((x: number) => x + 1, 0);
  const left = until === null ? 0 : until - Date.now();
  useEffect(() => {
    if (until === null || left <= 0) return;
    const timer = setTimeout(tick, (left % 1000 || 1000) + 15);
    return () => clearTimeout(timer);
  });
  return Math.max(0, left);
}

const close = () => useIphone.getState().setPairOpen(false);

export function PairingSheet() {
  const [s, dispatch] = useReducer(pairReducer, PAIR_START);
  const sheet = useRef<HTMLDivElement>(null);
  const alive = useRef(true);

  const start = () => {
    dispatch({ kind: 'start' });
    window.atelier.remote.startPairing().then(
      (result) => { if (alive.current) dispatch({ kind: 'started', result }); },
      () => { if (alive.current) dispatch({ kind: 'started', result: { ok: false, reason: 'failed', message: t.iphone.errorTitle } }); }
    );
  };

  useEffect(() => {
    alive.current = true;
    const off = window.atelier.on.remotePairing((e) => dispatch(e));
    start();
    // The sheet closes, the pairing ends: its code dies and a phone still waiting for an answer is told.
    return () => { alive.current = false; off(); void window.atelier.remote.stopPairing().catch(() => {}); };
  }, []);

  // Paired: the sheet closes with the news. Stopped elsewhere (another window's sheet, access turned off): a code again.
  useEffect(() => {
    if (s.phase === 'paired') { close(); useApp.getState().showToast(t.iphone.paired, undefined, 'info'); }
    else if (s.phase === 'stopped') start();
  }, [s.phase]);

  // Esc closes and Tab stays inside, wherever the focus was; nothing reaches what is under it (Settings, a terminal).
  useLayoutEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sheet.current?.focus();
    return () => {
      const now = document.activeElement;
      if (before && before.isConnected && (!now || now === document.body || !now.isConnected)) before.focus();
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const root = sheet.current;
      if (!root) return;
      // A menu, or a question drawn over the sheet (one from main), keeps its own keys; Settings under it doesn't.
      const focus = document.activeElement as HTMLElement | null;
      if (focus?.closest('.ctx-menu') || (focus?.closest('[role="dialog"]:not(.settings)') && !root.contains(focus))) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key !== 'Tab') return;
      const items = [...root.querySelectorAll<HTMLElement>('button:not(:disabled)')];
      if (items.length === 0) { e.preventDefault(); return; }
      const inside = root.contains(document.activeElement) && document.activeElement !== root;
      if (!inside) { e.preventDefault(); e.stopPropagation(); (e.shiftKey ? items.at(-1)! : items[0]!).focus(); return; }
      if (e.shiftKey && document.activeElement === items[0]) { e.preventDefault(); items.at(-1)!.focus(); }
      else if (!e.shiftKey && document.activeElement === items.at(-1)) { e.preventDefault(); items[0]!.focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const asking = s.phase === 'request';
  return (
    <div className="palette-backdrop settings-backdrop" onMouseDown={close}>
      <div ref={sheet} className={`pair-sheet${asking ? ' is-asking' : ''}`} role="dialog" aria-modal="true" aria-label={t.iphone.sheetTitle} tabIndex={-1} onMouseDown={(e) => e.stopPropagation()}>
        <header className="pair-head">
          <span className="pair-head-glyph"><Icon name="phone" size={15} stroke={1.8} /></span>
          <h2>{t.iphone.sheetTitle}</h2>
          <span className="grow" />
          <button type="button" className="pair-x" aria-label={t.iphone.close} data-tip={t.iphone.close} data-kbd="Esc" onClick={close}><Icon name="x" size={12} stroke={2} /></button>
        </header>
        <Body s={s} onStart={start} onAllow={(id) => { dispatch({ kind: 'allow' }); void window.atelier.remote.decide(id, true); }} />
      </div>
    </div>
  );
}

function Body({ s, onStart, onAllow }: { s: PairSheet; onStart: () => void; onAllow: (id: string) => void }) {
  switch (s.phase) {
    case 'starting':
    case 'stopped':
    case 'paired':
      return <div className="pair-body is-starting" aria-busy="true"><span className="pair-spin" aria-hidden="true" /></div>;
    case 'off': return <Off onStart={onStart} />;
    case 'error':
      return (
        <div className="pair-body pair-message">
          <span className="pair-hero is-error"><Icon name="info" size={22} stroke={1.7} /></span>
          <h3>{t.iphone.errorTitle}</h3>
          <p>{s.message}</p>
          <div className="pair-actions"><button type="button" className="btn-ghost" onClick={close}>{t.iphone.close}</button><button type="button" className="btn-primary" onClick={onStart}>{t.iphone.tryAgain}</button></div>
        </div>
      );
    case 'code': return <Code pairing={s.pairing} notice={s.notice} spent={s.waiting} />;
    case 'request': return <Ask s={s} onAllow={onAllow} />;
  }
}

/** Access off: turning it on here goes straight on to the code (main dials the relay as the setting changes). */
function Off({ onStart }: { onStart: () => void }) {
  const unavailable = useIphone((x) => x.status?.available === false);
  const turnOn = () => { void window.atelier.settings.set({ remoteAccess: true }).then(onStart, onStart); };
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  return (
    <div className="pair-body pair-message">
      <span className={`pair-hero${unavailable ? ' is-error' : ''}`}><Icon name="phone" size={24} stroke={1.6} /></span>
      <h3>{unavailable ? t.iphone.unavailableTitle : t.iphone.offTitle}</h3>
      <p>{unavailable ? t.iphone.relay.unavailable : t.iphone.offBody}</p>
      <div className="pair-actions">
        <button type="button" className="btn-ghost" onClick={close}>{t.confirm.cancel}</button>
        {!unavailable && <button ref={first} type="button" className="btn-primary" onClick={turnOn}><Icon name="qr" size={13} stroke={1.9} />{t.iphone.turnOn}</button>}
      </div>
    </div>
  );
}

/** The code: its QR code, its text in large mono (selectable), the steps, and the time it has left. */
function Code({ pairing, notice, spent }: { pairing: RemotePairing; notice: 'declined' | 'expired' | null; spent: boolean }) {
  const qr = useMemo(() => qrPath(pairing.qr), [pairing.qr]);
  // The time it lives, for the bar: from the first second it was seen here.
  const [life] = useState(() => new Map<string, number>());
  if (!life.has(pairing.code)) life.set(pairing.code, Math.max(1000, pairing.expiresAt - Date.now()));
  const total = life.get(pairing.code)!;
  const left = useLeft(spent ? null : pairing.expiresAt);
  const renewing = spent || left <= 0;
  // A code the relay can't hand to a phone yet (still connecting, or unreachable): said, so nobody types it in vain.
  const offline = useIphone((x) => !!x.status?.enabled && x.status.relay.state !== 'online');
  const pad = 4;
  return (
    <div className="pair-body pair-code-body">
      <div className={`pair-qr${renewing ? ' is-spent' : ''}`} role="img" aria-label={t.iphone.qrLabel} data-qr={pairing.qr}>
        <svg viewBox={`${-pad} ${-pad} ${qr.size + pad * 2} ${qr.size + pad * 2}`} shapeRendering="crispEdges" aria-hidden="true">
          <rect x={-pad} y={-pad} width={qr.size + pad * 2} height={qr.size + pad * 2} className="pair-qr-paper" />
          <path d={qr.d} className="pair-qr-ink" />
        </svg>
      </div>
      <div className="pair-side">
        <ol className="pair-steps">
          <li><span className="pair-step-n">1</span>{t.iphone.step1}</li>
          <li><span className="pair-step-n">2</span>{t.iphone.step2}</li>
        </ol>
        <div className="pair-code-label">{t.iphone.codeLabel}</div>
        <div key={pairing.code} className={`pair-code mono${renewing ? ' is-spent' : ''}`} aria-live="polite">{pairing.code}</div>
        <div className="pair-timer" aria-hidden={renewing ? undefined : 'true'}>
          <span className="pair-bar"><span key={pairing.code} style={{ transform: `scaleX(${renewing ? 0 : left / total})` }} /></span>
          <span className="pair-left mono">{renewing ? t.iphone.renewing : t.iphone.renewsIn(countdown(left))}</span>
        </div>
        {offline && !notice && <p className="pair-notice" role="status"><Icon name="info" size={13} stroke={1.8} />{t.iphone.notOnline}</p>}
        {notice && <p className="pair-notice" role="status"><Icon name="info" size={13} stroke={1.8} />{notice === 'declined' ? t.iphone.declined : t.iphone.expired}</p>}
      </div>
    </div>
  );
}

/** A phone presented the code: who it is, what it will be able to do, Allow or Deny before the question expires. */
function Ask({ s, onAllow }: { s: Extract<PairSheet, { phase: 'request' }>; onAllow: (id: string) => void }) {
  const left = useLeft(s.request.expiresAt);
  const deny = useRef<HTMLButtonElement>(null);
  // The safe answer takes the keyboard: an Enter meant for something else never lets a phone in.
  useEffect(() => { deny.current?.focus(); }, [s.request.id]);
  const title = deviceTitle(s.request);
  const sub = deviceSubtitle(s.request);
  return (
    <div className="pair-body pair-message pair-ask">
      <span className="pair-hero is-asking"><Icon name="phone" size={24} stroke={1.6} /></span>
      <h3>{t.iphone.askTitle(title)}</h3>
      {sub && <span className="pair-ask-model">{sub}</span>}
      <p>{t.iphone.askBody}</p>
      <span className="pair-left mono">{t.iphone.answerWithin(countdown(left))}</span>
      <div className="pair-actions">
        <button ref={deny} type="button" className="btn-ghost" disabled={s.answering} onClick={() => void window.atelier.remote.decide(s.request.id, false)}>{t.iphone.deny}</button>
        <button type="button" className="btn-primary" disabled={s.answering} onClick={() => onAllow(s.request.id)}>{s.answering ? t.iphone.allowing : t.iphone.allow}</button>
      </div>
    </div>
  );
}
