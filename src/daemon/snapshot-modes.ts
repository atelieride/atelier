import type { Terminal as Headless } from '@xterm/headless';
import type { SerializeAddon } from '@xterm/addon-serialize';

/** The parts of xterm's state the serialize addon can't see (its public `modes` don't name them). */
interface Core { coreMouseService?: { activeEncoding?: string }; coreService?: { isCursorHidden?: boolean } }

/**
 * What the serialize addon leaves out of a screen, as the sequences that set it again: the mouse encoding and the
 * cursor's visibility (addon-serialize 0.14 restores the mouse tracking, not its encoding). Without them a reattached
 * view of full-screen Claude reported the wheel in X10 bytes, which never reach the program, and drew its cursor over
 * Claude's. Both are said even at their defaults (X10 under tracking, a shown cursor): the app guesses them for an
 * atelierd started before this (mouse-encoding.ts), and a view being reset keeps a hidden cursor hidden.
 * Read from xterm's own state rather than followed from the output: no copy of its DECSET, DECSTR and RIS rules to keep
 * in step (snapshot-modes.test.ts fails if an xterm update moves these fields).
 */
export function snapshotModes(screen: Headless): string {
  const core = (screen as unknown as { _core?: Core })._core;
  if (!core?.coreMouseService || !core.coreService) return '';
  const encoding = core.coreMouseService.activeEncoding;
  const mouse = encoding === 'SGR' ? '\x1b[?1006h' : encoding === 'SGR_PIXELS' ? '\x1b[?1016h' : screen.modes.mouseTrackingMode !== 'none' ? '\x1b[?1006l' : '';
  return mouse + (core.coreService.isCursorHidden ? '\x1b[?25l' : '\x1b[?25h');
}

/** The screen sent on attach. An untouched one stays empty: the app reads anything in it as the shell's first output. */
export function snapshotOf(screen: Headless, serializer: SerializeAddon): string {
  const serialized = serializer.serialize();
  return serialized && serialized + snapshotModes(screen);
}
