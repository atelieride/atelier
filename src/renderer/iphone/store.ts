// iPhone access in this window: the status main pushes (Settings › iPhone, the footer pill, the phone badges, the size
// note) and whether the pairing sheet is open. A store of its own: a phone attaching re-renders only what shows it.
import { create } from 'zustand';
import type { RemoteStatus } from '@shared/remote';
import { useApp } from '../store';
import { phoneTerminals } from './view';
import { installLayoutSync } from './layout-sync';
import { installPhoneRows } from './phone-rows';

interface IphoneState {
  /** null until asked: with access off, main is asked only when Settings › iPhone opens (it may touch the Keychain). */
  status: RemoteStatus | null;
  /** The terminals a connected phone has open, and those whose size a phone owns. */
  attached: ReadonlySet<string>;
  sized: ReadonlySet<string>;
  pairOpen: boolean;
  /** The marks' stylesheet is in: the pill, the badges and the size note show only then (never unstyled). */
  marksReady: boolean;
  setStatus(s: RemoteStatus): void;
  setPairOpen(open: boolean): void;
}

const NONE: ReadonlySet<string> = new Set();

/**
 * The marks' stylesheet, fetched once access is on (a status that says so), long before a phone connects: nobody
 * without iPhone access, the live demo included, pays for it in the first paint.
 */
let marksAsked = false;
function loadMarks(): void {
  if (marksAsked) return;
  marksAsked = true;
  import('./marks.css').then(() => useIphone.setState({ marksReady: true }), () => { marksAsked = false; });
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
  setStatus: (status) => {
    const prev = get();
    if (status.enabled) loadMarks();
    // The sets keep their identity while their content stays: rows and tabs re-render only when theirs changes.
    set({ status, attached: sameOr(prev.attached, phoneTerminals(status)), sized: sameOr(prev.sized, status.enabled ? status.sized.map((s) => s.id) : []) });
  },
  setPairOpen: (pairOpen) => set({ pairOpen })
}));

/** Asks main for the status now (Settings › iPhone opening, access turned on). */
export function refreshIphone(): void {
  void window.atelier.remote.status().then((s) => useIphone.getState().setStatus(s)).catch(() => {});
}

/** Pair iPhone… (Settings › iPhone, the menu, the palette): the pairing sheet, over whatever is open. */
export function openPairing(): void {
  useIphone.getState().setPairOpen(true);
}

/**
 * The window's iPhone plumbing: the status as main pushes it, and asked once at start when access is on (off, main
 * isn't asked: nothing shows it until Settings › iPhone opens); with access on, the sidebar's arrangement for the phones
 * and what they change in it.
 */
export function installIphone(): () => void {
  let live = true;
  let offPlaces: (() => void) | null = null;
  let placesAsked = false;
  // What phones change in the workspaces and activities: its module is fetched once access is on, so nobody without
  // iPhone access (the live demo included) pays for it in the first paint. Main holds a change until the module asks.
  const loadPlaces = () => {
    if (placesAsked) return;
    placesAsked = true;
    import('./phone-places').then((m) => { if (live) offPlaces = m.installPhonePlaces(); }, () => { placesAsked = false; });
  };
  const accessOn = () => { refreshIphone(); loadPlaces(); };
  if (useApp.getState().settings.remoteAccess) accessOn();
  const offStatus = window.atelier.on.remote((s) => useIphone.getState().setStatus(s));
  // The settings arrive after the window starts: access found on then (or turned on) asks for the status once.
  const offSettings = useApp.subscribe((s, prev) => { if (s.settings.remoteAccess && !prev.settings.remoteAccess) accessOn(); });
  // The project's sidebar arrangement, for the phones' grouping; what a phone does to the rows, followed here.
  const offLayout = installLayoutSync();
  const offRows = installPhoneRows();
  return () => { live = false; offStatus(); offSettings(); offLayout(); offRows(); offPlaces?.(); };
}
