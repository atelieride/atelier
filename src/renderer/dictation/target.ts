import type { TerminalInfo } from '@shared/protocol';
import { fronts, type Split } from '../split';

/**
 * Split view: the pane the dictation pill sits over — the one showing the session the text goes to (`target`), else
 * the focused pane (the target is not on screen, or there is none). One pane: that one.
 */
export function dictationPane(split: Split, target: string | null): number {
  const at = target ? fronts(split).indexOf(`t:${target}`) : -1;
  return at >= 0 ? at : split.focus;
}

/** Where the dictated text goes: the selected Claude session, otherwise the last used, otherwise the first; null if there is none. */
export function dictationTarget(terminals: TerminalInfo[], selectedId: string | null, lastClaudeId: string | null): string | null {
  const claude = terminals.filter((x) => x.session);
  if (claude.some((x) => x.id === selectedId)) return selectedId;
  if (lastClaudeId && claude.some((x) => x.id === lastClaudeId)) return lastClaudeId;
  return claude[0]?.id ?? null;
}
