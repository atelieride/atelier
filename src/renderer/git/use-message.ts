// A commit message field's text, kept as its working tree's draft (the drawer's, and each block of Source Control's All
// Repositories view: the same draft).
import { useEffect, useRef, useState } from 'react';
import { useApp } from '../store';

/** The message as typed, kept as the target's draft; a draft written elsewhere (cleared by a commit, ✦) comes in. */
export function useMessage(target: string | null): [string, (text: string) => void] {
  const stored = useApp((s) => (target ? s.gitDrafts[target] ?? '' : ''));
  const [text, setText] = useState(stored);
  const written = useRef(stored);
  useEffect(() => {
    if (stored === (written.current.trim() ? written.current : '')) return;
    written.current = stored;
    setText(stored);
  }, [stored]);
  useEffect(() => { written.current = stored; setText(stored); }, [target]);
  const change = (next: string) => {
    setText(next);
    written.current = next;
    if (target) useApp.getState().setGitDraft(target, next);
  };
  return [text, change];
}
