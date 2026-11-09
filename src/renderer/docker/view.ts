// Docker view, renderer side: what the sidebar and the tab show, as pure functions —
// visibility, formats, state lines, the merged stack, log filters, and the prompts sent to Claude.
import { dotOf, isSecretKey, isStopExit, maskedText, type DockerContainer, type DockerDetail, type EngineState } from '@shared/docker';
import { isFrame, lineLevel, type DockerLevel, type DockerLogLine } from '@shared/docker-logs';
import { stripAnsi } from '@shared/logline';
import { redactSecrets } from '@shared/session';
import type { ShowDocker } from '@shared/settings';
import { isBelow } from '@shared/paths';

/** The activity bar shows Docker: Always, Never, or Auto when an engine is there (even stopped). */
export function dockerShown(show: ShowDocker, engine: EngineState['state']): boolean {
  return show === 'always' || (show === 'auto' && engine !== 'absent');
}

const num = (v: number) => (v < 10 ? String(Math.round(v * 10) / 10) : String(Math.round(v)));

export function fmtBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  // Gigabytes keep a decimal (11.5 GB of images says more than 12); smaller units only under 10.
  return `${i >= 2 ? String(Math.round(v * 10) / 10) : num(v)} ${units[i]}`;
}

export const fmtRate = (bytesPerSecond: number): string => `${fmtBytes(bytesPerSecond)}/s`;

export function fmtUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

function ago(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return h === 1 ? '1 hour ago' : `${h} hours ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? '1 day ago' : `${d} days ago`;
}

function agoShort(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

/** A path under a macOS home as ~/… (the renderer doesn't know the home folder: /Users/<name> is it). */
export function tildePath(p: string): string {
  const m = /^\/Users\/[^/]+(\/.*)?$/.exec(p);
  return m ? `~${m[1] ?? ''}` : p;
}

/** No registry host, no `library/`; a bare digest cut short. */
export function shortImage(image: string): string {
  if (image.startsWith('sha256:')) return image.slice(0, 'sha256:'.length + 12);
  const parts = image.split('/');
  if (parts.length > 1 && (parts[0]!.includes('.') || parts[0]!.includes(':') || parts[0] === 'localhost')) parts.shift();
  if (parts[0] === 'library' && parts.length > 1) parts.shift();
  return parts.join('/');
}

const stoppedBy = (c: DockerContainer) => isStopExit(c.exitCode) && !c.oomKilled;

/** The header's state chip: "Healthy · up 3h 12m", "Exited (1) · 2 min ago", "Stopped · 3 days ago"… */
export function stateText(c: DockerContainer, now: number): string {
  const up = c.startedAt ? ` · up ${fmtUptime(now - c.startedAt)}` : '';
  const since = c.finishedAt ? ` · ${ago(now - c.finishedAt)}` : '';
  switch (c.state) {
    case 'running': return `${c.health === 'healthy' ? 'Healthy' : c.health === 'unhealthy' ? 'Unhealthy' : c.health === 'starting' ? 'Starting' : 'Running'}${up}`;
    case 'restarting': return 'Restarting';
    case 'paused': return 'Paused';
    case 'created': return 'Created';
    case 'dead': return 'Dead';
    case 'exited': return `${c.oomKilled ? 'Out of memory' : stoppedBy(c) ? 'Stopped' : `Exited (${c.exitCode ?? '?'})`}${since}`;
  }
}

/** The sidebar row's second line: image and first port, or how long ago it stopped. */
export function subline(c: DockerContainer, now: number): string {
  if (c.state === 'exited' || c.state === 'dead') {
    const when = c.finishedAt ? ` · ${agoShort(now - c.finishedAt)}` : '';
    return `${stoppedBy(c) && c.state === 'exited' ? 'stopped' : `exited (${c.exitCode ?? '?'})`}${when}`;
  }
  const port = c.ports[0];
  return port ? `${shortImage(c.image)} · :${port.host}` : shortImage(c.image);
}

export const hasProblem = (c: DockerContainer): boolean => dotOf(c) === 'err';

/**
 * Published ports for a terminal's header: only a terminal running docker (an attached `docker compose up`,
 * `docker compose logs -f`) in a compose project's folder gets them — the engine's VM owns them, no terminal's process
 * tree does.
 */
export function terminalPorts(term: { foreground: string; cwd: string }, containers: readonly DockerContainer[], project?: { root: string; realRoot: string }): { name: string; port: number }[] {
  const cmd = term.foreground.split('/').at(-1) ?? '';
  if (cmd !== 'docker' && cmd !== 'docker-compose') return [];
  // The terminal may report the real path of a folder compose saw through a symlink (/private/var vs /var).
  const canon = (p: string) => {
    const q = p.replace(/\/+$/, '');
    return project && project.realRoot !== project.root && (q === project.realRoot || isBelow(project.realRoot, q)) ? project.root + q.slice(project.realRoot.length) : q;
  };
  const cwd = canon(term.cwd);
  return containers.filter((c) => c.state === 'running' && c.workingDir !== null && canon(c.workingDir) === cwd)
    .flatMap((c) => c.ports.filter((p) => p.proto === 'tcp').map((p) => ({ name: c.name, port: p.host })))
    .sort((a, b) => a.port - b.port);
}

export interface StackLine extends DockerLogLine { svc: string; key: string; /** The container's id. */ cid: string }

/** Each container's tag in a stack: its service, or service-N when replicas share it (`--scale worker=3`). */
export function stackLabels(containers: readonly DockerContainer[]): Record<string, string> {
  const count = new Map<string, number>();
  for (const c of containers) count.set(c.name, (count.get(c.name) ?? 0) + 1);
  return Object.fromEntries(containers.map((c) => [c.id, (count.get(c.name) ?? 0) > 1 ? `${c.name}-${/-(\d+)$/.exec(c.containerName)?.[1] ?? c.id.slice(0, 4)}` : c.name]));
}

/** Several containers' lines in time order, each tagged with its service; a line without a time follows its own. */
export function mergeStack(streams: { id: string; name: string; lines: readonly DockerLogLine[] }[]): StackLine[] {
  const out: StackLine[] = [];
  const idx = streams.map(() => 0);
  const lastAt = streams.map(() => 0);
  const atOf = (si: number) => {
    const l = streams[si]!.lines[idx[si]!];
    return l ? l.at ?? lastAt[si]! : Infinity;
  };
  for (;;) {
    let best = -1;
    let bestAt = Infinity;
    for (let si = 0; si < streams.length; si++) { const a = atOf(si); if (a < bestAt) { bestAt = a; best = si; } }
    if (best < 0) return out;
    const s = streams[best]!;
    const l = s.lines[idx[best]!]!;
    idx[best]!++;
    if (l.at !== null) lastAt[best] = l.at;
    out.push({ ...l, svc: s.name, cid: s.id, key: `${s.id}:${l.seq}` });
  }
}

export type LevelFilter = 'all' | 'warn' | 'err';
// A line's level, once per text: filters and counts run over thousands of lines on every flush.
const levels = new Map<string, DockerLevel>();
export function levelOf(l: DockerLogLine): DockerLevel {
  let v = levels.get(l.text);
  if (v === undefined) {
    v = lineLevel(l.text, l.err ? 'err' : 'out');
    if (levels.size > 50_000) levels.clear();
    levels.set(l.text, v);
  }
  return v;
}
const lvl = levelOf;

export function levelCounts(lines: readonly DockerLogLine[]): { warn: number; err: number } {
  let warn = 0; let err = 0;
  for (const l of lines) {
    if (isFrame(l.text)) continue;
    const v = lvl(l);
    if (v === 'warn') warn++; else if (v === 'error') err++;
  }
  return { warn, err };
}

function matcher(query: string): ((text: string) => boolean) | null {
  const q = query.trim();
  if (!q) return null;
  const re = /^\/(.+)\/$/.exec(q);
  if (re) { try { const r = new RegExp(re[1]!, 'i'); return (t) => r.test(t); } catch { /* plain text below */ } }
  const lower = q.toLowerCase();
  return (t) => t.toLowerCase().includes(lower);
}

/** By level (an error keeps its stack frames) and by text or /regex/. */
export function filterLines<T extends DockerLogLine>(lines: readonly T[], level: LevelFilter, query: string): T[] {
  const match = matcher(query);
  const out: T[] = [];
  let kept = false;
  for (const l of lines) {
    const text = stripAnsi(l.text);
    if (isFrame(text)) {
      if (kept && (level !== 'all' || !match || match(text))) out.push(l);
      continue;
    }
    const v = lvl(l);
    // Each filter shows what its count counts: Warnings are warnings only, errors have their own filter.
    const levelOk = level === 'all' || (level === 'err' ? v === 'error' : v === 'warn');
    kept = levelOk && (!match || match(text));
    if (kept) out.push(l);
  }
  return out;
}

export const SVC_COLORS = 6;
/** A service's color in a stack: its place among the stack's names, sorted (stable as lines come and go). */
export function svcColor(name: string, names: readonly string[]): number {
  const i = [...names].sort().indexOf(name);
  return i < 0 ? 0 : i % SVC_COLORS;
}

function describe(c: DockerContainer): string {
  const compose = c.service ? `compose service \`${c.service}\` of project \`${c.project}\`, ` : '';
  return `Docker container \`${c.name}\` (${compose}image \`${c.image}\`)`;
}
const fence = (lines: readonly string[], lang = '') => `\`\`\`${lang}\n${lines.join('\n')}\n\`\`\``;
const clean = (t: string) => redactSecrets(stripAnsi(t));

/** Selected log lines for a session: where they come from, then the lines (redacted). */
export function logsPrompt(c: DockerContainer, lines: readonly string[], ask = false): string {
  const body = `Lines from the logs of the ${describe(c)}:\n\n${fence(lines.map(clean))}`;
  return ask ? `${body}\n\nWhat is going on here?` : body;
}

const COMPOSE_KV = /^(\s*-?\s*["']?)([A-Za-z_][A-Za-z0-9_.-]*)(["']?\s*(?::\s+|=))(.+)$/;

/** A compose service block with its secrets masked: values under secret keys, URL passwords, token-like runs. */
export function maskCompose(block: string): string {
  return block.split('\n').map((line) => {
    const m = COMPOSE_KV.exec(line);
    if (!m) return redactSecrets(line);
    const [, lead, key, sep, value] = m;
    return `${lead}${key}${sep}${redactSecrets(isSecretKey(key!) ? '••••••••' : maskedText(key!, value!))}`;
  }).join('\n');
}

/** "Ask Claude Why It Crashed": the state, the env (secrets masked), the compose service, the last lines. */
export function crashPrompt(c: DockerContainer, d: Pick<DockerDetail, 'env' | 'restartPolicy' | 'error'>, lines: readonly string[], composeBlock: string | null): string {
  const policy = `${d.restartPolicy.name}${d.restartPolicy.max ? `:${d.restartPolicy.max}` : ''}`;
  const restarts = c.restarts ? ` after ${c.restarts} restart${c.restarts === 1 ? '' : 's'}` : '';
  const what = c.oomKilled ? `It was killed for running out of memory${restarts}`
    : c.state === 'running' && c.health === 'unhealthy' ? 'Its health check is failing'
      : `It exited with code ${c.exitCode ?? '?'}${restarts}`;
  const parts = [`The ${describe(c)} stopped working. ${what} (restart policy ${policy}).`];
  if (d.error) parts.push(`Docker says: ${clean(d.error)}`);
  if (d.env.length) parts.push(`Its environment (secrets masked):\n\n${fence(d.env.map((e) => `${e.key}=${redactSecrets(maskedText(e.key, e.value))}`))}`);
  if (composeBlock) parts.push(`Its compose service:\n\n${fence(maskCompose(composeBlock).split('\n'), 'yaml')}`);
  if (lines.length) parts.push(`Its last log lines:\n\n${fence(lines.map(clean))}`);
  parts.push('Why did it stop, and how do I fix it?');
  return parts.join('\n\n');
}
