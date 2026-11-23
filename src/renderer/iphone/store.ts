// iPhone access in this window: the status main pushes (Settings › iPhone, the footer pill, the phone badges, the size
// note) and whether the pairing sheet is open. A store of its own: a phone attaching re-renders only what shows it.
import { create } from 'zustand';
import type { RemoteRowsEvent, RemoteStatus } from '@shared/remote';
import { useApp } from '../store';
import { phoneTerminals } from './view';

interface IphoneState {
  /** null until asked: with access off, main is asked only when Settings › iPhone opens (it may touch the Keychain). */
  status: RemoteStatus | null;
  /** The terminals a connected phone has open, and those whose size a phone owns. */
  attached: ReadonlySet<string>;
  sized: ReadonlySet<string>;
  pairOpen: boolean;
  /** The marks' stylesheet is in: the pill, the badges and the size note show only then (never unstyled). */
  marksReady: boolean;
  /** A phone as Settings › iPhone calls it (its model when iOS only says "iPhone"): the footer pill's tooltip. */
  deviceTitle(d: { name: string; model: string }): string;
  setStatus(s: RemoteStatus): void;
  setPairOpen(open: boolean): void;
}

const NONE: ReadonlySet<string> = new Set();

/**
 * The marks' stylesheet and the phones' names, fetched once access is on (a status that says so), long before a phone
 * connects: nobody without iPhone access, the live demo included, pays for them in the first paint.
 */
let marksAsked = false;
function loadMarks(): void {
  if (marksAsked) return;
  marksAsked = true;
  Promise.all([import('./marks.css'), import('./device-name')]).then(
    ([, names]) => useIphone.setState({ marksReady: true, deviceTitle: names.deviceTitle }),
    () => { marksAsked = false; }
  );
}

/** `prev` when it holds exactly `ids`, else a new set of them. */
function sameOr(prev: ReadonlySet<string>, ids: readonly string[]): ReadonlySet<string> {
  const next = new Set(ids);
  if (next.size === prev.size && [...next].every((id) => prev.has(id))) return prev;
  return next.size ? next : NONE;
}

export const useIphone = create<IphoneState>((set, get) => ({
  status: null,
  attached: NONE,
  sized: NONE,
  pairOpen: false,
  marksReady: false,
  deviceTitle: (d) => d.name.trim() || 'iPhone',
  setStatus: (status) => {
    const prev = get();
    if (status.enabled) loadMarks();
    // The sets keep their identity while their content stays: rows and tabs re-render only when theirs changes.
    set({ status, attached: sameOr(prev.attached, phoneTerminals(status)), sized: sameOr(prev.sized, status.enabled ? status.sized.map((s) => s.id) : []) });
  },
  setPairOpen: (pairOpen) => set({ pairOpen })
}));

/** Asks main for the status now (Settings › iPhone shown, the pairing sheet off, access turned on); settled either way. */
export function refreshIphone(): Promise<void> {
  return window.atelier.remote.status().then((s) => useIphone.getState().setStatus(s)).catch(() => {});
}

/**
 * Whether this page offers iPhone access: always in the app; not in the website's live demo, where Settings lists no
 * iPhone section, the palette has no Pair iPhone… and nothing opens the pairing sheet.
 */
export function iphoneOffered(): boolean {
  // Only when the bridge says so: a view rendered with no bridge at all (a unit test's palette) offers none either.
  return typeof window !== 'undefined' && window.atelier?.remote?.offered === true;
}

/** Pair iPhone… (Settings › iPhone, the menu, the palette): the pairing sheet, over whatever is open. */
export function openPairing(): void {
  if (!iphoneOffered()) return;
  useIphone.getState().setPairOpen(true);
}

/**
 * The window's iPhone plumbing: the status as main pushes it, and asked once at start when access is on (off, main
 * isn't asked: nothing shows it until Settings › iPhone opens); with access on, the sidebar's arrangement for the phones
 * and what they change in it (access-on.ts).
 */
export function installIphone(): () => void {
  let live = true;
  let on: { rows(e: RemoteRowsEvent): void; off(): void } | null = null;
  let asked = false;
  // What a phone does to the rows before that module is in (a window opening as a phone acts): kept for it, in order.
  const early: RemoteRowsEvent[] = [];
  const offRows = window.atelier.on.remoteRows((e) => { if (on) on.rows(e); else early.push(e); });
  // Its module is fetched once access is on, so nobody without iPhone access (the live demo included) pays for it in
  // the first paint. Main holds a change to the places until that module asks.
  const load = () => {
    if (asked) return;
    asked = true;
    import('./access-on').then((m) => {
      if (!live) return;
      on = m.installAccessOn();
      for (const e of early.splice(0)) on.rows(e);
    }, () => { asked = false; });
  };
  const accessOn = () => { void refreshIphone(); load(); };
  if (useApp.getState().settings.remoteAccess) accessOn();
  const offStatus = window.atelier.on.remote((s) => useIphone.getState().setStatus(s));
  // The settings arrive after the window starts: access found on then (or turned on) asks for the status once.
  const offSettings = useApp.subscribe((s, prev) => { if (s.settings.remoteAccess && !prev.settings.remoteAccess) accessOn(); });
  return () => { live = false; offStatus(); offSettings(); offRows(); on?.off(); };
}
