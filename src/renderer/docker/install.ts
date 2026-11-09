// The window's Docker plumbing: the snapshot at start and on every change, pushed logs, stats and
// events, failure notes (an entry, a toast in the focused window), and a banner's click.
import { containerNote, dockerSubject } from '@shared/notifications';
import type { DockerNote } from '@shared/docker';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { useDocker } from './store';
import { receiveLogs } from './watch';
import { openContainer } from './actions';
import { dockerKey } from './tabs';

/** The note's container is on screen now (focused window, Docker tab, that container). */
function viewing(n: DockerNote): boolean {
  const st = useApp.getState();
  return typeof document !== 'undefined' && document.hasFocus() && st.activeKey() === dockerKey({ kind: 'container', id: n.container.id });
}

export function receiveDockerNote(n: DockerNote): void {
  const st = useApp.getState();
  const here = viewing(n);
  st.receiveNotes([containerNote(n)], here ? dockerSubject(n.container.id) : null);
  if (here || typeof document === 'undefined' || !document.hasFocus()) return;
  const what = t.notes.container(n.reason, n.exitCode);
  st.showToast(t.docker.toast(n.container.name, what), { label: t.docker.show, run: () => openContainer(n.container.id, n.reason === 'unhealthy' ? 'logs' : 'inspect') });
}

export function installDocker(): () => void {
  const d = useDocker.getState();
  void window.atelier.docker.snapshot().then(d.setSnapshot).catch(() => {});
  const offs = [
    window.atelier.on.docker((s) => useDocker.getState().setSnapshot(s)),
    window.atelier.on.dockerLogs(receiveLogs),
    window.atelier.on.dockerStats((e) => useDocker.getState().addStats(e.id, e.sample)),
    window.atelier.on.dockerEvent((e) => useDocker.getState().pushEvent(e)),
    window.atelier.on.dockerNote(receiveDockerNote),
    window.atelier.on.dockerOpen((id) => openContainer(id, 'inspect'))
  ];
  // A pop-out has no activity bar (whose effect calls leaveDocker in the project window): Never reaches its Docker tab
  // from here, and the window, left with nothing, gives it back.
  const offNever = useApp.subscribe((s, prev) => {
    if (s.popout && s.settings.showDocker === 'never' && prev.settings.showDocker !== 'never') leaveDocker();
  });
  return () => { offs.forEach((off) => off()); offNever(); };
}

/** Settings › Docker › Never: the view goes at once — the sidebar shows Sessions — and every Docker tab with it. */
export function leaveDocker(): void {
  const st = useApp.getState();
  if (st.activity === 'docker') st.setActivity('sessions', { keepHidden: true });
  for (const r of st.dockerTabs) st.closeTab(r.key);
}
