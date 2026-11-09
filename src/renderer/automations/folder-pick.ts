// The editor's folder picker: the project's folders matched by the query, as the
// "in Folder…" sheet matches them, and a typed path offered as it is when it is a clean folder not in the list (an
// ignored folder, or another project's automation, whose folders this window can't list). Pure.
import { cleanFolder } from '@shared/automations';
import { fuzzyFilter } from '@shared/fuzzy';
import type { FolderChoice } from '../folders';

const MAX_SHOWN = 300;

export function folderRows(choices: readonly FolderChoice[], query: string): { rows: FolderChoice[]; typed: string | null } {
  // The root is searched as "./" (its hint): the project name would match half of any query.
  const rows = fuzzyFilter([...choices], query.trim(), (c) => (c.rel ? `${c.rel}/` : './'), MAX_SHOWN);
  const path = cleanFolder(query.trim().replace(/^(?:\.\/)+/, '').replace(/^\/+|\/+$/g, ''));
  return { rows, typed: path && !choices.some((c) => c.rel === path) ? path : null };
}

/** "acme/" for the root, "acme/src/renderer" for a folder. */
export const folderLabel = (project: string, rel: string) => (rel ? `${project}/${rel}` : `${project}/`);
