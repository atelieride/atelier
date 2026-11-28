// What fills a Claude session's context, as a phone gets it: the report Atelier's Context Usage sheet shows, cut down
// to names and token counts. Never a path (a memory file is named by its file name), a server's config file or key,
// or the tools a server loaded (only how many); the tools Claude called are named as its conversation shows them.
// Each list keeps its largest rows.
import type { ContextReport } from '@shared/context-usage';
import type { RemoteContextReport } from './messages';

/** Rows per list at most, and characters per name. */
const MAX_ROWS = 40;
const MAX_NAME = 120;

const cut = (s: string): string => [...s].slice(0, MAX_NAME).join('');
const largest = <T extends { tokens: number }>(rows: readonly T[]): T[] => [...rows].sort((a, b) => b.tokens - a.tokens).slice(0, MAX_ROWS);
/** A file's name, whichever separator its path uses. */
const fileName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? '';

export function phoneContextReport(r: ContextReport): RemoteContextReport {
  return {
    at: r.at,
    ...(r.model !== null ? { model: cut(r.model) } : {}),
    total: r.total,
    max: r.max,
    ...(r.autoCompactAt !== null ? { autoCompactAt: r.autoCompactAt } : {}),
    buffer: r.buffer,
    free: r.free,
    resumed: r.resumed,
    groups: { ...r.groups },
    // The System group's parts, largest first as the report has them, only their names cut.
    system: r.system.slice(0, MAX_ROWS).map((s) => ({ name: cut(s.name), tokens: s.tokens })),
    deferred: { ...r.deferred },
    servers: [...r.servers].sort((a, b) => b.inContext - a.inContext).slice(0, MAX_ROWS).map((s) => ({
      name: cut(s.name),
      ...(s.scope !== null ? { scope: cut(s.scope) } : {}),
      inContext: s.inContext,
      loaded: s.loaded.length,
      deferred: s.deferredCount,
      deferredTokens: s.deferredTokens
    })),
    offline: r.offline.length,
    memory: largest(r.memory).map((m) => ({ name: cut(fileName(m.path)), type: cut(m.type), tokens: m.tokens })),
    skills: largest(r.skills).map((s) => ({
      kind: s.kind,
      source: cut(s.source),
      ...(s.plugin !== null ? { plugin: cut(s.plugin) } : {}),
      count: s.count,
      tokens: s.tokens
    })),
    messages: {
      tools: largest(r.messages.tools).map((t) => ({ name: cut(t.name), tokens: t.tokens })),
      otherTools: r.messages.otherTools,
      toolsTotal: r.messages.toolsTotal,
      user: r.messages.user,
      assistant: r.messages.assistant,
      attachments: r.messages.attachments,
      other: r.messages.other
    }
  };
}
