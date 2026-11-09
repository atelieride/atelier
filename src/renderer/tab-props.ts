import type { TerminalInfo } from '@shared/protocol';
import type { TabKey } from './tabs-model';

/** front: in front of a pane that isn't focused (split view). db: a table tab's icon, environment and tooltip. */
interface Shown { k: TabKey; active: boolean; drop: boolean; front?: boolean; term?: TerminalInfo; starting?: boolean; file?: { path: string; rel: string }; svcErrors?: number; title?: string; db?: { kind: string; env: string | null; tip: string }; badge?: number }

/** A tab re-renders only when what it shows changes: not on every status line tick (context, activity). */
export function tabPropsEqual(a: Shown, b: Shown): boolean {
  if (a.k !== b.k || a.active !== b.active || a.drop !== b.drop || !!a.front !== !!b.front || !!a.starting !== !!b.starting || a.title !== b.title || (a.badge ?? 0) !== (b.badge ?? 0)) return false;
  if (a.k === 'services' && (a.svcErrors ?? 0) !== (b.svcErrors ?? 0)) return false;
  const ta = a.term; const tb = b.term;
  if (!!ta !== !!tb) return false;
  if (ta && tb && (ta.title !== tb.title || ta.color !== tb.color || ta.name !== tb.name || ta.cwd !== tb.cwd || ta.session?.cwd !== tb.session?.cwd || ta.nameSync !== tb.nameSync || ta.session?.state !== tb.session?.state || !!ta.work?.counting !== !!tb.work?.counting || !!ta.session !== !!tb.session)) return false;
  if (a.db?.kind !== b.db?.kind || a.db?.env !== b.db?.env || a.db?.tip !== b.db?.tip) return false;
  return a.file?.path === b.file?.path && a.file?.rel === b.file?.rel;
}
