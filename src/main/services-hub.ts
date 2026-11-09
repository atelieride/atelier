import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { nextErrors } from './tmux/errors';
import { IPC } from '@shared/api';
import type { ServicePane, ServicesStatus } from '@shared/services';
import { detectPort } from '@shared/logline';
import { capturePane, listPanes } from './tmux/panes';
import { LineBuffer, newLines } from './tmux/merge';
import { paneIdSchema, servicesWatchSchema } from './ipc-schemas';
import { SERVICES_PACE, captureDue, listDue } from './services-pace';

type PaneMeta = Omit<ServicePane, 'errors' | 'port' | 'stale'>;
interface PaneState { meta: PaneMeta; buffer: LineBuffer; last: string[]; busy: boolean; lastCapture: number; committedErrors: number; errors: number; port: number | null; stale: boolean; captured: boolean }
interface Project { root: string; panes: Map<string, PaneState>; windows: Set<WebContents>; watched: Set<string>; timers: NodeJS.Timeout[]; listed: string; listing: boolean; status: ServicesStatus; lastList: number }

/**
 * The project's tmux panes, read-only. While Atelier is focused: list-panes every 3 s, capture-pane every 1 s (visible)
 * or 5 s; in the background, or with no tmux server or panes, every 30 s (services-pace.ts).
 * Only while Settings › Appearance › Services is on (2026-11-02, `enabled`): off, tmux never runs.
 */
export class ServicesHub {
  private projects = new Map<string, Project>();

  constructor(private readonly deps: { focused: () => boolean; enabled: () => boolean } = { focused: () => true, enabled: () => true }) {}

  /** The window came to the front: list at once, as the other hubs refresh on focus. */
  onFocus(): void { if (this.deps.enabled()) for (const p of this.projects.values()) void this.list(p); }

  /** Services turned on (listed at once) or off (the panes go from every window; nothing runs until it is on again). */
  settingsChanged(): void {
    const on = this.deps.enabled();
    for (const p of this.projects.values()) {
      if (on) { void this.list(p); continue; }
      p.panes.clear();
      p.status = 'ok';
      this.broadcastPanes(p);
    }
  }

  open(root: string, wc: WebContents): void {
    let p = this.projects.get(root);
    if (!p) {
      const proj: Project = { root, panes: new Map(), windows: new Set(), watched: new Set(), timers: [], listed: '', listing: false, status: 'ok', lastList: 0 };
      if (this.deps.enabled()) void this.list(proj);
      proj.timers.push(setInterval(() => this.tick(proj), SERVICES_PACE.tickMs));
      this.projects.set(root, proj);
      p = proj;
    }
    p.windows.add(wc);
    wc.once('destroyed', () => this.close(root, wc));
  }

  private async list(p: Project): Promise<void> {
    if (p.listing || !this.deps.enabled()) return;
    p.listing = true;
    p.lastList = Date.now();
    try {
      const { status, panes: metas } = await listPanes(p.root);
      // Turned off while tmux answered: the panes stay gone.
      if (!this.deps.enabled()) return;
      p.status = status;
      const ids = new Set(metas.map((m) => m.id));
      for (const id of [...p.panes.keys()]) if (!ids.has(id)) p.panes.delete(id);
      for (const m of metas) {
        const st = p.panes.get(m.id);
        if (st) st.meta = m;
        else p.panes.set(m.id, { meta: m, buffer: new LineBuffer(), last: [], busy: false, lastCapture: 0, committedErrors: 0, errors: 0, port: null, stale: false, captured: false });
      }
      this.broadcastPanes(p);
    } catch {
      /* tmux gone or a transient error: retry on the next round */
    } finally {
      p.listing = false;
    }
  }

  private tick(p: Project): void {
    if (!this.deps.enabled()) return;
    const now = Date.now();
    const focused = this.deps.focused();
    if (listDue({ last: p.lastList, now, focused, status: p.status, panes: p.panes.size })) void this.list(p);
    for (const [id, st] of p.panes) {
      if (st.busy || !captureDue({ last: st.lastCapture, now, focused, watched: p.watched.has(id) })) continue;
      st.busy = true;
      st.lastCapture = now;
      void capturePane(id).then((next) => {
        if (p.panes.get(id) !== st || !this.deps.enabled()) return;
        const r = newLines(st.last, next);
        st.last = next;
        const live = next.at(-1) ?? '';
        const liveChanged = live !== st.buffer.live;
        const first = !st.captured;
        st.captured = true;
        if (r.reset) st.buffer.reset(r.appended); else st.buffer.push(r.appended);
        st.buffer.live = live;
        // New errors not yet seen (the history of the first capture doesn't count; looking at the pane resets them).
        const counted = nextErrors({ committed: st.committedErrors }, { reset: r.reset, first, appended: r.appended, live, seen: p.watched.has(id) });
        st.committedErrors = counted.committed;
        const errors = counted.total;
        const port = st.port ?? detectPort([...r.appended, live]);
        const metaChanged = port !== st.port || errors !== st.errors || st.stale;
        st.stale = false;
        st.port = port;
        st.errors = errors;
        if (r.appended.length || r.reset || liveChanged) this.send(p, IPC.evServiceLines, { id, lines: r.appended, reset: r.reset, seq: st.buffer.seq, live });
        if (metaChanged) this.broadcastPanes(p);
      }).catch(() => {
        // Pane gone (the next list removes it) or capture impossible: flag it instead of staying silent.
        if (!st.stale) { st.stale = true; this.broadcastPanes(p); }
      }).finally(() => { st.busy = false; });
    }
  }

  private panesOf(p: Project): ServicePane[] {
    return [...p.panes.values()].map((s) => ({ ...s.meta, errors: s.errors, port: s.port, stale: s.stale }))
      .sort((a, b) => a.session.localeCompare(b.session) || a.window - b.window || a.index - b.index);
  }

  private broadcastPanes(p: Project): void {
    const payload = { status: p.status, panes: this.panesOf(p) };
    const key = JSON.stringify(payload);
    if (key === p.listed) return;
    p.listed = key;
    this.send(p, IPC.evServices, payload);
  }

  private send(p: Project, channel: string, payload: unknown): void {
    for (const wc of p.windows) if (!wc.isDestroyed()) wc.send(channel, payload);
  }

  private close(root: string, wc: WebContents): void {
    const p = this.projects.get(root);
    if (!p) return;
    p.windows.delete(wc);
    if (p.windows.size === 0) { p.timers.forEach(clearInterval); this.projects.delete(root); }
  }

  installIpc(projectOf: (wcId: number) => string | null, isTrusted: (e: IpcMainInvokeEvent | IpcMainEvent) => boolean): void {
    const proj = (e: IpcMainInvokeEvent | IpcMainEvent) => {
      const r = projectOf(e.sender.id);
      if (!r || !isTrusted(e)) throw new Error('unauthorized sender');
      return this.projects.get(r) ?? null;
    };
    ipcMain.handle(IPC.servicesList, (e) => { const p = proj(e); return p ? { status: p.status, panes: this.panesOf(p) } : { status: 'ok', panes: [] }; });
    ipcMain.handle(IPC.servicesLines, (e, arg) => {
      const p = proj(e);
      const st = p?.panes.get(paneIdSchema.parse(arg));
      return st ? { lines: st.buffer.lines(), seq: st.buffer.seq, live: st.buffer.live } : { lines: [], seq: 0, live: '' };
    });
    ipcMain.on(IPC.servicesWatch, (e, arg) => {
      let p: Project | null;
      try { p = proj(e); } catch { return; }
      const ids = servicesWatchSchema.safeParse(arg);
      if (p && ids.success) p.watched = new Set(ids.data);
    });
  }
}
