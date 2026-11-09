// ✦ in the commit drawer as data: one run for the drawer's target, from writing (the text
// streams) to ready (the final text, put in the field as one undo step, then the tweak pills until the user types),
// or stopped (what was streamed, put in the field the same way). Pure; message-run.ts drives it, the drawer renders it.
import type { RepoStatus } from '@shared/git';
import type { MessageTweak } from '@shared/git-write';
import { t } from '../i18n/en';

export const TWEAKS: readonly MessageTweak[] = ['shorter', 'detail', 'subject'];

export interface GitWrite {
  root: string;
  phase: 'writing' | 'ready' | 'stopped';
  /** main's id for the run; null while main is starting it. */
  id: string | null;
  /** Writing: what streamed so far. Ready: the message main accepted. Stopped: what streamed before Stop. */
  text: string;
  /** The text the field still has to take (one undo step), null once it did. */
  apply: string | null;
  /** The staged files when it started (stagedKey): a change offers Rewrite. */
  staged: string;
  startedAt: number;
  tweak: MessageTweak | null;
  /** The tweaks used since the last plain ✦: each pill rewrites once. */
  used: MessageTweak[];
  model?: string;
  ms?: number;
  /** main's notes: "1 file left out of ✦ (looks like a secret)". */
  notes?: string[];
}

/** What is staged in a working tree, as one comparable string (the files and how much of each). */
export function stagedKey(repo: Pick<RepoStatus, 'changes'> | undefined): string {
  if (!repo) return '';
  return repo.changes.filter((c) => c.stage !== 'none').map((c) => `${c.stage}:${c.rel}`).sort().join('\n');
}

/** A new run. A tweak continues the chain of the same repository (its pill is spent); a plain ✦ starts a new one. */
export function writeStart(prev: GitWrite | null, o: { root: string; staged: string; at: number; tweak: MessageTweak | null }): GitWrite {
  const chain = o.tweak && prev && prev.root === o.root && prev.phase !== 'stopped' ? prev.used : [];
  return {
    root: o.root, phase: 'writing', id: null, text: '', apply: null, staged: o.staged, startedAt: o.at, tweak: o.tweak,
    used: o.tweak && !chain.includes(o.tweak) ? [...chain, o.tweak] : [...chain]
  };
}

export function writeChunk(w: GitWrite, chunk: string): GitWrite {
  return w.phase === 'writing' ? { ...w, text: w.text + chunk } : w;
}

export function writeReady(w: GitWrite, done: { text: string; model: string; ms: number; notes: string[] }): GitWrite {
  return { ...w, phase: 'ready', text: done.text, apply: done.text, model: done.model, ms: done.ms, notes: done.notes };
}

/** Stop: what streamed stays (the user's call), as one replacement; nothing streamed, nothing to keep. */
export function writeStopped(w: GitWrite): GitWrite | null {
  if (w.phase !== 'writing') return w;
  return w.text.trim() ? { ...w, phase: 'stopped', apply: w.text } : null;
}

/** The field took the text: ready stays (meta line, pills), a stopped run is over. */
export function writeApplied(w: GitWrite): GitWrite | null {
  if (w.phase === 'stopped') return null;
  return { ...w, apply: null };
}

/** The field changed: typing (or ⌘Z) ends ready, its pills and meta line; ✦'s own replacement arriving doesn't. */
export function writeEdited(w: GitWrite, text: string): GitWrite | null {
  if (w.phase !== 'ready' || w.apply !== null || text === w.text) return w;
  return null;
}

/** The pills still offered: ready, in the field, the ones not used since the last plain ✦. */
export function tweaksLeft(w: GitWrite | null): MessageTweak[] {
  if (!w || w.phase !== 'ready' || w.apply !== null) return [];
  return TWEAKS.filter((k) => !w.used.includes(k));
}

export function modelLabel(model: string): string {
  return model ? model[0]!.toUpperCase() + model.slice(1) : model;
}

/** "1.8 s". */
export function seconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
}

/** The line under the field: "✦ writing · Esc to stop", then "✦ Haiku · 1.8 s"; none otherwise. */
export function writeMeta(w: GitWrite | null): string | null {
  if (!w) return null;
  if (w.phase === 'writing') return t.git.write.writing;
  if (w.phase === 'ready') return t.git.write.meta(modelLabel(w.model ?? ''), seconds(w.ms ?? 0));
  return null;
}

/** The sparkle: it glows on an empty field and stays quiet otherwise; Stop while writing; ↻ once ready. */
export function sparkleMode(o: { w: GitWrite | null; empty: boolean }): 'glow' | 'write' | 'stop' | 'again' {
  if (o.w?.phase === 'writing') return 'stop';
  if (o.w?.phase === 'ready') return 'again';
  return o.empty ? 'glow' : 'write';
}

/** What is staged changed since ✦ started: the message may not describe it any more (writing or ready). */
export function stale(w: GitWrite | null, repo: Pick<RepoStatus, 'changes'> | undefined): boolean {
  if (!w || (w.phase !== 'writing' && w.phase !== 'ready')) return false;
  return stagedKey(repo) !== w.staged;
}
