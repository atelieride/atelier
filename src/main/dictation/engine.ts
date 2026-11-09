import { spawn, type ChildProcess } from 'node:child_process';
import { SAMPLE_RATE } from '@shared/dictation';

// atelier-whisper kept warm: loads the model once and serves queued requests on stdin/stdout (no network).
// Protocol in native/atelier-whisper.cpp. If the process dies during a request: one restart and a new attempt with
// the same audio; then error. After idleMs without requests it stops and frees the memory (null = never).

export interface Segment { text: string; noSpeech: number }
export interface Transcript { text: string; noSpeech: number; language: string; ms: number; segments: Segment[] }
export type EngineState = 'off' | 'loading' | 'ready' | 'error';

export function encodeRequest(id: number, lang: string, prompt: string, pcm: Int16Array): Buffer {
  const l = Buffer.from(lang, 'utf8');
  const p = Buffer.from(prompt, 'utf8');
  const head = Buffer.alloc(4 + 4 + 1 + l.length + 4 + p.length + 4);
  let o = head.write('AWR1', 0, 'latin1');
  o = head.writeUInt32LE(id, o);
  o = head.writeUInt8(l.length, o);
  o += l.copy(head, o);
  o = head.writeUInt32LE(p.length, o);
  o += p.copy(head, o);
  head.writeUInt32LE(pcm.length, o);
  return Buffer.concat([head, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]);
}

/**
 * ggml-metal's residency sets keep a thread that wakes every 5 ms for the whole life of the process (measured: ~42
 * wakeups/s while idle, ggml-metal-device.m). Without them the model's memory is still allocated, only not re-wired
 *.
 */
export function whisperEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...base, GGML_METAL_NO_RESIDENCY: '1' };
}

interface Pending {
  id: number; pcm: Int16Array; lang: string; prompt: string; retried: boolean;
  resolve: (t: Transcript) => void; reject: (e: Error) => void; timer: NodeJS.Timeout;
}

export class WhisperEngine {
  private proc: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private out = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private idle: NodeJS.Timeout | null = null;
  private stopping = false;
  private failed = false;

  constructor(private readonly o: { bin: string; model: string; idleMs: number | null; onState?: (s: EngineState, error?: string) => void }) {}

  /** Starts the engine (if not running) and waits for the model to load. */
  warm(): Promise<void> {
    if (this.ready) return this.ready;
    this.stopping = false;
    this.o.onState?.('loading');
    const proc = spawn(this.o.bin, ['--model', this.o.model], { stdio: ['pipe', 'pipe', 'ignore'], env: whisperEnv(process.env), windowsHide: true });
    this.proc = proc;
    this.out = '';
    this.ready = new Promise<void>((resolve, reject) => {
      proc.stdout!.setEncoding('utf8');
      proc.stdout!.on('data', (chunk: string) => {
        this.out += chunk;
        let i: number;
        while ((i = this.out.indexOf('\n')) >= 0) {
          const line = this.out.slice(0, i);
          this.out = this.out.slice(i + 1);
          this.onLine(line, resolve, reject);
        }
      });
      proc.stdin!.on('error', () => { /* the process exited: 'exit' handles it */ });
      proc.on('error', (err) => reject(err));
      proc.on('exit', () => this.onExit(proc, reject));
    });
    // Without this, an unexpected rejection (e.g. engine dying with no requests) would become an unhandled error.
    this.ready.catch(() => {});
    return this.ready;
  }

  async transcribe(pcm: Int16Array, lang: string, prompt: string): Promise<Transcript> {
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    const id = this.nextId++;
    const result = new Promise<Transcript>((resolve, reject) => {
      const seconds = pcm.length / SAMPLE_RATE;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('transcription timed out')); }, 20_000 + 2_000 * seconds);
      this.pending.set(id, { id, pcm, lang, prompt, retried: false, resolve, reject, timer });
    });
    try {
      await this.warm();
      this.send(id);
    } catch (err) {
      const p = this.pending.get(id);
      if (p) { clearTimeout(p.timer); this.pending.delete(id); p.reject(err as Error); }
    }
    return result.finally(() => this.armIdle());
  }

  stop(): void {
    this.stopping = true;
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    const proc = this.proc;
    this.proc = null;
    this.ready = null;
    if (proc && proc.exitCode === null) {
      proc.stdin?.end();
      setTimeout(() => { if (proc.exitCode === null) proc.kill(); }, 2000).unref();
    }
    this.o.onState?.('off');
  }

  private send(id: number): void {
    const p = this.pending.get(id);
    if (p && this.proc?.stdin) this.proc.stdin.write(encodeRequest(id, p.lang, p.prompt, p.pcm));
  }

  private onLine(line: string, resolve: () => void, reject: (e: Error) => void): void {
    let msg: { ready?: boolean; error?: string; id?: number; text?: string; noSpeech?: number; language?: string; ms?: number; segments?: Segment[] };
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.ready) { this.failed = false; this.o.onState?.('ready'); resolve(); this.armIdle(); return; }
    if (msg.id === undefined) {
      if (msg.error) { this.failed = true; this.o.onState?.('error', msg.error); reject(new Error(msg.error)); }
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve({ text: msg.text ?? '', noSpeech: msg.noSpeech ?? 0, language: msg.language ?? '', ms: msg.ms ?? 0, segments: Array.isArray(msg.segments) ? msg.segments : [{ text: msg.text ?? '', noSpeech: msg.noSpeech ?? 0 }] });
  }

  private onExit(proc: ChildProcess, rejectReady: (e: Error) => void): void {
    if (this.proc === proc) { this.proc = null; this.ready = null; }
    rejectReady(new Error('engine stopped'));
    if (this.stopping) return;
    const open = [...this.pending.values()];
    // Exited after a load error (missing or broken model): the state stays "error".
    if (open.length === 0) { if (!this.failed) this.o.onState?.('off'); return; }
    // Died midway: a single restart per request, with the same audio.
    const retry = open.filter((p) => !p.retried);
    for (const p of open.filter((x) => x.retried)) { clearTimeout(p.timer); this.pending.delete(p.id); p.reject(new Error('engine stopped')); }
    if (retry.length === 0) { this.o.onState?.('error', 'engine stopped'); return; }
    for (const p of retry) p.retried = true;
    void this.warm().then(() => { for (const p of retry) this.send(p.id); }, (err: Error) => {
      for (const p of retry) { clearTimeout(p.timer); this.pending.delete(p.id); p.reject(err); }
    });
  }

  private armIdle(): void {
    if (this.o.idleMs === null || this.pending.size > 0) return;
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => { this.idle = null; if (this.pending.size === 0) this.stop(); }, this.o.idleMs);
    this.idle.unref();
  }
}
