import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC } from '@shared/api';
import type { TerminalInfo } from '@shared/protocol';
import { MAX_PORTS, portUrl, visiblePorts, type PortInfo, type PortsMap } from '@shared/ports';
import { MAX_PIDS, descendants, type ListeningProc } from './procs/exec';
import { portsOpenSchema } from './ipc-schemas';

const POLL_MS = 4000;
/** lsof every round for this long after the processes change (a server may bind well after it starts: a JVM, a build). */
const LSOF_WINDOW_MS = 30_000;
/** With the same processes, lsof only this often (ps, cheap, keeps the 4 s pace). */
const LSOF_REST_MS = 30_000;

/** Each terminal with a pid: the listening ports of its shell and every descendant, sorted, once, at most MAX_PORTS. */
export function terminalPorts(terminals: readonly TerminalInfo[], tree: Map<number, number[]>, listening: Map<number, ListeningProc>): PortsMap {
  const out: PortsMap = {};
  for (const t of terminals) {
    if (!t.pid) continue;
    const found = new Map<number, PortInfo>();
    for (const pid of descendants(tree, t.pid)) {
      const l = listening.get(pid);
      if (!l) continue;
      for (const port of l.ports) if (!found.has(port)) found.set(port, { port, ...(l.name ? { name: l.name } : {}) });
    }
    if (found.size) out[t.id] = [...found.values()].sort((a, b) => a.port - b.port).slice(0, MAX_PORTS);
  }
  return out;
}

export interface PortsDeps {
  readTree(): Promise<Map<number, number[]>>;
  readListening(pids: number[]): Promise<Map<number, ListeningProc>>;
  /** Settings › Terminal › Show listening ports. Off: no process is ever run. */
  enabled(): boolean;
  /** Any Atelier window focused (hidden e2e windows count as focused). */
  focused(): boolean;
  /** Settings › Terminal › Show ephemeral ports: off (the default), 49152–65535 are hidden. */
  showEphemeral?(): boolean;
  /** The scan's pace (POLL_MS; shorter in e2e). */
  pollMs?: number;
}

/** The part of a WebContents the hub uses. */
export interface PortsWindow {
  id: number;
  send(channel: string, payload: PortsMap): void;
  isDestroyed(): boolean;
  once(event: 'destroyed', fn: () => void): void;
}

interface WindowEntry { wc: PortsWindow; project: string; sent: string }

/**
 * Listening ports per terminal: every 4 s while an Atelier window is focused, at once on focus and when
 * the terminals (or their pids) change; never with the setting off. Each window gets its project's terminals only,
 * only when they change. A failed read keeps the last result (retried on the next tick).
 */
export class PortsHub {
  private terminals: TerminalInfo[] = [];
  private signature = '';
  private result: PortsMap = {};
  private windows = new Map<number, WindowEntry>();
  private running = false;
  private again = false;
  /** The pids lsof last looked at, until when it runs every round, when it last succeeded, a full scan asked for. */
  private lastPids = '';
  private watchUntil = 0;
  private lastLsof = 0;
  private force = false;
  private timer: NodeJS.Timeout;

  constructor(private readonly deps: PortsDeps) {
    this.timer = setInterval(() => { if (this.deps.focused()) void this.scan(); }, this.deps.pollMs ?? POLL_MS);
    this.timer.unref?.();
  }

  open(project: string, wc: PortsWindow): void {
    this.windows.set(wc.id, { wc, project, sent: JSON.stringify({}) });
    wc.once('destroyed', () => this.windows.delete(wc.id));
  }

  /** atelierd's terminal list: a closed terminal loses its ports at once; new terminals or pids scan right away. */
  setTerminals(list: readonly TerminalInfo[]): void {
    this.terminals = [...list];
    const ids = new Set(list.map((t) => t.id));
    const kept = Object.fromEntries(Object.entries(this.result).filter(([id]) => ids.has(id)));
    if (Object.keys(kept).length !== Object.keys(this.result).length) { this.result = kept; this.broadcast(); }
    const sig = list.map((t) => `${t.id}:${t.pid ?? ''}`).join(',');
    if (sig === this.signature) return;
    this.signature = sig;
    if (this.deps.focused()) void this.scan();
  }

  /** A window gained focus. */
  refresh(): void {
    this.force = true;
    void this.scan();
  }

  /** Settings changed: off clears every window's chips at once; on scans right away; ephemeral ports apply at once. */
  settingsChanged(): void {
    if (!this.deps.enabled()) { this.result = {}; this.broadcast(); return; }
    this.broadcast();
    // Back on (the result was cleared) or a different filter: read the ports now, whatever lsof's pace.
    this.force = true;
    void this.scan();
  }

  /** The project's terminals with the ports to show (ephemeral ones per the setting); terminals left with none absent. */
  portsOf(project: string): PortsMap {
    const mine = new Set(this.terminals.filter((t) => t.projectRoot === project).map((t) => t.id));
    const ephemeral = this.deps.showEphemeral?.() ?? false;
    const out: PortsMap = {};
    for (const [id, list] of Object.entries(this.result)) {
      if (!mine.has(id)) continue;
      const shown = visiblePorts(list, ephemeral);
      if (shown.length) out[id] = shown;
    }
    return out;
  }

  /** The URL to open for a port chip, only if that port is listed now for that terminal of this project. */
  openTarget(project: string, id: string, port: number): string | null {
    return this.portsOf(project)[id]?.some((p) => p.port === port) ? portUrl(port) : null;
  }

  /** Every terminal's listening ports with its process name (the Redis view's servers started in a terminal). */
  listening(): { project: string; port: number; name: string; title: string; pid: number | null }[] {
    return this.terminals.flatMap((t) => (this.result[t.id] ?? []).map((p) => ({ project: t.projectRoot, port: p.port, name: p.name ?? '', title: t.title, pid: t.pid ?? null })));
  }

  /** The terminals atelierd reported (pids for the Redis view's clients). */
  terminalList(): readonly TerminalInfo[] { return this.terminals; }

  /** Called after each scan whose result changed (the Redis view looks for servers in terminals). */
  onChange: (() => void) | null = null;

  dispose(): void {
    clearInterval(this.timer);
  }

  private async scan(): Promise<void> {
    if (!this.deps.enabled()) return;
    if (this.running) { this.again = true; return; }
    this.running = true;
    try {
      const roots = this.terminals.filter((t) => t.pid);
      if (roots.length === 0) { this.result = {}; return; }
      const tree = await this.deps.readTree();
      // Shells first, then their descendants: if the list must be capped, terminals still get their own processes.
      const trees = roots.map((t) => descendants(tree, t.pid!));
      const pids = [...new Set([...trees.map((d) => d[0]!), ...trees.flat()])].slice(0, MAX_PIDS);
      // Same processes as last time, no change in the last rounds, lsof run recently: the ports are the same.
      const key = pids.join(',');
      const now = Date.now();
      if (key !== this.lastPids) { this.lastPids = key; this.watchUntil = now + LSOF_WINDOW_MS; }
      if (!this.force && now > this.watchUntil && now - this.lastLsof < LSOF_REST_MS) return;
      this.force = false;
      const listening = await this.deps.readListening(pids);
      // Only a read that worked sets the pace: a failed one is tried again on the next tick.
      this.lastLsof = now;
      // Turned off while reading: the cleared result stays.
      if (this.deps.enabled()) this.result = terminalPorts(this.terminals, tree, listening);
    } catch {
      /* ps or lsof failed (timeout, output too large): keep the last result, retry on the next tick */
    } finally {
      this.running = false;
      this.broadcast();
      if (this.again) { this.again = false; void this.scan(); }
    }
  }

  private lastResult = '';

  private broadcast(): void {
    const key = JSON.stringify(this.result);
    if (key !== this.lastResult) { this.lastResult = key; this.onChange?.(); }
    for (const w of this.windows.values()) {
      if (w.wc.isDestroyed()) continue;
      const payload = this.portsOf(w.project);
      const key = JSON.stringify(payload);
      if (key === w.sent) continue;
      w.sent = key;
      w.wc.send(IPC.evPorts, payload);
    }
  }

  /**
   * ports:list (the window's project only) and ports:open: sender checked, strict schema, and the port must be listed
   * now for that terminal; main builds the URL (http://localhost:<port>/) and opens it in the user's browser.
   */
  installIpc(projectOf: (wcId: number) => string | null, isTrusted: (e: IpcMainInvokeEvent) => boolean, openUrl: (url: string) => Promise<boolean>): void {
    const project = (e: IpcMainInvokeEvent) => {
      const r = projectOf(e.sender.id);
      if (!r || !isTrusted(e)) throw new Error('unauthorized sender');
      return r;
    };
    ipcMain.handle(IPC.portsList, (e) => this.portsOf(project(e)));
    ipcMain.handle(IPC.portsOpen, async (e, arg) => {
      const root = project(e);
      const { id, port } = portsOpenSchema.parse(arg);
      const url = this.openTarget(root, id, port);
      return url ? openUrl(url) : false;
    });
  }
}
