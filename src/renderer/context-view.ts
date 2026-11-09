// Context usage's view model: what the sheet shows from a report, pure.
import { GROUP_ORDER, type ContextGroupId, type ContextReport } from '@shared/context-usage';
import { tc } from './i18n/context';

/** Tokens as Claude Code writes them: 450, 8k, 19.4k, 860.2k, 1M. */
export function formatTokens(n: number): string {
  const one = (x: number) => x.toFixed(1).replace(/\.0$/, '');
  if (n < 1_000) return String(Math.round(n));
  if (n < 999_950) return `${one(n / 1_000)}k`;
  return `${one(n / 1_000_000)}M`;
}

/** A share of the window: one decimal, `<0.1%` for a sliver, `0%` for nothing. */
export function formatShare(n: number, max: number): string {
  if (max <= 0 || n <= 0) return '0%';
  const pct = (n / max) * 100;
  return pct < 0.05 ? '<0.1%' : `${pct.toFixed(1).replace(/\.0$/, '')}%`;
}

/** What the conversation added since the analysis: the transcript's input now minus the one it saw; never negative. */
export function sinceAnalyzed(r: ContextReport, live: number | null): number {
  return live === null || r.apiTotal === null ? 0 : Math.max(0, live - r.apiTotal);
}

/**
 * The Conversation tile's note: what came since the analysis; a compaction since (the transcript's input fell:
 * the numbers are stale until Refresh); a conversation the copy couldn't read although the session has messages.
 */
export function conversationNote(r: ContextReport, live: number | null, hasMessages: boolean): { kind: 'since' | 'compacted' | 'missing' | 'none'; text: string } {
  if (!r.resumed && hasMessages) return { kind: 'missing', text: tc.tiles.missing };
  if (live !== null && r.apiTotal !== null && live < r.apiTotal) return { kind: 'compacted', text: tc.tiles.compacted };
  const since = sinceAnalyzed(r, live);
  return since > 0 ? { kind: 'since', text: tc.tiles.conversationSub(formatTokens(since)) } : { kind: 'none', text: tc.tiles.conversationNone };
}

/** The whole-window bar's sentence for a screen reader: the buffer only when auto-compact keeps one. */
export function windowLabel(r: ContextReport, since: number): string {
  const used = formatTokens(r.total + since);
  const max = formatTokens(r.max);
  return r.buffer > 0 ? tc.window(used, max, formatTokens(r.buffer)) : tc.windowNoCompact(used, max);
}

export interface RankedGroup { id: ContextGroupId; name: string; tokens: number }

/** The five groups, largest first; Messages with what came since. */
export function rankedGroups(r: ContextReport, since: number): RankedGroup[] {
  return GROUP_ORDER.map((id) => ({ id, name: tc.groups[id], tokens: r.groups[id] + (id === 'messages' ? since : 0) }))
    .sort((a, b) => b.tokens - a.tokens);
}

export function tiles(r: ContextReport, since: number) {
  const inUse = r.total + since;
  return {
    inUse,
    share: formatShare(inUse, r.max),
    before: r.total - r.groups.messages,
    conversation: r.groups.messages + since,
    since,
    untilCompact: r.autoCompactAt === null ? null : Math.max(0, r.autoCompactAt - inUse),
    compactAt: r.autoCompactAt,
    // Claude Code's own free space (the auto-compact buffer left out), less what came since.
    free: Math.max(0, r.free - since)
  };
}

export type ArcId = ContextGroupId | 'since';

/** Each group's share of the whole window in the donut's order, since right after Messages; the buffer apart. */
export function windowBar(r: ContextReport, since: number): { segments: { id: ArcId; pct: number }[]; bufferPct: number } {
  const pct = (n: number) => (r.max > 0 ? (n / r.max) * 100 : 0);
  const segments: { id: ArcId; pct: number }[] = [];
  for (const id of GROUP_ORDER) {
    segments.push({ id, pct: pct(r.groups[id]) });
    if (id === 'messages' && since > 0) segments.push({ id: 'since', pct: pct(since) });
  }
  return { segments: segments.filter((s) => s.pct > 0), bufferPct: pct(r.buffer) };
}

/**
 * The donut's arcs over a circle of `C` (stroke-dasharray lengths): what is in use, in the fixed order, since after
 * Messages; each arc `gap` shorter (never under a hair), offsets negative (SVG dash offsets run backwards).
 */
export function donutArcs(r: ContextReport, since: number, C: number, gap: number): { id: ArcId; len: number; offset: number }[] {
  const parts: { id: ArcId; tokens: number }[] = [];
  for (const id of GROUP_ORDER) {
    parts.push({ id, tokens: r.groups[id] });
    if (id === 'messages' && since > 0) parts.push({ id: 'since', tokens: since });
  }
  const used = parts.reduce((n, p) => n + p.tokens, 0);
  if (used <= 0) return [];
  const out: { id: ArcId; len: number; offset: number }[] = [];
  let at = 0;
  for (const p of parts) {
    if (p.tokens <= 0) continue;
    const len = (p.tokens / used) * C;
    out.push({ id: p.id, len: Math.max(len - gap, 0.5), offset: at === 0 ? 0 : -at });
    at += len;
  }
  return out;
}

export interface DetailRow {
  name: string;
  tokens: number;
  /** Width of its bar, % of the group's largest row. */
  bar: number;
  chip?: string;
  sub?: boolean;
  mono?: boolean;
  muted?: boolean;
  hatch?: boolean;
  live?: boolean;
  /** A file the view may open (main checks it against the report). */
  open?: string;
}

export interface ServerRow {
  key: string;
  name: string;
  scope: string | null;
  inContext: string;
  bar: number;
  loadedLabel: string;
  deferred: string;
  instructions: string;
  tools: { name: string; tokens: string }[];
  waiting: string | null;
  config: { path: string; shown: string } | null;
  /** Where to change it when no file can be opened (claude.ai connectors). */
  where: string | null;
  /** The row as one sentence for a screen reader (its columns have no labels of their own). */
  label: string;
}

export interface GroupDetail {
  id: ContextGroupId;
  title: string;
  tokens: number;
  sub: string;
  hint: string;
  rows?: DetailRow[];
  servers?: ServerRow[];
  offline?: { label: string; names: string } | null;
  /** Servers still connecting when the copy was asked: not counted (the live session may have them). */
  pending?: { label: string; names: string } | null;
  compact?: boolean;
}

/** Bars relative to the largest row that has one. */
function withBars(rows: Omit<DetailRow, 'bar'>[]): DetailRow[] {
  const top = Math.max(1, ...rows.filter((r) => !r.muted).map((r) => r.tokens));
  return rows.map((r) => ({ ...r, bar: r.muted ? 0 : Math.round((r.tokens / top) * 1000) / 10 }));
}

export function groupDetail(r: ContextReport, id: ContextGroupId, since: number): GroupDetail {
  const c = tc;
  const base = { id, title: c.groups[id], tokens: r.groups[id] + (id === 'messages' ? since : 0), hint: c.hints[id] };
  switch (id) {
    case 'mcp': {
      const top = Math.max(1, ...r.servers.map((s) => s.inContext));
      const servers: ServerRow[] = r.servers.map((s) => ({
        key: s.key,
        name: s.name,
        scope: s.scope === null ? null : c.scopes[s.scope] ?? s.scope,
        inContext: formatTokens(s.inContext),
        bar: Math.max(Math.round((s.inContext / top) * 1000) / 10, 0),
        loadedLabel: `${s.loaded.length} / ${s.loaded.length + s.deferredCount}`,
        deferred: formatTokens(s.deferredTokens),
        instructions: formatTokens(s.instructions),
        tools: s.loaded.map((x) => ({ name: x.name, tokens: formatTokens(x.tokens) })),
        waiting: s.deferredCount > 0 ? c.waiting(s.deferredCount) : null,
        config: s.configFile ? { path: s.configFile, shown: s.configShown ?? s.configFile } : null,
        where: s.scope === 'claudeai' ? c.connectors : null,
        label: c.serverLabel(s.name, s.scope === null ? null : c.scopes[s.scope] ?? s.scope, formatTokens(s.inContext), s.loaded.length, s.loaded.length + s.deferredCount, formatTokens(s.deferredTokens))
      }));
      const down = r.offline.filter((o) => o.status !== 'pending');
      const slow = r.offline.filter((o) => o.status === 'pending');
      const offline = down.length ? { label: c.offline(down.length), names: down.map((o) => `${o.name} (${o.status})`).join(', ') } : null;
      const pending = slow.length ? { label: c.pending(slow.length), names: slow.map((o) => o.name).join(', ') } : null;
      return { ...base, sub: c.subs.mcp(formatTokens(r.deferred.mcp)), servers, offline, pending };
    }
    case 'messages': {
      const m = r.messages;
      const rows: Omit<DetailRow, 'bar'>[] = [{ name: c.rows.tools, tokens: m.toolsTotal }];
      for (const x of m.tools) rows.push({ name: x.name, tokens: x.tokens, sub: true, mono: true });
      if (m.otherTools > 0) rows.push({ name: c.rows.otherTools, tokens: m.otherTools, sub: true });
      rows.push({ name: c.rows.user, tokens: m.user }, { name: c.rows.assistant, tokens: m.assistant }, { name: c.rows.attachments, tokens: m.attachments });
      if (m.other > 0) rows.push({ name: c.rows.other, tokens: m.other });
      if (since > 0) rows.push({ name: c.rows.since, tokens: since, hatch: true, live: true, chip: c.rows.live });
      return { ...base, sub: c.subs.messages, rows: withBars(rows), compact: true };
    }
    case 'memory':
      return {
        ...base,
        sub: c.subs.memory(r.memory.length),
        rows: withBars(r.memory.map((x) => ({ name: x.shown, tokens: x.tokens, chip: c.memoryTypes[x.type] ?? x.type, mono: true, open: x.path })))
      };
    case 'skills': {
      const skills = r.skills.filter((s) => s.kind === 'skill').reduce((n, s) => n + s.count, 0);
      const agents = r.skills.filter((s) => s.kind === 'agent').reduce((n, s) => n + s.count, 0);
      return {
        ...base,
        sub: c.subs.skills(skills, agents),
        rows: withBars(r.skills.map((s) => ({
          name: s.plugin ?? (s.kind === 'agent' && s.source === 'user' ? c.agentsOfUser : c.sources[s.source] ?? s.source),
          tokens: s.tokens,
          chip: s.kind === 'agent' ? c.agentsChip(s.count) : s.plugin ? c.pluginChip(s.count) : c.skillsChip(s.count)
        })))
      };
    }
    case 'system': {
      const rows: Omit<DetailRow, 'bar'>[] = r.system.map((x) => ({ name: x.name, tokens: x.tokens }));
      if (r.deferred.system > 0) rows.push({ name: c.rows.deferredSystem, tokens: r.deferred.system, muted: true, chip: c.rows.notInContext });
      return { ...base, sub: c.subs.system, rows: withBars(rows) };
    }
  }
}
