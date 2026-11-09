// The connectors registry: the list of connectors, their state broadcast to every window
// (`ev:connectors`, `connectors:list`), their toasts (`ev:connector-notice`) and the IPC the renderer uses. Every handler
// checks the sender is an app page and parses its payload with a strict schema. Replies and events carry ConnectorInfo,
// TaskList, TaskDetail and TaskSummary only: never a token, an auth URL, a code or a tool name. There is no generic
// "call tool" channel; the open-task channel takes a task id and main opens the URL it holds.
import type { IpcMainInvokeEvent } from 'electron';
import { IPC } from '@shared/api';
import type { AddSourceResult, ConnectorId, ConnectorInfo, ConnectorNotice, ConnectorNoticeKind, FilterPick, SourcePick, TaskList } from '@shared/tasks';
import {
  connectorOptionsSchema, connectorRefSchema, filterSetSchema, noArgsSchema, sourceAddSchema, sourceFieldsSchema, sourceRefSchema, sourceScopeSchema,
  sourceSearchSchema, taskRefSchema, taskSearchSchema, tokenConnectSchema
} from '../ipc-schemas';
import type { Connector } from './connector';

/** The part of a window's WebContents the registry uses. */
export interface RegistryWindow {
  id: number;
  send(channel: string, payload: unknown): void;
  isDestroyed(): boolean;
}

export interface RegistryDeps {
  windows(): RegistryWindow[];
  /** The focused window's WebContents id, if any. */
  focusedId(): number | null;
}

/** Toasts that come from background checks: at most once per app launch per connector. */
const ONCE_PER_LAUNCH: ReadonlySet<ConnectorNoticeKind> = new Set(['reconnect', 'unavailable']);

type Handle = (channel: string, fn: (e: IpcMainInvokeEvent, arg?: unknown) => unknown) => void;

export class ConnectorRegistry {
  private last = '';
  private readonly shown = new Set<string>();
  private pending: ConnectorNotice[] = [];
  /** Windows whose renderer asked for connectors:list, so it listens: only these get notices (a toast is never lost). */
  private readonly ready = new Set<number>();

  constructor(private readonly connectors: readonly Connector[], private readonly deps: RegistryDeps) {}

  list(): ConnectorInfo[] {
    return this.connectors.map((c) => c.info());
  }

  /** A connector's state changed: every window gets the list, unless it is the same as last sent. */
  changed(): void {
    const list = this.list();
    const key = JSON.stringify(list);
    if (key === this.last) return;
    this.last = key;
    for (const w of this.deps.windows()) if (!w.isDestroyed()) w.send(IPC.evConnectors, list);
  }

  /**
   * A toast for one ready window (one whose renderer asked for the list, so it listens): the one that asked
   * (`origin`), else the focused one, else the first. None ready yet → queued for the next connectors:list reply.
   */
  notice(n: ConnectorNotice, origin?: number): void {
    if (ONCE_PER_LAUNCH.has(n.kind)) {
      const key = `${n.id}:${n.kind}`;
      if (this.shown.has(key)) return;
      this.shown.add(key);
    }
    const wins = this.deps.windows().filter((w) => !w.isDestroyed() && this.ready.has(w.id));
    const focused = this.deps.focusedId();
    const target = wins.find((w) => w.id === origin) ?? wins.find((w) => w.id === focused) ?? wins[0];
    if (!target) { this.pending.push(n); return; }
    target.send(IPC.evConnectorNotice, n);
  }

  windowFocused(): void {
    for (const c of this.connectors) c.windowFocused();
  }

  dispose(): void {
    for (const c of this.connectors) c.dispose();
  }

  private get(id: ConnectorId): Connector {
    const c = this.connectors.find((x) => x.id === id);
    if (!c) throw new Error('unknown connector');
    return c;
  }

  /**
   * `openApp`: opens a task in its desktop app; false (not installed, turned off, failed) → `openUrl` opens the page.
   * It gets the task's source: each connector has its own "Open tasks in the app" setting.
   */
  installIpc(
    handle: Handle, isTrusted: (e: IpcMainInvokeEvent) => boolean, openUrl: (url: string) => Promise<boolean>,
    openApp: (url: string, source: ConnectorId) => Promise<boolean> = async () => false
  ): void {
    const check = (e: IpcMainInvokeEvent) => { if (!isTrusted(e)) throw new Error('unauthorized sender'); };
    const action = (channel: string, run: (c: Connector, e: IpcMainInvokeEvent) => void) => {
      handle(channel, (e, arg) => {
        check(e);
        const c = this.get(connectorRefSchema.parse(arg).id);
        run(c, e);
        return c.info();
      });
    };
    // The list, plus the toasts that came before any window could show them (taken once, by whoever asks first). The
    // asking window is ready from now on: its renderer listens.
    handle(IPC.connectorsList, (e, arg) => {
      check(e);
      noArgsSchema.parse(arg);
      this.ready.add(e.sender.id);
      const notices = this.pending;
      this.pending = [];
      return { connectors: this.list(), notices };
    });
    action(IPC.connectorsConnect, (c, e) => c.connect(e.sender.id));
    action(IPC.connectorsCancel, (c) => c.cancel());
    action(IPC.connectorsReopenAuth, (c) => c.reopenAuth());
    action(IPC.connectorsDisconnect, (c) => c.disconnect());
    action(IPC.connectorsRefresh, (c, e) => c.refresh(e.sender.id));
    handle(IPC.connectorsSetOptions, (e, arg) => {
      check(e);
      const { id, options } = connectorOptionsSchema.parse(arg);
      const c = this.get(id);
      c.setOptions(options);
      return c.info();
    });
    // Sources: a connector without them answers `unsupported` / nothing / its card unchanged.
    handle(IPC.connectorsSearchSources, async (e, arg): Promise<SourcePick[]> => {
      check(e);
      const { id, query } = sourceSearchSchema.parse(arg);
      return (await this.get(id).searchSources?.(query)) ?? [];
    });
    handle(IPC.connectorsAddSource, async (e, arg): Promise<AddSourceResult> => {
      check(e);
      const { id, ref } = sourceAddSchema.parse(arg);
      return (await this.get(id).addSource?.(ref)) ?? { ok: false, reason: 'unsupported' };
    });
    handle(IPC.connectorsRemoveSource, async (e, arg) => {
      check(e);
      const { id, sourceId } = sourceRefSchema.parse(arg);
      const c = this.get(id);
      return (await c.removeSource?.(sourceId)) ?? c.info();
    });
    handle(IPC.connectorsSetSourceFields, async (e, arg) => {
      check(e);
      const { id, sourceId, fields } = sourceFieldsSchema.parse(arg);
      const c = this.get(id);
      return (await c.setSourceFields?.(sourceId, fields)) ?? c.info();
    });
    handle(IPC.connectorsLoadSourceColumns, async (e, arg) => {
      check(e);
      const { id, sourceId } = sourceRefSchema.parse(arg);
      const c = this.get(id);
      return (await c.loadSourceColumns?.(sourceId)) ?? c.info();
    });
    // Jira: connectors without them answer their card unchanged / nothing.
    handle(IPC.connectorsSetSourceScope, async (e, arg) => {
      check(e);
      const { id, sourceId, everyone } = sourceScopeSchema.parse(arg);
      const c = this.get(id);
      return (await c.setSourceScope?.(sourceId, everyone)) ?? c.info();
    });
    handle(IPC.connectorsListFilters, async (e, arg): Promise<FilterPick[]> => {
      check(e);
      return (await this.get(connectorRefSchema.parse(arg).id).listFilters?.()) ?? [];
    });
    handle(IPC.connectorsSetFilter, async (e, arg) => {
      check(e);
      const { id, filterId } = filterSetSchema.parse(arg);
      const c = this.get(id);
      return (await c.setFilter?.(filterId)) ?? c.info();
    });
    // The token is parsed here and handed to the connector; it is never logged, never echoed back (the card is).
    handle(IPC.connectorsConnectToken, (e, arg) => {
      check(e);
      const { id, user, secret, site } = tokenConnectSchema.parse(arg);
      const c = this.get(id);
      c.connectWithToken?.({ user, secret, ...(site !== undefined ? { site } : {}) }, e.sender.id);
      return c.info();
    });
    handle(IPC.tasksList, (e, arg): TaskList[] => {
      check(e);
      noArgsSchema.parse(arg);
      return this.connectors.map((c) => c.taskList());
    });
    handle(IPC.tasksGet, (e, arg) => {
      check(e);
      const { source, id } = taskRefSchema.parse(arg);
      return this.get(source).task(id);
    });
    handle(IPC.tasksSearch, (e, arg) => {
      check(e);
      const { source, query } = taskSearchSchema.parse(arg);
      return this.get(source).search(query);
    });
    handle(IPC.connectorsOpenTask, async (e, arg) => {
      check(e);
      const { source, id } = taskRefSchema.parse(arg);
      const c = this.get(source);
      const inApp = c.appUrl(id);
      if (inApp && await openApp(inApp, source)) return true;
      const url = c.taskUrl(id);
      return url ? openUrl(url) : false;
    });
  }
}
