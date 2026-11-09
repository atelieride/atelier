// The interface every connector implements. The registry (registry.ts) lists them, broadcasts
// their state and routes the IPC; each connector owns its auth, network, cache and timers, in main only.
import type {
  AddSourceResult, ConnectorId, ConnectorInfo, ConnectorNotice, ConnectorOptions, FilterPick, NotionFields, SourcePick, TaskGetResult, TaskList, TaskSummary
} from '@shared/tasks';

export interface Connector {
  readonly id: ConnectorId;
  /** Reads the saved connection (launch). */
  init(): void;
  info(): ConnectorInfo;
  /**
   * Starts the sign-in (`origin`: the window that asked, brought forward on success). While one runs, a Connect from
   * any window focuses it: its page opens again; there is never a second flow.
   */
  connect(origin?: number): void;
  cancel(): void;
  /** "Open the page again": main reopens the authorize page it holds (the renderer never sees its URL). */
  reopenAuth(): void;
  disconnect(): void;
  /** Refresh / Retry. Retry on `unavailable` with no usable saved token signs in again (Connect from `origin`). */
  refresh(origin?: number): void;
  setOptions(patch: Partial<Pick<ConnectorOptions, 'includeClosed'>>): void;
  /** The cached tasks (refreshed in the background when stale). Never blocks. */
  taskList(): TaskList;
  task(id: string): Promise<TaskGetResult>;
  search(query: string): Promise<TaskSummary[]>;
  /** The web page of a task, held by main: the URL the source gave, or one built from a valid id; null otherwise. */
  taskUrl(id: string): string | null;
  /** The task in the source's desktop app (built from a valid id by main), or null when it has none. */
  appUrl(id: string): string | null;
  /**
   * Connectors with chosen sources (Notion's databases) implement these; the registry answers `unsupported` / `[]` /
   * the unchanged card for the others. `ref`: a pick's id or a pasted link.
   */
  searchSources?(query: string): Promise<SourcePick[]>;
  addSource?(ref: string): Promise<AddSourceResult>;
  removeSource?(sourceId: string): Promise<ConnectorInfo>;
  setSourceFields?(sourceId: string, fields: NotionFields): Promise<ConnectorInfo>;
  /** The fields editor opened: reads the source's schema (columns) now. */
  loadSourceColumns?(sourceId: string): Promise<ConnectorInfo>;
  /** Jira: a project's "Mine | Everyone", the user's saved filters, the one chosen. */
  setSourceScope?(sourceId: string, everyone: boolean): Promise<ConnectorInfo>;
  listFilters?(): Promise<FilterPick[]>;
  setFilter?(filterId: string | null): Promise<ConnectorInfo>;
  /** The API-token sign-in; a connector that doesn't offer it ignores it. */
  connectWithToken?(creds: { user: string; secret: string; site?: string }, origin?: number): void;
  /** A window gained focus. */
  windowFocused(): void;
  /** Quit: stops every flow and timer, stores nothing. */
  dispose(): void;
}

/** What a connector reports to the registry. */
export interface ConnectorEvents {
  onChange(): void;
  onNotice(notice: ConnectorNotice, origin?: number): void;
}
