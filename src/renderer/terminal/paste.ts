import type { ShellKind } from '@shared/shell-kind';
import { dropText } from './drop';

/**
 * Text pasted into the terminal (Paste menu and ⌘V): ESC and every control character removed except tab and newline.
 * An ESC in the text could end the bracketed paste and make the shell run the rest as commands.
 */
export function terminalPasteText(text: string): string {
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
}

/**
 * What to send to the terminal to paste: cleaned text, newlines as Enter (\r), in chunks that do not split
 * surrogate pairs (emoji) and, if the program asked for it, inside a single bracketed paste.
 */
export function pasteSequence(raw: string, bracketed: boolean, size: number): string[] {
  const text = terminalPasteText(raw).replace(/\r?\n/g, '\r');
  if (!text) return [];
  const parts: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + size);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    if (end <= i) end = Math.min(text.length, i + 2);
    parts.push(text.slice(i, end));
    i = end;
  }
  return bracketed ? ['\x1b[200~', ...parts, '\x1b[201~'] : parts;
}

/**
 * Files copied in Finder (⌘C) paste their escaped paths, as a drop does (Claude attaches images as [Image #N]).
 * null when no file has a path on disk: an image copied from an app also arrives as a file, and goes the image route.
 */
export function copiedFilesText(files: File[], pathFor: (f: File) => string | null, kind?: ShellKind): string | null {
  const paths = files.map(pathFor).filter((p): p is string => !!p);
  return paths.length ? dropText(paths, kind) || null : null;
}

/**
 * What to paste: the clipboard text; with no text, the path of the clipboard image saved to a file
 * (Claude Code attaches it as [Image #N]). null = text too large, for the warning.
 */
export type SavedImage = { path: string } | { tooLarge: true } | null;

export async function clipboardPayload(text: string | null, saveImage: () => Promise<SavedImage>, onTooLarge: () => void = () => {}): Promise<string | null> {
  if (text === null || text !== '') return text;
  const r = await saveImage();
  if (r && 'tooLarge' in r) { onTooLarge(); return ''; }
  return r?.path ?? '';
}
