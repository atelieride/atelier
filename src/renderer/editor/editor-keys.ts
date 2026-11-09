// Keys every CodeMirror editor shares off macOS: Chromium on Windows
// reports AltGr as Ctrl+Alt, and Mod is Ctrl there, so the editor's bindings meet keys that are not theirs.
import { ViewPlugin, type KeyBinding } from '@codemirror/view';
import { searchKeymap } from '@codemirror/search';
import { defaultKeymap } from '@codemirror/commands';
import { typesWithAltGr, type KeyLike } from '@shared/accelerators';
import { currentPlatform } from '@shared/platform';

const isMac = () => currentPlatform() === 'darwin';

/**
 * A keydown that types a character through AltGr is stopped before the editor sees it: CodeMirror would read Italian
 * AltGr+è (which types [) as Ctrl+Alt+[ and fold, German AltGr+ß (\) as Ctrl+Alt+\ and indent. Its default action is
 * left alone, so the browser types the character and the editor takes it as any other input (closing brackets too).
 */
export function stopAltGrTyping(e: KeyLike & { stopPropagation(): void }): boolean {
  if (e.isComposing || !typesWithAltGr(e, isMac())) return false;
  e.stopPropagation();
  return true;
}

/** In every editor with keymaps: listens in the capture phase on the editor's root, before its content and panels. */
export const altGrTyping = ViewPlugin.define((view) => {
  const onKey = (e: KeyboardEvent) => { stopAltGrTyping(e); };
  view.dom.addEventListener('keydown', onKey, true);
  return { destroy: () => view.dom.removeEventListener('keydown', onKey, true) };
});

/** Off macOS Ctrl+Shift+G is Source Control (the menu matches it after the page): Mod-g keeps its plain key only. */
export function withoutShiftModG(bindings: readonly KeyBinding[]): KeyBinding[] {
  if (isMac()) return [...bindings];
  return bindings.map((b) => {
    if (b.key !== 'Mod-g' || !b.shift) return b;
    const plain = { ...b };
    delete plain.shift;
    return plain;
  });
}

/** @codemirror/search's keymap for this platform. */
export function searchKeys(): readonly KeyBinding[] {
  return isMac() ? searchKeymap : withoutShiftModG(searchKeymap);
}

/**
 * @codemirror/commands' default keymap for this platform. On macOS without Mod-i (select parent syntax): ⌘I is Ask
 * About This Session, and a key the editor handles never reaches the menu (⌘I takes it).
 * Elsewhere Ask is Ctrl+Shift+I, so Ctrl+I keeps selecting the parent syntax. `mac`: the platform to build for.
 */
export function defaultKeys(mac = isMac()): readonly KeyBinding[] {
  return mac ? defaultKeymap.filter((b) => b.key !== 'Mod-i') : defaultKeymap;
}
