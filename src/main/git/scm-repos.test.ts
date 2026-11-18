import { afterEach, expect, test } from 'vitest';
import { setTestDefaultPlatform } from '@shared/platform';
import { scmEntries } from './scm-repos';
import type { WorkingTree } from './repos';

// Which of Source Control's entries Hide This Repository applies to, on either platform's paths.

afterEach(() => { setTestDefaultPlatform('darwin'); });

const tree = (root: string, extra: Partial<WorkingTree> = {}): WorkingTree => ({ root, common: `${root}/.git`, gitDir: `${root}/.git`, worktreeOf: null, hidden: false, ...extra });
const hideable = (root: string, trees: WorkingTree[]) => scmEntries(root, trees).filter((e) => e.hideable).map((e) => e.root);

test('macOS: a repository inside the project, not its root, a linked worktree or one outside it', () => {
  expect(hideable('/p', [tree('/p'), tree('/p/agent/repo'), tree('/p/wt', { common: '/p/.git', gitDir: '/p/.git/worktrees/wt' }), tree('/elsewhere/x'),
    tree('/p/.claude/worktrees/x', { common: '/p/.git', gitDir: null, worktreeOf: '/p', hidden: true })])).toEqual(['/p/agent/repo']);
});

test('Windows: the same drive inside the project, never another drive (its path from the project is absolute)', () => {
  setTestDefaultPlatform('win32');
  expect(hideable('C:/dev/p', [tree('C:/dev/p'), tree('C:/dev/p/agent/repo'), tree('D:/x'), tree('C:/dev/other')])).toEqual(['C:/dev/p/agent/repo']);
});
