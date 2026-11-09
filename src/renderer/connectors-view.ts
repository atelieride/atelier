// What Settings › Connectors (its list rows and details pages), the palette, the gear dot and the toasts show for each
// connector. Main sends a status and reason codes (ConnectorInfo); the
// words come from i18n/en.ts. Pure: tested alone.
import type { ConnectorId, ConnectorInfo, ConnectorNotice, ConnectorReason } from '@shared/tasks';
import { t } from './i18n/en';
import { checkedAgo } from './update-view';
import type { IconName } from './components/Icon';
import { isMod, isOtherMod } from '@shared/keys';

/** A connector's name before main has listed it (a notice can arrive first). */
export const CONNECTOR_NAMES: Readonly<Record<ConnectorId, string>> = { clickup: 'ClickUp', notion: 'Notion', jira: 'Jira' };
/** Each connector's glyph (components/Icon.tsx). */
export const CONNECTOR_ICONS: Readonly<Record<ConnectorId, IconName>> = { clickup: 'clickup', notion: 'notion', jira: 'jira' };

/** `setup`: connected, but nothing to show until the user chooses sources (Notion without a database). */
export type ConnectorTone = 'idle' | 'busy' | 'ok' | 'setup' | 'warn' | 'err';
export type ConnectorActionId = 'connect' | 'cancel' | 'reopen' | 'disconnect' | 'refresh' | 'retry' | 'reconnect';

export interface ConnectorAction {
  id: ConnectorActionId;
  label: string;
  /** Bold in the table: the one thing to do now. */
  primary: boolean;
  /** Takes something away (Disconnect): asks first and reads as such. */
  danger?: boolean;
}

export interface ConnectorView {
  tone: ConnectorTone;
  /** The status line. */
  line: string;
  /** While connecting: m:ss left. */
  countdown?: string;
  /** A quieter second line: when the tasks were fetched, or why the last attempt failed. */
  sub?: string;
  subTone?: 'muted' | 'warn' | 'err';
  actions: ConnectorAction[];
}

/** m:ss until `until`, rounded up (the wait starts at 5:00 and ends at 0:00). */
export function countdown(until: number, now: number): string {
  const s = Math.max(0, Math.ceil((until - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/** "10:42" (24 h); another day: "Oct 10, 23:07". */
export function clockTime(at: number, now: number): string {
  const d = new Date(at);
  const n = new Date(now);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === n.toDateString() ? time : `${MONTHS[d.getMonth()]} ${d.getDate()}, ${time}`;
}

/** "2 min ago", "just now", "yesterday". */
export function agoLower(at: number, now: number): string {
  const ago = checkedAgo(at, now);
  return ago.charAt(0).toLowerCase() + ago.slice(1);
}

/** "Updated 2 min ago", "Updated just now", "Updated yesterday". */
function updatedAgo(at: number, now: number): string {
  return t.conn.updated(agoLower(at, now));
}

/** The copy of a reason code (also the toasts' words). */
export function reasonText(name: string, reason: ConnectorReason, detail?: string): string {
  const r = t.conn.reasons;
  switch (reason) {
    case 'timeout': return r.timeout(name);
    case 'denied': return r.denied(name);
    case 'oauth-error': return detail ? r.oauthError(name, detail) : r.oauthErrorBare(name);
    case 'verify-failed': return r.verifyFailed(name);
    case 'port-failed': return detail ? r.portFailed(detail) : r.portFailedBare;
    case 'network': return r.network(name);
    case 'keychain-unavailable': return r.keychain;
    case 'fetch-failed': return r.fetchFailed(name);
    case 'auth-unsupported': return r.authUnsupported(name);
    case 'connector-changed': return r.connectorChanged(name);
    case 'workspace-gone': return r.workspaceGone(name);
    case 'signed-out': return r.signedOut(name);
    case 'unreadable': return r.unreadable(name);
    case 'slowing-down': return r.slowingDown;
    case 'token-refused': return r.tokenRefused(name);
    case 'token-expired': return r.tokenExpired(name);
    case 'token-site': return r.tokenSite;
    case 'token-scopes': return r.tokenScopes;
    case 'no-site': return r.noSite;
  }
}

const UNAVAILABLE_REASONS: readonly ConnectorReason[] = ['auth-unsupported', 'connector-changed', 'workspace-gone', 'no-site'];
const RECONNECT_REASONS: readonly ConnectorReason[] = ['signed-out', 'unreadable', 'token-expired'];

/**
 * Why a `reconnect` card is one: its own reason, else — an attempt's reason replaced it (a Keychain refusal, a timeout…)
 * — what main has saved: a saved connection (it names a workspace) was signed out, nothing saved is the unreadable one.
 */
function reconnectLine(c: ConnectorInfo): string {
  if (c.reason === 'token-expired') return t.conn.reasons.tokenExpired(c.name);
  const unreadable = c.reason === 'unreadable' || (c.reason !== 'signed-out' && c.workspace === undefined);
  return unreadable ? t.conn.reasons.unreadable(c.name) : t.conn.reasons.signedOut(c.name);
}

/** The `unavailable` line: its own reason when known, else the general one. */
function unavailableLine(name: string, reason: ConnectorReason | undefined): string {
  return reason && UNAVAILABLE_REASONS.includes(reason) ? reasonText(name, reason) : t.conn.unavailable(name);
}

const act = (id: ConnectorActionId, primary = false): ConnectorAction => ({
  id, label: t.conn.actions[id], primary, ...(id === 'disconnect' ? { danger: true } : {})
});

/** The Disconnect confirm's last line: how the connector's own access is revoked. */
export function revokeHint(c: Pick<ConnectorInfo, 'id' | 'signIn'>): string {
  // An API token (Jira): nothing to revoke from Atelier; the user deletes the token where they made it.
  if (c.id === 'jira' && c.signIn === 'token') return t.conn.jira.revokeToken;
  return t.conn.revokeHint[c.id];
}

/** A connector with chosen sources (Notion's databases, Jira's projects) and none chosen yet: nothing to list. */
export function noneChosen(c: Pick<ConnectorInfo, 'sources' | 'projects'>): boolean {
  return (c.sources ?? c.projects)?.length === 0;
}

/** The Workspace row's value: the name, or "—" when none is known (not connected, or no name and no spaces). */
export function workspaceValue(c: ConnectorInfo): string {
  return c.workspace || '—';
}

export function connectorView(c: ConnectorInfo, now: number): ConnectorView {
  const name = c.name;
  // A reason that isn't the status's own: what the last Connect / Reconnect / Retry ran into (it can outlive the attempt,
  // e.g. a Keychain refusal leaves the status as it was). It goes on the second line, never over the status line.
  const attempt = (own: readonly ConnectorReason[]) => c.reason && !own.includes(c.reason) && c.reason !== 'slowing-down'
    ? { sub: reasonText(name, c.reason, c.detail), subTone: 'err' as const } : {};
  switch (c.status) {
    case 'disconnected':
      return { tone: 'idle', line: t.conn.notConnected, ...attempt([]), actions: [act('connect', true)] };
    case 'connecting':
      return { tone: 'busy', line: t.conn.waiting, ...(c.connectingUntil ? { countdown: countdown(c.connectingUntil, now) } : {}), actions: [act('cancel', true), act('reopen')] };
    case 'connected': {
      const line = c.account ? (c.workspace ? t.conn.connectedAs(c.account, c.workspace) : t.conn.connectedAsOnly(c.account))
        : c.workspace ? t.conn.connectedTo(c.workspace) : t.conn.connected;
      // No source chosen yet: violet, what to do next, and nothing to refresh.
      if (c.sources && c.sources.length === 0) return { tone: 'setup', line, sub: t.conn.chooseWhere, subTone: 'muted', actions: [act('disconnect', true)] };
      const sub = c.reason === 'slowing-down' ? { sub: t.conn.reasons.slowingDown, subTone: 'warn' as const }
        : c.loading ? { sub: t.conn.refreshing, subTone: 'muted' as const }
          : c.updatedAt !== undefined ? { sub: updatedAgo(c.updatedAt, now), subTone: 'muted' as const } : {};
      return { tone: 'ok', line, ...sub, actions: [act('disconnect', true), act('refresh')] };
    }
    case 'offline':
      return {
        tone: 'warn', line: c.updatedAt !== undefined ? t.conn.offline(name, clockTime(c.updatedAt, now)) : t.conn.offlineNoTasks(name),
        ...(c.loading ? { sub: t.conn.refreshing, subTone: 'muted' as const } : {}), actions: [act('retry'), act('disconnect')]
      };
    case 'reconnect':
      return {
        tone: 'warn', line: reconnectLine(c),
        ...attempt(RECONNECT_REASONS), actions: [act('reconnect', true), act('disconnect')]
      };
    case 'unavailable':
      return {
        tone: 'err', line: unavailableLine(name, c.reason),
        ...attempt(UNAVAILABLE_REASONS), actions: [act('retry'), act('disconnect')]
      };
  }
}

/** A row's state chip: none while not connected; `setup` is the violet "Choose databases". */
export type RowChip = { tone: 'ok' | 'setup' | 'busy' | 'warn' | 'err'; label: string; countdown?: string } | null;

/** One row of Settings › Connectors' list. */
export interface ConnectorRowView {
  chip: RowChip;
  /** The short description, or the status sentence when there is one. */
  line: string;
  /** The one action that can't wait (Connect, Cancel, Reconnect); everything else is in the details. */
  action?: { id: 'connect' | 'cancel' | 'reconnect'; label: string; /** Its accessible name: with the connector's. */ aria: string; primary: boolean };
}

/** A connected connector with chosen sources (Notion): "2 databases · 7 open tasks · updated 2 min ago". */
function sourcesLine(c: ConnectorInfo, now: number): string {
  const sources = c.sources ?? [];
  const counts = sources.flatMap((s) => (s.count === undefined ? [] : [s.count]));
  return [
    t.conn.databases(sources.length),
    ...(counts.length ? [t.conn.openTasks(counts.reduce((a, b) => a + b, 0))] : []),
    ...(c.updatedAt !== undefined ? [t.conn.updatedLower(agoLower(c.updatedAt, now))] : [])
  ].join(' · ');
}

const rowAction = (c: ConnectorInfo, id: 'connect' | 'cancel' | 'reconnect', primary: boolean): ConnectorRowView['action'] =>
  ({ id, label: t.conn.actions[id], aria: t.conn.rowActions[id](c.name), primary });

export function connectorRow(c: ConnectorInfo, now: number): ConnectorRowView {
  const ch = t.conn.chips;
  switch (c.status) {
    case 'disconnected':
      return { chip: null, line: t.conn.descriptions[c.id] ?? '', action: rowAction(c, 'connect', true) };
    case 'connecting':
      return {
        chip: { tone: 'busy', label: ch.connecting, ...(c.connectingUntil ? { countdown: countdown(c.connectingUntil, now) } : {}) },
        line: t.conn.waiting, action: rowAction(c, 'cancel', false)
      };
    case 'connected': {
      if (c.sources && c.sources.length === 0) return { chip: { tone: 'setup', label: ch.chooseDatabases }, line: t.conn.noSources(c.account) };
      const line = c.sources ? sourcesLine(c, now) : t.conn.descriptions[c.id] ?? '';
      if (c.attention && c.attention > 0) return { chip: { tone: 'warn', label: ch.attention(c.attention) }, line };
      return { chip: { tone: 'ok', label: c.workspace ? t.conn.connectedTo(c.workspace) : t.conn.connected }, line };
    }
    case 'offline':
      return { chip: { tone: 'warn', label: ch.offline }, line: connectorView(c, now).line };
    case 'reconnect':
      return { chip: { tone: 'warn', label: ch.signedOut }, line: reconnectLine(c), action: rowAction(c, 'reconnect', true) };
    case 'unavailable':
      return { chip: { tone: 'err', label: ch.unavailable }, line: unavailableLine(c.name, c.reason) };
  }
}

/** A toast for a notice: its words and the way out, when there is one. */
export function noticeView(n: ConnectorNotice, name: string): { text: string; action?: 'reconnect' | 'retry' | 'details' } {
  switch (n.kind) {
    // The card's own line: signed out or unreadable; connector changed, workspace gone…
    case 'reconnect': return {
      text: n.reason === 'unreadable' ? t.conn.reasons.unreadable(name) : n.reason === 'token-expired' ? t.conn.reasons.tokenExpired(name) : t.conn.reasons.signedOut(name),
      action: 'reconnect'
    };
    case 'unavailable': return { text: unavailableLine(name, n.reason), action: 'details' };
    case 'network': return { text: reasonText(name, 'network'), action: 'retry' };
    case 'fetch-failed': return { text: reasonText(name, 'fetch-failed'), action: 'retry' };
    case 'keychain-unavailable': return { text: reasonText(name, 'keychain-unavailable') };
    default: return { text: reasonText(name, n.kind, n.detail) };
  }
}

export interface ConnectorCommand {
  key: string;
  id: ConnectorId;
  action: 'connect' | 'reconnect' | 'disconnect' | 'refresh';
  label: string;
}

/**
 * Whether the palette offers "Refresh Tasks" for the connector: a saved connection that lists (connected, offline, or
 * unavailable with a workspace) and has something to list (not Notion before a database is chosen).
 */
function refreshable(c: ConnectorInfo): boolean {
  if (noneChosen(c)) return false;
  return c.status === 'connected' || c.status === 'offline' || (c.status === 'unavailable' && c.workspace !== undefined);
}

/**
 * Palette commands, only where they make sense for the connector's status. With two connectors to refresh, each
 * Refresh names its own ("Refresh Notion Tasks"); one alone is just "Refresh Tasks".
 */
export function connectorCommands(list: readonly ConnectorInfo[]): ConnectorCommand[] {
  const out: ConnectorCommand[] = [];
  const add = (c: ConnectorInfo, action: ConnectorCommand['action'], label: string) => out.push({ key: `connector-${action}-${c.id}`, id: c.id, action, label });
  const named = list.filter(refreshable).length > 1;
  const refresh = (c: ConnectorInfo) => { if (refreshable(c)) add(c, 'refresh', named ? t.conn.cmd.refreshOf(c.name, t.tasks.nouns[c.id]) : t.conn.cmd.refresh); };
  for (const c of list) {
    switch (c.status) {
      case 'disconnected': add(c, 'connect', t.conn.cmd.connect(c.name)); break;
      case 'connecting': break;
      case 'reconnect': add(c, 'reconnect', t.conn.cmd.reconnect(c.name)); add(c, 'disconnect', t.conn.cmd.disconnect(c.name)); break;
      // Nothing saved (no workspace): its Retry signs in again in the browser — say so, never "Refresh Tasks".
      case 'unavailable':
        if (c.workspace === undefined) add(c, 'connect', t.conn.cmd.connect(c.name));
        else refresh(c);
        add(c, 'disconnect', t.conn.cmd.disconnect(c.name));
        break;
      default: refresh(c); add(c, 'disconnect', t.conn.cmd.disconnect(c.name)); break;
    }
  }
  return out;
}

/**
 * The quiet amber dot on the activity bar's gear and on Settings › Connectors: a connector that needs you
 * — signed out, unavailable, or with a source it can't read any more (a Notion database, `attention`).
 */
export function needsAttention(list: readonly ConnectorInfo[]): boolean {
  return list.some((c) => c.status === 'reconnect' || c.status === 'unavailable' || (c.attention ?? 0) > 0);
}

/** ⌘[ — a details page's way back to the list (only the plain chord). */
export function isConnectorsBackKey(e: { key: string; metaKey: boolean; shiftKey: boolean; altKey: boolean; ctrlKey: boolean }): boolean {
  // ⌘[ on macOS, Ctrl+[ on Windows (the other modifier never).
  return e.key === '[' && isMod(e) && !e.shiftKey && !e.altKey && !isOtherMod(e);
}

/** The connector whose details the gear dot opens: the first that needs you. */
export function attentionConnector(list: readonly ConnectorInfo[]): ConnectorId | null {
  return list.find((c) => needsAttention([c]))?.id ?? null;
}
