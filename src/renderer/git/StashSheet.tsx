// Stash Changes…: a message (WIP on <branch> when left empty), "Include new files" (on),
// "Only the staged files" (git 2.35 and later only), how many files go, and who is still editing them. The toast after
// offers Undo: a pop of that exact stash.
import { useEffect, useMemo, useState } from 'react';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { refreshFacts, stashPush } from './actions';
import { stashFileCount } from './branches';
import { liveNow } from './sync';
import { SheetFrame, closeGitSheet } from './SheetFrame';
import { idStyle } from '../avatar';

/** --staged came with git 2.35. */
const stagedSupported = (v: [number, number, number] | undefined) => !!v && (v[0] > 2 || (v[0] === 2 && v[1] >= 35));

export function StashSheet({ root }: { root: string }) {
  const s = t.git.stash;
  const facts = useApp((x) => x.gitFacts[root]);
  const repo = useApp((x) => x.repos.find((r) => r.root === root));
  const branch = facts?.branch ?? repo?.branch ?? null;
  const terminals = useApp((x) => x.terminals);
  const attributions = useApp((x) => x.attributions);
  useEffect(() => { void refreshFacts(root); }, [root]);
  const [message, setMessage] = useState('');
  const [untracked, setUntracked] = useState(true);
  const [staged, setStaged] = useState(false);
  const canStaged = stagedSupported(facts?.gitVersion);
  const onlyStaged = staged && canStaged;
  const changes = repo?.changes ?? [];
  const opts = { untracked: untracked && !onlyStaged, staged: onlyStaged };
  const taken = changes.filter((c) => stashFileCount([c], opts) === 1);
  const more = onlyStaged ? 0 : repo?.truncated ?? 0;
  const count = taken.length;
  // Who is still editing the files that go (live files): a stash takes them from under the session.
  const live = useMemo(() => liveNow(), [terminals, attributions]);
  const edited = taken.filter((c) => live.has(c.path));
  const who = [...new Map(edited.map((c) => { const by = live.get(c.path)!; return [by.terminalId, by] as const; })).values()];
  const placeholder = s.placeholder(branch);
  const empty = !!repo && count === 0 && more === 0;
  const go = () => {
    if (empty) return;
    closeGitSheet();
    void stashPush({ root, message: message.trim() || placeholder, ...opts });
  };
  return (
    <SheetFrame title={s.title} icon="stash">
      <div className="git-field">
        <input className="git-input" data-autofocus value={message} placeholder={placeholder} aria-label={s.message} spellCheck={false}
          onChange={(e) => setMessage(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } }} />
      </div>
      <div className="git-stash-opts">
        <label className={`git-sheet-check ${onlyStaged ? 'is-off' : ''}`}>
          <input type="checkbox" checked={untracked && !onlyStaged} disabled={onlyStaged} onChange={(e) => setUntracked(e.currentTarget.checked)} />
          {s.untracked}
        </label>
        {canStaged && (
          <label className="git-sheet-check">
            <input type="checkbox" checked={staged} onChange={(e) => setStaged(e.currentTarget.checked)} />
            {s.staged}
          </label>
        )}
        <span className="grow" />
        {repo && <span className={`git-stash-count mono ${empty ? 'is-empty' : ''}`}>{empty ? s.none : more ? s.countMore(count + more) : s.count(count)}</span>}
      </div>
      {who.length > 0 && (
        <div className="git-notice is-live">
          <i className="git-notice-dot id-dot" style={idStyle(who[0]!.color)} />
          <span className="git-notice-text">{t.git.drawer.editing(who.map((w) => w.title), edited.map((c) => c.rel.split('/').pop() ?? c.rel))}</span>
        </div>
      )}
      <div className="git-sheet-actions">
        <button type="button" className="btn-primary" disabled={empty} onClick={go}>{s.go}</button>
        <button type="button" className="btn-ghost" onClick={closeGitSheet}>{t.git.sync.cancel}</button>
        <span className="grow" />
        <span className="popover-hint mono">{t.git.sync.keys}</span>
      </div>
    </SheetFrame>
  );
}
