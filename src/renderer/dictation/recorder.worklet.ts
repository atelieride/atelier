// Microphone worklet: copies the first channel's samples and sends them to the main thread in blocks of 2048.
// Minimal types for the AudioWorklet context (they are not in TypeScript's DOM library).
declare class AudioWorkletProcessor { readonly port: MessagePort; }
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

class RecorderProcessor extends AudioWorkletProcessor {
  private buf = new Float32Array(2048);
  private n = 0;

  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i]!;
      if (this.n === this.buf.length) { this.port.postMessage(this.buf); this.buf = new Float32Array(2048); this.n = 0; }
    }
    return true;
  }
}

registerProcessor('atelier-recorder', RecorderProcessor);
