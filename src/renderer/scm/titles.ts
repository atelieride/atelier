// Tab titles of the History tab and of files at a commit.
import { t } from '../i18n/en';
import type { RevFile } from '../store';

/** "History · atelier" (the entry's name, else the folder's). */
export function historyTabTitle(s: { historyTab: { repo: string } | null; scmRepos: { root: string; name: string }[] | null }): string {
  const h = s.historyTab;
  if (!h) return '';
  return t.scm.history.tab(s.scmRepos?.find((e) => e.root === h.repo)?.name ?? h.repo.split('/').at(-1) ?? h.repo);
}

/** "ChangesPanel.tsx @ f0d6c52". */
export function revTitle(f: RevFile | undefined): string {
  return f ? t.scm.rev.title(f.rel.split('/').at(-1) ?? f.rel, f.oid.slice(0, 7)) : '';
}
