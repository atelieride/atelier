// `window.atelier.on.*` in the demo: what main pushes over IPC, pushed by the bridge and the
// engine instead. Every event is listed by name, so a new one in AtelierApi is a type error here until it is answered.
import type { AtelierApi } from '@shared/api';

type On = AtelierApi['on'];
export type EventName = keyof On;
/** The arguments an event's listeners get. */
export type EventArgs<K extends EventName> = Parameters<Parameters<On[K]>[0]>;

export interface Emitter {
  on: On;
  emit<K extends EventName>(name: K, ...args: EventArgs<K>): void;
  /** How many listen to an event now (tests, and the engine skips work nobody sees). */
  count(name: EventName): number;
}

export function createEmitter(): Emitter {
  const listeners = new Map<EventName, Set<(...a: never[]) => void>>();
  const listen = <K extends EventName>(name: K) => (cb: Parameters<On[K]>[0]): (() => void) => {
    const set = listeners.get(name) ?? new Set();
    listeners.set(name, set);
    const fn = cb as unknown as (...a: never[]) => void;
    set.add(fn);
    return () => { set.delete(fn); };
  };
  const on: On = {
    backgroundFeed: listen('backgroundFeed'),
    terminals: listen('terminals'),
    snapshot: listen('snapshot'),
    data: listen('data'),
    exit: listen('exit'),
    daemon: listen('daemon'),
    usage: listen('usage'),
    command: listen('command'),
    menuModel: listen('menuModel'),
    git: listen('git'),
    fsChanged: listen('fsChanged'),
    openPaths: listen('openPaths'),
    attributions: listen('attributions'),
    services: listen('services'),
    docker: listen('docker'),
    dockerLogs: listen('dockerLogs'),
    dockerStats: listen('dockerStats'),
    dockerEvent: listen('dockerEvent'),
    dockerNote: listen('dockerNote'),
    dockerOpen: listen('dockerOpen'),
    redis: listen('redis'),
    redisStatus: listen('redisStatus'),
    redisMonitor: listen('redisMonitor'),
    redisNote: listen('redisNote'),
    redisOpen: listen('redisOpen'),
    // The Databases view's snapshots, from the engine once the visitor connects (bridge/databases.ts).
    databases: listen('databases'),
    resumables: listen('resumables'),
    schedules: listen('schedules'),
    scheduleNotice: listen('scheduleNotice'),
    // atelierd's signals notebook: the demo's never changes, so none come.
    claudeSignals: listen('claudeSignals'),
    select: listen('select'),
    settings: listen('settings'),
    update: listen('update'),
    updateStatus: listen('updateStatus'),
    dictation: listen('dictation'),
    notes: listen('notes'),
    serviceLines: listen('serviceLines'),
    ports: listen('ports'),
    prs: listen('prs'),
    connectors: listen('connectors'),
    automations: listen('automations'),
    connectorNotice: listen('connectorNotice'),
    shellEnvAuto: listen('shellEnvAuto'),
    mcpAdded: listen('mcpAdded'),
    // Context usage's analysis on the demo's clock (bridge/context-usage.ts).
    contextProgress: listen('contextProgress'),
    // Main's questions and notices: the demo never quits or restarts atelierd, so none come.
    ask: listen('ask'),
    askWithdrawn: listen('askWithdrawn'),
    appNotice: listen('appNotice'),
    scm: listen('scm'),
    scmFetch: listen('scmFetch'),
    gitOp: listen('gitOp'),
    scmMessage: listen('scmMessage'),
    // Ask plays its script (bridge/companion.ts): runs stream, threads live for the visit.
    companion: listen('companion'),
    popouts: listen('popouts'),
    dock: listen('dock'),
    dockHover: listen('dockHover'),
    adopt: listen('adopt'),
    projectWindows: listen('projectWindows'),
    popoutReveal: listen('popoutReveal'),
    popoutClose: listen('popoutClose')
  };
  return {
    on,
    emit(name, ...args) {
      // A copy: a listener may unsubscribe while it runs. One throwing never stops the others (IPC delivers each).
      for (const fn of [...(listeners.get(name) ?? [])]) {
        try { (fn as (...a: unknown[]) => void)(...args); } catch (err) { console.error(err); }
      }
    },
    count: (name) => listeners.get(name)?.size ?? 0
  };
}
