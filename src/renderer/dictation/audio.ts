// Dictation audio in the renderer: from the microphone's Float32 to 16-bit PCM at 16 kHz, silence trimming, level for
// the pill's waveform. Pure and tested.

export const RATE = 16000;

/** Resamples to 16 kHz (average of each window's samples) and converts to 16 bit with clamping. */
export function downsample(input: Float32Array, fromRate: number): Int16Array {
  const ratio = fromRate / RATE;
  const n = Math.floor(input.length / ratio);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.max(a + 1, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = a; j < b; j++) sum += input[j]!;
    const v = sum / (b - a);
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v < 0 ? v * 32768 : v * 32767)));
  }
  return out;
}

/**
 * Trims silence at the start and end (20 ms windows, RMS above threshold = voice) leaving a margin.
 * No window above threshold: no speech (nothing is sent to Whisper, which invents phrases on silence).
 */
export function trimSilence(pcm: Int16Array, rate = RATE, threshold = 500, padMs = 200): { pcm: Int16Array; speech: boolean } {
  const win = Math.round(rate * 0.02);
  let first = -1;
  let last = -1;
  for (let s = 0; s < pcm.length; s += win) {
    let sum = 0;
    const end = Math.min(pcm.length, s + win);
    for (let i = s; i < end; i++) sum += pcm[i]! * pcm[i]!;
    if (Math.sqrt(sum / (end - s)) > threshold) { if (first < 0) first = s; last = end; }
  }
  if (first < 0) return { pcm: new Int16Array(0), speech: false };
  const pad = Math.round((rate * padMs) / 1000);
  return { pcm: pcm.slice(Math.max(0, first - pad), Math.min(pcm.length, last + pad)), speech: true };
}

/** Level 0..1 of a block (root of the RMS: even a quiet voice visibly moves it). */
export function level(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (const v of frame) sum += v * v;
  return Math.min(1, Math.sqrt(Math.sqrt(sum / frame.length)) * 1.4);
}
