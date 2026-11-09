import workletUrl from './recorder.worklet.ts?worker&url';
import { downsample, level } from './audio';
import { MAX_SECONDS } from '@shared/dictation';

// Recording from the microphone, in memory only: no files, no network. The microphone is released on every stop/cancel
// (macOS's orange indicator turns off as soon as dictation stops).

// Tests only (ATELIER_TEST_FAKE_MIC): a WAV instead of the microphone. In the real app main answers null.
let testAudio: Promise<Int16Array | null> | null = null;
function loadTestAudio(): Promise<Int16Array | null> {
  testAudio ??= window.atelier.dictation.testAudio().then((b) => (b ? new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) : null)).catch(() => null);
  return testAudio;
}

export class Recorder {
  private fake: { pcm: Int16Array; timer: ReturnType<typeof setInterval> } | null = null;
  private cancelled = false;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private chunks: Float32Array[] = [];
  private total = 0;

  /**
   * onLimit: once 5 minutes are reached, the caller stops and transcribes. If stop/cancel arrive while the microphone or
   * the worklet are still opening, whatever opens afterwards is closed right away and start fails with "cancelled":
   * the microphone never stays on with nobody to close it.
   */
  async start(onLevel: (l: number) => void, onLimit: () => void): Promise<void> {
    this.cancelled = false;
    this.chunks = [];
    this.total = 0;
    const check = async () => { if (this.cancelled) { await this.release(); throw new Error('cancelled'); } };
    try {
      const test = await loadTestAudio();
      await check();
      if (test) {
        // Simulation: the waveform follows the WAV over time, as the microphone would.
        let i = 0;
        const step = 800;
        const timer = setInterval(() => {
          const part = test.subarray(i % test.length, (i % test.length) + step);
          onLevel(level(Float32Array.from(part, (v) => v / 32768)));
          i += step;
        }, 50);
        this.fake = { pcm: test, timer };
        return;
      }
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true } });
      await check();
      const ctx = new AudioContext();
      this.ctx = ctx;
      await ctx.audioWorklet.addModule(workletUrl);
      await check();
      const source = ctx.createMediaStreamSource(this.stream);
      const node = new AudioWorkletNode(ctx, 'atelier-recorder');
      const max = MAX_SECONDS * ctx.sampleRate;
      let limited = false;
      node.port.onmessage = (e: MessageEvent<Float32Array>) => {
        if (this.total < max) { this.chunks.push(e.data); this.total += e.data.length; }
        else if (!limited) { limited = true; onLimit(); }
        onLevel(level(e.data));
      };
      // The worklet only runs if the graph reaches the output: zero gain, no sound.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      source.connect(node).connect(mute).connect(ctx.destination);
    } catch (err) {
      await this.release();
      throw err;
    }
  }

  /** Stops and returns the audio at 16 kHz, 16 bit. */
  async stop(): Promise<Int16Array> {
    this.cancelled = true;
    if (this.fake) { const pcm = this.fake.pcm; await this.release(); return pcm; }
    const rate = this.ctx?.sampleRate ?? 48000;
    // Exactly up to the limit: the last 2048-sample block would exceed it.
    const all = new Float32Array(Math.min(this.total, MAX_SECONDS * rate));
    let o = 0;
    for (const c of this.chunks) { if (o >= all.length) break; all.set(c.subarray(0, all.length - o), o); o += c.length; }
    await this.release();
    return downsample(all, rate);
  }

  cancel(): void { this.cancelled = true; void this.release(); }

  private async release(): Promise<void> {
    if (this.fake) { clearInterval(this.fake.timer); this.fake = null; }
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    const ctx = this.ctx;
    this.ctx = null;
    this.chunks = [];
    this.total = 0;
    await ctx?.close().catch(() => {});
  }
}
