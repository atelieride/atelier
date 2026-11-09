// Dictation: constants, state and cleanup of the transcribed text. Pure, shared.

export const SAMPLE_RATE = 16000;
/** Maximum recording (then it stops by itself and transcribes). */
export const MAX_SECONDS = 300;
/** Above this no-speech probability (maximum across segments) the text isn't real speech. */
export const NO_SPEECH_THRESHOLD = 0.6;

/** Default model: pinned URL and sha256 (verified on every download). */
export const MODEL = {
  file: 'ggml-large-v3-turbo-q5_0.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
  size: 574041195,
  sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2'
} as const;

export type ModelState = 'missing' | 'downloading' | 'verifying' | 'ready' | 'corrupted';

export interface DictationStatus {
  mic: 'granted' | 'not-determined' | 'denied' | 'restricted';
  model: { state: ModelState; received?: number; total?: number; error?: string };
  engine: 'off' | 'loading' | 'ready' | 'error';
  engineError?: string;
  polish: 'available' | 'unavailable';
}

/** Dictation is possible: microphone granted, model ready, engine not in error (off is fine: it starts on demand). */
export function dictationReady(s: DictationStatus): boolean {
  return s.mic === 'granted' && s.model.state === 'ready' && s.engine !== 'error';
}

// Phrases Whisper invents on silence (subtitles of the videos it was trained on): removed if they are the whole text or
// at the end. Anchored to the end: "Grazie per la visione del codice" really spoken stays.
const INVENTED = [
  // Known whole phrases: "i sottotitoli di default" really spoken stays.
  /sottotitoli (e revisione )?a cura di qtss[.!?]?$/i,
  /sottotitoli creati dalla comunità amara\.org[.!?]?$/i,
  /grazie (a tutti )?per (la visione|l'attenzione|aver guardato)[.!?]?$/i,
  /thank(s| you) (so much )?for watching[.!?]?$/i,
  /^\s*[[(](musica|music|applausi|applause|risate|silenzio|silence)[\])]\s*$/i
];

/**
 * Text of the spoken segments only: whisper.cpp gives the no-speech probability for each 30 s window, and in a
 * long dictation a window that starts in a pause must not erase everything else.
 */
export function speechText(segments: { text: string; noSpeech: number }[]): string {
  return segments.filter((s) => s.noSpeech < NO_SPEECH_THRESHOLD).map((s) => s.text).join('');
}

export function cleanTranscript(text: string, noSpeech: number): string {
  if (noSpeech >= NO_SPEECH_THRESHOLD) return '';
  let t = text.replace(/\s+/g, ' ').trim();
  for (const re of INVENTED) t = t.replace(re, '').trim();
  return t;
}
