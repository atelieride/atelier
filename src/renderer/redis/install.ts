// The window's Redis plumbing: the snapshot and status at start and on every change, monitor lines,
// failed-job notes (an entry, a toast in the focused window), and a banner's click.
import type { RedisNote } from '@shared/redis';
import { jobNote, redisSubject } from '@shared/notifications';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { useRedis } from './store';
import { redisKey } from './tabs';
import { openQueue } from './actions';
import { dbOfPick } from './view';

function viewing(n: RedisNote): boolean {
  const st = useApp.getState();
  const r = useRedis.getState();
  return typeof document !== 'undefined' && document.hasFocus() && st.activeKey() === redisKey('queues') && r.queue === n.queue.id;
}

export function receiveRedisNote(n: RedisNote): void {
  const st = useApp.getState();
  const here = viewing(n);
  st.receiveNotes([jobNote(n)], here ? redisSubject(n.queue.id) : null);
  if (here || typeof document === 'undefined' || !document.hasFocus()) return;
  st.showToast(t.redis.noteToast(n.queue.name, n.job.reason), { label: t.redis.show, run: () => openQueue(n.queue.id, 'failed') });
}

export function installRedis(): () => void {
  const r = useRedis.getState();
  void window.atelier.redis.snapshot().then((s) => { if (!useRedis.getState().snap) useRedis.setState({ db: dbOfPick(s) }); r.setSnap(s); }).catch(() => {});
  void window.atelier.redis.status().then(r.setStatus).catch(() => {});
  const offs = [
    window.atelier.on.redis((s) => {
      const cur = useRedis.getState();
      // Another instance picked: what was read belongs to the old one.
      if (cur.snap?.pick !== s.pick) {
        // Sheets and the undo were about the old instance: they close. The database the project's config names applies.
        const db = dbOfPick(s);
        useRedis.setState({ scan: null, ns: null, key: null, value: null, queue: null, jobs: null, job: null, jobId: null, lines: [], misses: new Set(), paused: null, clients: [], slow: null, sheet: null, undo: null, db });
      }
      cur.setSnap(s);
    }),
    window.atelier.on.redisStatus((s) => useRedis.getState().setStatus(s)),
    window.atelier.on.redisMonitor((e) => { if (e.key === useRedis.getState().snap?.pick) useRedis.getState().pushLines(e.lines); }),
    window.atelier.on.redisNote(receiveRedisNote),
    window.atelier.on.redisOpen((id) => openQueue(id, 'failed'))
  ];
  // A pop-out has no activity bar (whose effect calls leaveRedis in the project window): Never reaches its Redis tab
  // from here, and the window, left with nothing, gives it back.
  const offNever = useApp.subscribe((s, prev) => {
    if (s.popout && s.settings.showRedis === 'never' && prev.settings.showRedis !== 'never') leaveRedis();
  });
  return () => { offs.forEach((off) => off()); offNever(); };
}

/** Settings › Redis › Never: the view goes at once — the sidebar shows Sessions — and every Redis tab with it. */
export function leaveRedis(): void {
  const st = useApp.getState();
  if (st.activity === 'redis') st.setActivity('sessions', { keepHidden: true });
  for (const v of st.redisTabs) st.closeTab(redisKey(v));
}
