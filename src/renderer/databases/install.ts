// The window's Databases plumbing: main's snapshot at start and on every change. Installing
// connects nothing: a remembered pick shows selected, and connects once the view is shown.
import { useApp } from '../store';
import { useDb } from './store';

export function installDatabases(): () => void {
  // Main's event can come back before the first reply: it is the newer one, the reply is dropped.
  let pushed = false;
  let done = false;
  void window.atelier.databases.snapshot().then((s) => { if (!pushed && !done) useDb.getState().setSnap(s); }).catch(() => {});
  const off = window.atelier.on.databases((s) => {
    pushed = true;
    useDb.getState().setSnap(s);
  });
  // A pop-out has no activity bar (whose effect calls leaveDatabases in the project window): Never reaches its table
  // tab from here, and the window, left with nothing, gives it back.
  const offNever = useApp.subscribe((s, prev) => {
    if (s.popout && s.settings.showDatabases === 'never' && prev.settings.showDatabases !== 'never') leaveDatabases();
  });
  return () => {
    done = true;
    off();
    offNever();
  };
}

/**
 * Settings › Databases › Never: the view goes at once, as Redis's does — the sidebar shows Sessions — and so
 * does every table tab (`db:` keys), with its state. The one place the view is taken away.
 */
export function leaveDatabases(): void {
  const st = useApp.getState();
  if (st.activity === 'databases') st.setActivity('sessions', { keepHidden: true });
  st.closeDbTabs(() => true);
}
