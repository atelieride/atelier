import { isPageToDemo, type DemoKey, type DemoToPage, type DemoView, type MessageBody } from '../protocol';

// The demo's side of the page ⇄ demo messages (protocol.ts). Pure: the shell hands it the
// browser's pieces (postMessage, the clock, focus) and the messages that passed fromParent().

export interface ChannelDeps {
  /** In the site's iframe (window.parent is the page); false when /demo-app/ is opened on its own. */
  embedded: boolean;
  post(m: MessageBody<DemoToPage>): void;
  pause(): void;
  resume(): void;
  /** The iframe has the focus again: back to where the visitor was. */
  focus(): void;
  /** A keydown the page caught: replayed inside. */
  key(k: DemoKey): void;
  /** A view to start on (a MenuCommand, or a demo view: open-view.ts). */
  open(view: DemoView): void;
  /** Opened directly, the ways out go to the site's home. */
  leave(): void;
  /** Opened directly, the green light asks the browser itself. */
  requestFullscreen(): void;
}

export interface Channel {
  readonly isReady: boolean;
  ready(): void;
  fail(reason: string): void;
  exit(): void;
  fullscreen(): void;
  checklist(done: number, total: number): void;
  /** A message from the parent (origin and source already checked). */
  receive(data: unknown): void;
  /** The demo's own document hidden (tab in the background) or shown again. */
  visibility(hidden: boolean): void;
}

export function createChannel(d: ChannelDeps): Channel {
  let ready = false;
  let failed = false;
  let pausedByPage = false;
  let hidden = false;
  let paused = false;
  let pending: DemoView | null = null;
  const post = (m: MessageBody<DemoToPage>) => { if (d.embedded) d.post(m); };
  const apply = () => {
    const want = pausedByPage || hidden;
    if (want === paused) return;
    paused = want;
    if (want) d.pause(); else d.resume();
  };
  return {
    get isReady() { return ready; },
    ready() {
      if (ready || failed) return;
      ready = true;
      post({ type: 'ready' });
      if (pending) { const cmd = pending; pending = null; d.open(cmd); }
    },
    fail(reason) {
      if (ready || failed) return;
      failed = true;
      post({ type: 'failed', reason: (reason || 'error').slice(0, 500) });
    },
    exit() { if (d.embedded) post({ type: 'exit' }); else d.leave(); },
    fullscreen() { if (d.embedded) post({ type: 'fullscreen' }); else d.requestFullscreen(); },
    checklist(done, total) { post({ type: 'checklist', done, total }); },
    receive(data) {
      if (!isPageToDemo(data)) return;
      switch (data.type) {
        case 'focus': d.focus(); break;
        case 'key': d.key(data.key); break;
        case 'pause': pausedByPage = true; apply(); break;
        case 'resume': pausedByPage = false; apply(); break;
        case 'open': if (ready) d.open(data.view); else pending = data.view; break;
      }
    },
    visibility(h) { hidden = h; apply(); }
  };
}

/** A message the demo acts on: from its parent window, from this very origin (never an opaque one). */
export function fromParent(e: { origin: string; source: unknown }, self: { origin: string; parent: unknown }): boolean {
  return e.source === self.parent && e.origin === self.origin && self.origin !== 'null';
}

