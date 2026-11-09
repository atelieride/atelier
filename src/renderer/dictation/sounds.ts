// Two short, discreet tones (start: rising, end: falling), generated with WebAudio: no audio files.
let ctx: AudioContext | null = null;

function tone(from: number, to: number): void {
  try {
    ctx ??= new AudioContext();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + 0.07);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.05, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.1);
  } catch { /* no audio: no sound */ }
}

export const startSound = () => tone(880, 1320);
export const stopSound = () => tone(1320, 880);
