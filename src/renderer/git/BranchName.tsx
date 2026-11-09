// A new branch name, checked as the user types: a branch of that name already listed, or one
// whose folder it clashes with (feat and feat/x), else git's own check-ref-format through main, a moment after the last
// keystroke. Shared by New Branch, the inline rename and a new worktree's branch. `now` answers at once (Enter pressed
// before the check came back).
import { useEffect, useState } from 'react';
import { branchClash } from '@shared/git-write';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { checkBranchName } from './actions';

export type NameCheck = 'empty' | 'same' | 'checking' | 'ok' | 'invalid' | 'exists' | 'clash';

const DEBOUNCE_MS = 120;

/** What the listed branches already say about a name; null when main's check decides. */
export function localNameCheck(branches: readonly string[], name: string, same: string | undefined): { check: NameCheck; clash: string | null } | null {
  if (!name) return { check: 'empty', clash: null };
  if (name === same) return { check: 'same', clash: null };
  if (branches.includes(name)) return { check: 'exists', clash: null };
  const clash = branchClash(branches, name, same);
  return clash ? { check: 'clash', clash } : null;
}

/** `same`: the name it has now (a rename to it is no rename). */
export function useBranchNameCheck(root: string, name: string, same?: string): { check: NameCheck; clash: string | null; now: () => Promise<NameCheck> } {
  const branches = useApp((x) => x.scmRefs[root]?.refs);
  const [answer, setAnswer] = useState<{ name: string; ok: boolean } | null>(null);
  useEffect(() => {
    if (!name || name === same) return;
    let alive = true;
    const id = setTimeout(() => { void checkBranchName(root, name, same).then((ok) => { if (alive) setAnswer({ name, ok }); }); }, DEBOUNCE_MS);
    return () => { alive = false; clearTimeout(id); };
  }, [root, name, same]);
  const local = localNameCheck((branches ?? []).filter((r) => r.kind === 'head').map((r) => r.short), name, same);
  const check: NameCheck = local?.check ?? (answer?.name !== name ? 'checking' : answer.ok ? 'ok' : 'invalid');
  const now = async (): Promise<NameCheck> => local?.check ?? (check !== 'checking' ? check : (await checkBranchName(root, name, same)) ? 'ok' : 'invalid');
  return { check, clash: local?.clash ?? null, now };
}

/** What a check says under the field, null when there's nothing to say. */
export function nameError(check: NameCheck, name: string, clash?: string | null): string | null {
  return check === 'invalid' ? t.git.branch.invalid : check === 'exists' ? t.git.branch.exists(name)
    : check === 'clash' && clash ? t.git.branch.nameClash(clash, name) : null;
}
