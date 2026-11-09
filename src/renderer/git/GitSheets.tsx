// The git sheets: the store's one gitSheet at a time, mounted once in App. Nothing shows in
// Read-only (a sheet open when the setting changes goes away).
import { useApp } from '../store';
import { PublishSheet } from './PublishSheet';
import { PullOverlapSheet, PullRebaseSheet } from './PullSheets';
import { ForcePushSheet, PushRejectedSheet } from './PushRejectedSheet';
import { SyncAllSheet } from './SyncAllSheet';
import { SwitchSheet } from './SwitchSheet';
import { NewBranchSheet } from './NewBranchSheet';
import { DeleteBranchSheet } from './DeleteBranchSheet';
import { WorktreeSheet } from './WorktreeSheet';
import { StashSheet } from './StashSheet';
import { DiscardSheet } from './DiscardSheet';

export function GitSheets() {
  const sheet = useApp((s) => s.gitSheet);
  const on = useApp((s) => s.settings.gitActions === 'on');
  if (!sheet || !on) return null;
  switch (sheet.kind) {
    case 'publish': return <PublishSheet key={sheet.root} root={sheet.root} />;
    case 'rejected': return <PushRejectedSheet key={sheet.root} root={sheet.root} />;
    case 'forcePush': return <ForcePushSheet key={sheet.root} root={sheet.root} commits={sheet.commits} total={sheet.total} remoteOid={sheet.remoteOid} />;
    case 'pullRebase': return <PullRebaseSheet key={sheet.root} root={sheet.root} sync={sheet.sync} byResult={!!sheet.byResult} />;
    case 'pullOverlap': return <PullOverlapSheet key={sheet.root} root={sheet.root} files={sheet.files} rebase={sheet.rebase} sync={sheet.sync} />;
    case 'syncAll': return <SyncAllSheet rows={sheet.rows} />;
    case 'switch': return <SwitchSheet key={`${sheet.root}\n${sheet.ref}\n${sheet.clash?.join('\n') ?? ''}`} root={sheet.root} refName={sheet.ref} {...(sheet.clash ? { clash: sheet.clash } : {})} />;
    case 'newBranch': return <NewBranchSheet key={`${sheet.root}\n${sheet.from ?? ''}`} root={sheet.root} {...(sheet.from ? { from: sheet.from } : {})} />;
    case 'deleteBranch': return <DeleteBranchSheet key={`${sheet.root}\n${sheet.ref}`} root={sheet.root} refName={sheet.ref} {...(sheet.message ? { message: sheet.message } : {})} />;
    case 'worktree': return <WorktreeSheet key={`${sheet.root}\n${sheet.ref ?? ''}`} root={sheet.root} {...(sheet.ref ? { refName: sheet.ref } : {})} />;
    case 'stash': return <StashSheet key={sheet.root} root={sheet.root} />;
    case 'discard': return <DiscardSheet targets={sheet.targets} />;
    default: return null;
  }
}
