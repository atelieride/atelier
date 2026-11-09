// Ask companion: `facts.md`, what Atelier knows for sure about the session when the question is asked —
// its state and since when, what it waits for, its background work, the files it changed (exact attribution) with
// their times, lines and cost, the git branch. Pure.
import { redactSecrets } from '../session';
import type { LiveFacts } from './live';
import { cutEnd, hhmm, oneLine, ymd } from './text';

const STATE: Record<LiveFacts['state'], string> = {
  working: 'working', waiting: 'waiting for you', idle: 'idle', done: 'done', error: 'stopped on an error', ended: 'ended (no live session)'
};
/** The newest files are listed, at most this many. */
const FILES_MAX = 200;

const pad = (n: number) => String(n).padStart(2, '0');
const one = (s: string, max: number) => cutEnd(oneLine(s), max);
/** Free text (not paths) may carry a token: redacted once on one line (an invisible character never hides one). */
const text = (s: string, max: number) => cutEnd(redactSecrets(oneLine(s.slice(0, 4096))), max);

function duration(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${pad(m % 60)}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function renderFacts(f: { title: string; facts: LiveFacts; waiting: string | null; files: { rel: string; at: number }[]; costUsd: number | null; branch: string | null; now: number }): string {
  const when = (t: number) => (ymd(t) === ymd(f.now) ? hhmm(t) : `${ymd(t)} ${hhmm(t)}`);
  const { facts } = f;
  const since = facts.since !== null ? `, since ${when(facts.since)} (for ${duration(f.now - facts.since)})` : '';
  const lines = [
    `# Atelier's facts about the session "${text(f.title, 120)}" at ${hhmm(f.now)} (${ymd(f.now)})`,
    `- State: ${STATE[facts.state] ?? 'unknown'}${since}`
  ];
  if (f.waiting) lines.push(`- Waiting for: ${text(f.waiting, 300)}`);
  lines.push(
    `- Background: ${facts.work ? text(facts.work, 200) : 'none'}`,
    `- Lines: +${facts.added} −${facts.removed}`,
    `- Cost: ${f.costUsd !== null && Number.isFinite(f.costUsd) ? `$${f.costUsd.toFixed(2)}` : 'unknown'}`,
    `- Branch: ${f.branch ? text(f.branch, 200) : 'unknown'}`
  );
  const files = [...f.files].sort((a, b) => a.at - b.at);
  if (files.length === 0) lines.push('- Files changed: none');
  else {
    lines.push(`- Files changed (${files.length}), oldest first:`);
    const shown = files.slice(-FILES_MAX);
    if (shown.length < files.length) lines.push(`  - … ${files.length - shown.length} earlier files left out`);
    for (const x of shown) lines.push(`  - ${when(x.at)} ${one(x.rel, 400)}`);
  }
  return lines.join('\n') + '\n';
}
