import type { PrEntry, PrInfo } from '@shared/pr';
import { t } from './i18n/en';

/** The PR a session bar shows: only a PR main found, with the setting on. */
export function prShown(entry: PrEntry | undefined, enabled: boolean): PrInfo | null {
  return enabled && entry?.status === 'ok' ? entry.pr : null;
}

export type PrGlyph = 'prOpen' | 'prDraft' | 'prMerged' | 'prClosed';

export function prGlyph(pr: PrInfo): PrGlyph {
  if (pr.state === 'MERGED') return 'prMerged';
  if (pr.state === 'CLOSED') return 'prClosed';
  return pr.isDraft ? 'prDraft' : 'prOpen';
}

/** The chip's tooltip, one line each: "#7 · Title", "Draft · Review: changes requested", "Checks: 12 passed, 1 failed (build)". */
export function prTip(pr: PrInfo): string[] {
  const state = pr.state === 'OPEN' && pr.isDraft ? t.pr.state.DRAFT : t.pr.state[pr.state];
  const lines = [t.pr.title(pr.number, pr.title), pr.reviewDecision && pr.state === 'OPEN' ? `${state} · ${t.pr.review[pr.reviewDecision]}` : state];
  const c = pr.ci;
  if (c.state !== 'none') lines.push(t.pr.checks(c.passed, c.failed, c.pending, c.failing));
  return lines;
}
