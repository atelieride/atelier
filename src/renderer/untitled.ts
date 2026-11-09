// Untitled tabs (File › New File): an editor buffer with no file on disk until "Save as".
import { mainExtension } from '@shared/languages';

/** Synthetic tab path: real paths are absolute, so "untitled:N" can never collide with one. */
const PREFIX = 'untitled:';

export const isUntitled = (path: string): boolean => path.startsWith(PREFIX);

/** The next untitled tab: "Untitled-N" with the lowest N not in use. */
export function nextUntitled(paths: string[]): { path: string; rel: string } {
  const used = new Set(paths.filter(isUntitled).map((p) => p.slice(PREFIX.length)));
  let n = 1;
  while (used.has(String(n))) n++;
  return { path: `${PREFIX}${n}`, rel: `Untitled-${n}` };
}

const strip = (input: string) => input.trim().replace(/^(\.\/)+/, '');

/**
 * Save as: the part typed before the last slash searches the project's folders (no slash: all of it, without the
 * suggested extension at its end).
 */
export function folderQuery(input: string, suffix = ''): string {
  const s = strip(input);
  const i = s.lastIndexOf('/');
  if (i >= 0) return s.slice(0, i);
  return suffix && s.endsWith(suffix) ? s.slice(0, -suffix.length) : s;
}

/** Save as of a tab with a chosen language: the field starts with its extension (".md"), only a suggestion. */
export const suggestedSuffix = (lang: string | null): string => { const ext = mainExtension(lang); return ext ? `.${ext}` : ''; };

/** Save as without a file name: nothing typed, a folder ("notes/"), or only the suggested extension ("notes/.md"). */
export function missingName(input: string, suffix: string): boolean {
  const s = strip(input);
  return !s || s.endsWith('/') || (!!suffix && (s === suffix || s.endsWith(`/${suffix}`)));
}

/**
 * Save Outside the Project…: the name the save panel offers — what is typed after the
 * last slash, else the tab's own name ("Untitled-1") with the suggested extension.
 */
export function outsideName(input: string, suffix: string, untitled: string): string {
  if (missingName(input, suffix)) return `${untitled}${suffix}`;
  return strip(input).split('/').at(-1)!;
}

/** Where the caret goes after the field changes: before the suggested extension while it is still there. */
export const caretBeforeSuffix = (value: string, suffix: string): number => (suffix && value.endsWith(suffix) ? value.length - suffix.length : value.length);

/**
 * Tab on a folder suggestion: that folder, followed by the file name already typed after the last slash (with no
 * slash yet, by the suggested extension if it is still there).
 */
export function completeFolder(input: string, folderRel: string, suffix = ''): string {
  const s = strip(input);
  const i = s.lastIndexOf('/');
  const name = i >= 0 ? s.slice(i + 1) : suffix && s.endsWith(suffix) ? suffix : '';
  return folderRel ? `${folderRel}/${name}` : name;
}
