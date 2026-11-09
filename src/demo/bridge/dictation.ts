// dictation.* in the demo: dictation runs on the Mac. The status says it is set up, so
// the mic shows as in the app; the recorder (aliased to stubs/recorder.ts in the demo build) gives the hint instead of
// opening the microphone, and every setup action does too.
import type { AtelierApi } from '@shared/api';
import type { DictationStatus } from '@shared/dictation';
import { notInDemo } from './not-in-demo';
import { noop, resolved } from './context';

export const DEMO_DICTATION: DictationStatus = { mic: 'granted', model: { state: 'ready' }, engine: 'off', polish: 'unavailable' };

export function createDictation(): AtelierApi['dictation'] {
  const mac = () => { notInDemo('Dictation'); return noop(); };
  return {
    status: () => resolved(DEMO_DICTATION),
    download: mac,
    cancelDownload: noop,
    removeModel: mac,
    restartEngine: mac,
    requestMic: () => { notInDemo('Dictation'); return resolved(false); },
    openPrivacy: mac,
    testAudio: () => resolved(null),
    transcribe: () => resolved({ text: '', polished: false, warning: 'engine-error' })
  };
}
