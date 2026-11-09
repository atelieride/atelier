import net from 'node:net';
import type { EventEmitter } from 'node:events';
import type { TerminalManager } from './terminals';
import { tokensEqual } from './auth';
import {
  DAEMON_CAPABILITIES, LineDecoder, MAX_HOOK_PAYLOAD_CHARS, MAX_LINE_CHARS, clientRequestSchema, encode, headerSchema,
  type ClientRequest, type ServerMessage, type TerminalProfile
} from '@shared/protocol';
import type { Usage, UsageEntry } from '@shared/session';
import type { NameReply } from '@shared/session-name';
import type { Attribution } from '@shared/attribution';
import { fitCalls, type ToolCallWindow } from '@shared/tool-calls';
import type { Resumable, ShellEnvState, TerminalInfo } from '@shared/protocol';
import type { CreateTerminal } from './terminals';
import type { ScheduleBook } from './schedules';
import type { ScheduledPrompt } from '@shared/scheduled-prompts';
import type { SignalBook } from './signals';
import type { SignalBookView } from '@shared/claude-signals';
import { PROTOCOL_VERSION } from '@shared/version';
import { canonicalPayload } from '@shared/hook-paths';

export interface ServerDeps {
  tokens: { control: string; hook: string };
  terminals: TerminalManager;
  version: string;
  pid: number;
  /** May return what the hook bridge prints back to Claude Code (a pending session name). */
  onHook(term: string, payload: unknown): NameReply | null | void;
  onStatus(term: string, payload: unknown): void;
  onShutdown(): void;
  log(msg: string): void;
  maxQueuedBytes?: number;
  getUsage(): Usage | null;
  getUsageByConfigDir(): UsageEntry[];
  /** Emits 'usage' (app-wide) and 'usageByConfigDir' when the usage limits change. */
  usageEvents: EventEmitter;
  getAttributions(): Attribution[];
  /** Emits 'attributions' when the list changes. */
  attrEvents: EventEmitter;
  getToolCalls(): ToolCallWindow[];
  /** Emits 'toolCalls' with the windows that changed, at once. */
  callEvents: EventEmitter;
  prune(root: string, dirty: string[], opts: { exclude?: string[]; before?: number }): void;
  getResumables(): Resumable[];
  /** Emits 'resumables' when the list changes. */
  resumeEvents: EventEmitter;
  /** Creates a terminal; may wait (an Atelier profile before the first shell environment capture). */
  create(o: CreateTerminal): Promise<TerminalInfo>;
  resume(id: string, cols: number, rows: number, profile?: TerminalProfile, aliases?: boolean, configDir?: string | null): Promise<TerminalInfo>;
  dismiss(id: string): void;
  /** Captures the user's shell environment again; resolves when done. */
  reloadEnv(): Promise<{ capturedAt: number }>;
  getShellEnv(): ShellEnvState;
  /** Emits 'shellEnv' when the capture's state changes. */
  envEvents: EventEmitter;
  /** Scheduled prompts (capability 'schedules'); emits 'changed' with the list. */
  schedules: ScheduleBook;
  /** The Claude Code signals notebook (capability 'signals'); emits 'changed' with the book, debounced. */
  signals: SignalBook;
}

const HEADER_TIMEOUT_MS = 2000;
const DEFAULT_MAX_QUEUED = 32 * 1024 * 1024;
// Each character can become up to 6 in JSON (\u001b): 512K characters always stay under the 4 MB line limit.
const SNAPSHOT_CHUNK_CHARS = 512 * 1024;

export interface RunningServer {
  /** Stops accepting connections and closes the open ones: close() alone would wait for the clients. */
  close(): Promise<void>;
  /** Apps connected now (a scheduled prompt waits for a countdown only when one may show it). */
  clients(): number;
}

export function startServer(sock: string, deps: ServerDeps): Promise<RunningServer> {
  const sockets = new Set<net.Socket>();
  const controls = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => { sockets.delete(socket); controls.delete(socket); });
    handleConnection(socket, deps, () => controls.add(socket));
  });
  const close = () => new Promise<void>((r) => {
    server.close(() => r());
    for (const s of sockets) s.destroy();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sock, () => { server.off('error', reject); resolve({ close, clients: () => controls.size }); });
  });
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

function handleConnection(socket: net.Socket, deps: ServerDeps, onControl: () => void): void {
  socket.setEncoding('utf8');
  const decoder = new LineDecoder();
  const timer = setTimeout(() => socket.destroy(), HEADER_TIMEOUT_MS);
  let mode: 'header' | 'event' | 'control' = 'header';
  let eventKind: 'hook' | 'status' = 'hook';
  let eventTerm = '';
  let eventBody = '';
  let delivered = false;
  let control: ControlSession | null = null;

  // An event payload arrives raw after the header: it is complete when it is valid JSON.
  const tryDeliverEvent = (): void => {
    if (delivered) return;
    if (eventBody.length > MAX_HOOK_PAYLOAD_CHARS) { socket.destroy(); return; }
    let payload: unknown;
    try { payload = JSON.parse(eventBody); } catch { return; }
    delivered = true;
    let reply: NameReply | null | void = null;
    try {
      // Windows paths (`C:\\…`) become canonical before any reducer reads them.
      const canonical = canonicalPayload(payload);
      if (eventKind === 'hook') reply = deps.onHook(eventTerm, canonical); else deps.onStatus(eventTerm, canonical);
    } catch (err) {
      deps.log(`${eventKind} event dropped: ${(err as Error).message}`);
    }
    // The bridge prints whatever comes back to Claude Code: only ever this JSON, or nothing.
    if (reply) socket.end(JSON.stringify(reply) + '\n'); else socket.end();
  };

  socket.on('data', (chunk: string) => {
    try {
      if (mode === 'event') { eventBody += chunk; tryDeliverEvent(); return; }
      const lines = decoder.push(chunk);
      for (const line of lines) {
        if (mode === 'header') {
          clearTimeout(timer);
          const h = headerSchema.safeParse(safeJson(line));
          if (!h.success) { socket.destroy(); return; }
          if (h.data.t === 'stop') {
            if (!tokensEqual(h.data.token, deps.tokens.control)) { socket.destroy(); return; }
            socket.end(encode({ t: 'stopping' }));
            deps.onShutdown();
            return;
          }
          if (h.data.t === 'hello') {
            if (!tokensEqual(h.data.token, deps.tokens.control)) { socket.destroy(); return; }
            // Right token but an app of another version: say so, so the app can offer to restart the service.
            if (h.data.v !== PROTOCOL_VERSION) { socket.end(encode({ t: 'incompatible', v: PROTOCOL_VERSION })); return; }
            mode = 'control';
            onControl();
            control = new ControlSession(socket, deps);
            control.send({ t: 'welcome', v: PROTOCOL_VERSION, version: deps.version, pid: deps.pid, capabilities: [...DAEMON_CAPABILITIES] });
            control.send({ t: 'terminals', list: deps.terminals.list() });
            control.send({ t: 'usage', usage: deps.getUsage() });
            control.send({ t: 'usageByConfigDir', list: deps.getUsageByConfigDir() });
            control.send({ t: 'attributions', list: deps.getAttributions() });
            // Well under the app's line cap: past it the app drops the connection (incremental sends are single windows).
            control.send({ t: 'toolCalls', list: fitCalls(deps.getToolCalls(), MAX_LINE_CHARS / 2), full: true });
            control.send({ t: 'resumables', list: deps.getResumables() });
            control.send({ t: 'shellEnv', ...deps.getShellEnv() });
            control.send({ t: 'schedules', list: deps.schedules.list() });
            control.send({ t: 'signals', book: deps.signals.view() });
          } else {
            if (!tokensEqual(h.data.token, deps.tokens.hook)) { socket.destroy(); return; }
            mode = 'event';
            eventKind = h.data.t;
            eventTerm = h.data.term;
            // The following payload lines are part of the body, not messages.
            const idx = lines.indexOf(line);
            eventBody = lines.slice(idx + 1).map((l) => l + '\n').join('') + decoder.rest();
            tryDeliverEvent();
            return;
          }
        } else if (mode === 'control') {
          control!.handle(line);
        }
      }
    } catch (err) {
      deps.log(`connection closed: ${(err as Error).message}`);
      socket.destroy();
    }
  });
  socket.on('end', () => { if (mode === 'event') tryDeliverEvent(); });
  socket.on('close', () => { clearTimeout(timer); control?.dispose(); });
  socket.on('error', () => { /* handled by close */ });
}

class ControlSession {
  private attachments = new Map<string, () => void>();
  private readonly onChanged = () => this.scheduleList();
  private readonly onExit = (id: string, code: number | null) => {
    this.attachments.delete(id);
    this.send({ t: 'exit', id, code });
  };
  private readonly onUsage = (usage: Usage | null) => this.send({ t: 'usage', usage });
  private readonly onUsageByDir = (list: UsageEntry[]) => this.send({ t: 'usageByConfigDir', list });
  private readonly onAttr = (list: Attribution[]) => this.send({ t: 'attributions', list });
  private readonly onCalls = (list: ToolCallWindow[]) => this.send({ t: 'toolCalls', list, full: false });
  private readonly onResumables = (list: Resumable[]) => this.send({ t: 'resumables', list });
  private readonly onShellEnv = (s: ShellEnvState) => this.send({ t: 'shellEnv', ...s });
  private readonly onSchedules = (list: ScheduledPrompt[]) => this.send({ t: 'schedules', list });
  private readonly onSignals = (book: SignalBookView) => this.send({ t: 'signals', book });
  private listTimer: NodeJS.Timeout | null = null;

  constructor(private readonly socket: net.Socket, private readonly deps: ServerDeps) {
    deps.terminals.on('changed', this.onChanged);
    deps.terminals.on('exit', this.onExit);
    deps.usageEvents.on('usage', this.onUsage);
    deps.usageEvents.on('usageByConfigDir', this.onUsageByDir);
    deps.attrEvents.on('attributions', this.onAttr);
    deps.callEvents.on('toolCalls', this.onCalls);
    deps.resumeEvents.on('resumables', this.onResumables);
    deps.envEvents.on('shellEnv', this.onShellEnv);
    deps.schedules.on('changed', this.onSchedules);
    deps.signals.on('changed', this.onSignals);
  }

  send(msg: ServerMessage): void {
    if (this.socket.destroyed) return;
    // A client that doesn't read must not make the service's memory grow without bound.
    if (this.socket.writableLength > (this.deps.maxQueuedBytes ?? DEFAULT_MAX_QUEUED)) {
      this.deps.log('client too slow: disconnected');
      this.socket.destroy();
      return;
    }
    this.socket.write(encode(msg));
  }

  handle(line: string): void {
    const raw = safeJson(line);
    const parsed = clientRequestSchema.safeParse(raw);
    if (!parsed.success) {
      const rid = (raw as { rid?: unknown } | null)?.rid;
      if (typeof rid === 'number') this.send({ t: 'reply', rid, ok: false, error: 'invalid request' });
      return;
    }
    const req = parsed.data;
    try {
      this.dispatch(req);
    } catch (err) {
      if ('rid' in req) this.send({ t: 'reply', rid: req.rid, ok: false, error: (err as Error).message });
    }
  }

  private dispatch(req: ClientRequest): void {
    const t = this.deps.terminals;
    switch (req.t) {
      case 'list':
        this.send({ t: 'reply', rid: req.rid, ok: true, result: t.list() });
        return;
      case 'create':
        this.replyWhenDone(req.rid, this.deps.create(req));
        return;
      case 'attach': {
        this.attachments.get(req.id)?.();
        const detach = t.attach(
          req.id,
          (snapshot) => {
            this.sendSnapshot(req.id, snapshot);
            this.send({ t: 'reply', rid: req.rid, ok: true });
          },
          (data) => this.send({ t: 'data', id: req.id, data })
        );
        this.attachments.set(req.id, detach);
        return;
      }
      case 'detach':
        this.attachments.get(req.id)?.();
        this.attachments.delete(req.id);
        this.send({ t: 'reply', rid: req.rid, ok: true });
        return;
      case 'input':
        t.input(req.id, req.data);
        return;
      case 'resize':
        t.resize(req.id, req.cols, req.rows);
        return;
      case 'kill':
        t.kill(req.id, { resumable: req.resumable === true });
        this.send({ t: 'reply', rid: req.rid, ok: true });
        return;
      case 'rename':
        t.rename(req.id, req.name);
        this.send({ t: 'reply', rid: req.rid, ok: true });
        return;
      case 'markSeen':
        t.markSeen(req.id);
        this.send({ t: 'reply', rid: req.rid, ok: true });
        return;
      case 'resume':
        this.replyWhenDone(req.rid, this.deps.resume(req.id, req.cols, req.rows, req.profile, req.aliases, req.configDir));
        return;
      case 'reloadEnv':
        this.replyWhenDone(req.rid, this.deps.reloadEnv());
        return;
      case 'dismiss':
        this.deps.dismiss(req.id);
        this.send({ t: 'reply', rid: req.rid, ok: true });
        return;
      case 'attrPrune':
        this.deps.prune(req.root, req.dirty, { exclude: req.exclude, before: req.before });
        this.send({ t: 'reply', rid: req.rid, ok: true });
        return;
      case 'shutdown':
        this.send({ t: 'reply', rid: req.rid, ok: true });
        this.deps.onShutdown();
        return;
      // Scheduled prompts: a refusal (time taken, unknown terminal…) throws, and handle() replies with its message.
      case 'schedAdd':
        this.send({ t: 'reply', rid: req.rid, ok: true, result: this.deps.schedules.add({ terminalId: req.terminalId, text: req.text, at: req.at, ifBusy: req.ifBusy }) });
        return;
      case 'schedUpdate':
        this.send({ t: 'reply', rid: req.rid, ok: true, result: this.deps.schedules.update({ id: req.id, text: req.text, at: req.at, ifBusy: req.ifBusy }) });
        return;
      case 'schedRemove':
        this.deps.schedules.remove(req.id);
        this.send({ t: 'reply', rid: req.rid, ok: true });
        return;
      case 'schedRestore':
        this.send({ t: 'reply', rid: req.rid, ok: true, result: this.deps.schedules.restore(req.prompt) });
        return;
      case 'schedFire':
        this.deps.schedules.fire(req.id, req.force);
        this.send({ t: 'reply', rid: req.rid, ok: true });
        return;
      case 'schedSnooze':
        this.deps.schedules.snooze(req.id, req.minutes);
        this.send({ t: 'reply', rid: req.rid, ok: true });
        return;
      // The book's own 'changed' waits for its debounce: the empty book goes now, before the reply, so the app has it
      // once its Clear resolves. Other apps get it at the debounce.
      case 'signalsClear':
        this.deps.signals.clear();
        this.send({ t: 'signals', book: this.deps.signals.view() });
        this.send({ t: 'reply', rid: req.rid, ok: true });
        return;
    }
  }

  private replyWhenDone(rid: number, p: Promise<unknown>): void {
    p.then(
      (result) => this.send({ t: 'reply', rid, ok: true, result }),
      (err: Error) => this.send({ t: 'reply', rid, ok: false, error: err.message })
    );
  }

  /** The screen can exceed the protocol's line limit: send it in chunks, the last one with done. */
  private sendSnapshot(id: string, snapshot: string): void {
    if (snapshot.length === 0) { this.send({ t: 'snapshot', id, data: '', done: true }); return; }
    for (let i = 0; i < snapshot.length; i += SNAPSHOT_CHUNK_CHARS) {
      this.send({ t: 'snapshot', id, data: snapshot.slice(i, i + SNAPSHOT_CHUNK_CHARS), done: i + SNAPSHOT_CHUNK_CHARS >= snapshot.length });
    }
  }

  private scheduleList(): void {
    if (this.listTimer) return;
    this.listTimer = setTimeout(() => {
      this.listTimer = null;
      this.send({ t: 'terminals', list: this.deps.terminals.list() });
    }, 100);
  }

  dispose(): void {
    for (const d of this.attachments.values()) d();
    this.attachments.clear();
    if (this.listTimer) clearTimeout(this.listTimer);
    this.deps.terminals.off('changed', this.onChanged);
    this.deps.terminals.off('exit', this.onExit);
    this.deps.usageEvents.off('usage', this.onUsage);
    this.deps.usageEvents.off('usageByConfigDir', this.onUsageByDir);
    this.deps.attrEvents.off('attributions', this.onAttr);
    this.deps.callEvents.off('toolCalls', this.onCalls);
    this.deps.resumeEvents.off('resumables', this.onResumables);
    this.deps.envEvents.off('shellEnv', this.onShellEnv);
    this.deps.schedules.off('changed', this.onSchedules);
    this.deps.signals.off('changed', this.onSignals);
  }
}
