// Sync All Repositories' list: each repository Sync touched,
// done or what it needs. Show selects one in Source Control, where its own Sync asks what it must; one left alone
// because a live session is working on files the pull changes gets Pull…, the guarded pull (it shows those files first).
import type { SyncAllRow } from '@shared/git-write';
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { SheetFrame, closeGitSheet } from './SheetFrame';
import { startPull, syncAllRow } from './sync';

export function SyncAllSheet({ rows }: { rows: SyncAllRow[] }) {
  const s = t.git.sync;
  const entries = useApp((x) => x.scmRepos);
  const lines = rows.map((r) => ({ row: r, ...syncAllRow(r) }));
  const ok = lines.filter((l) => l.ok).length;
  const show = (root: string) => {
    closeGitSheet();
    const st = useApp.getState();
    st.setActivity('scm');
    if (st.scmRepo !== root) st.selectScmRepo(root);
  };
  const pull = (root: string) => { closeGitSheet(); void startPull(root); };
  return (
    <SheetFrame title={s.syncAllTitle} icon="sync">
      <p className="git-sheet-body">{s.syncAllBody(ok, rows.length - ok)}</p>
      <ul className="git-sheet-rows">
        {lines.map(({ row, ok: done, text, action }) => (
          <li key={row.root} className={`git-sheet-row ${done ? 'is-ok' : 'is-needs'}`}>
            <span className="git-sheet-row-icon" aria-hidden="true"><Icon name={done ? 'check' : 'warning'} size={12} stroke={2.2} /></span>
            <span className="git-sheet-row-main">
              <span className="git-sheet-row-name">{entries?.find((e) => e.root === row.root)?.name ?? row.root.split('/').pop()}</span>
              <span className="git-sheet-row-text">{text}</span>
            </span>
            {action === 'show' && <button type="button" className="btn-ghost sm" onClick={() => show(row.root)}>{s.showRepo}</button>}
            {action === 'pull' && <button type="button" className="btn-ghost sm" data-tip={s.pullRowTip} onClick={() => pull(row.root)}>{s.pullRow}</button>}
          </li>
        ))}
      </ul>
      <div className="git-sheet-actions">
        <span className="grow" />
        <button type="button" className="btn-ghost" data-autofocus onClick={closeGitSheet}>{s.close}</button>
      </div>
    </SheetFrame>
  );
}
