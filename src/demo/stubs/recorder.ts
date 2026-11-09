// The demo build's stand-in for src/renderer/dictation/recorder.ts (aliased in vite.demo.config.ts): dictation runs on
// the Mac (spec live demo, non-goals), so the microphone, the AudioContext and the AudioWorklet never reach the bundle.
// Starting says so and fails as a cancelled start does: the controller shows no error, the demo shell shows the hint.
import type { Recorder as AppRecorder } from '../../renderer/dictation/recorder';
import { notInDemo } from '../bridge/not-in-demo';

/** The app's recorder's public surface: a change to it is a type error here. */
type RecorderApi = { [K in keyof AppRecorder]: AppRecorder[K] };

export class Recorder implements RecorderApi {
  start(_onLevel: (l: number) => void, _onLimit: () => void): Promise<void> {
    notInDemo('Dictation');
    return Promise.reject(new Error('cancelled'));
  }

  stop(): Promise<Int16Array> { return Promise.resolve(new Int16Array(0)); }

  cancel(): void {}
}
