import { expect, test } from 'vitest';
import { cleanTranscript, dictationReady, speechText, type DictationStatus } from './dictation';

test('normal text: spaces tidied, nothing else', () => {
  expect(cleanTranscript('  Apri il file  App.tsx ', 0.01)).toBe('Apri il file App.tsx');
});

test('silence: high no-speech probability = no text', () => {
  expect(cleanTranscript(' you', 0.93)).toBe('');
});

test('phrases Whisper invents on silence: removed if they are the whole text or at the end', () => {
  expect(cleanTranscript('Sottotitoli a cura di QTSS', 0.2)).toBe('');
  expect(cleanTranscript('Grazie per la visione.', 0.2)).toBe('');
  expect(cleanTranscript('Thank you for watching!', 0.2)).toBe('');
  expect(cleanTranscript('Rinomina la funzione. Sottotitoli a cura di QTSS', 0.1)).toBe('Rinomina la funzione.');
  expect(cleanTranscript('[Musica]', 0.3)).toBe('');
  expect(cleanTranscript('Grazie per la visione del codice, ora rifallo', 0.1)).toBe('Grazie per la visione del codice, ora rifallo');
});

test('ready only with microphone, model and engine in order', () => {
  const ok: DictationStatus = { mic: 'granted', model: { state: 'ready' }, engine: 'ready', polish: 'available' };
  expect(dictationReady(ok)).toBe(true);
  expect(dictationReady({ ...ok, engine: 'off' })).toBe(true);
  expect(dictationReady({ ...ok, mic: 'denied' })).toBe(false);
  expect(dictationReady({ ...ok, model: { state: 'missing' } })).toBe(false);
  expect(dictationReady({ ...ok, engine: 'error' })).toBe(false);
});

test('known invented phrases in full (also "e revisione", "Amara.org") removed; real words about subtitles stay', () => {
  expect(cleanTranscript('Sottotitoli e revisione a cura di QTSS', 0.1)).toBe('');
  expect(cleanTranscript('Sottotitoli creati dalla comunità Amara.org', 0.1)).toBe('');
  expect(cleanTranscript('Sottotitoli creati dalla comunità Amara.org.', 0.1)).toBe('');
  expect(cleanTranscript('Mostra nel player i sottotitoli di default.', 0.1)).toBe('Mostra nel player i sottotitoli di default.');
  expect(cleanTranscript('Aggiungi il supporto ai sottotitoli di YouTube', 0.1)).toBe('Aggiungi il supporto ai sottotitoli di YouTube');
});

test('per segment: silent segments are discarded, spoken ones stay (long dictations with pauses)', () => {
  expect(speechText([{ text: ' Prima parte.', noSpeech: 0.02 }, { text: ' you', noSpeech: 0.9 }, { text: ' Seconda parte.', noSpeech: 0.1 }])).toBe(' Prima parte. Seconda parte.');
  expect(speechText([{ text: ' you', noSpeech: 0.93 }])).toBe('');
  expect(speechText([])).toBe('');
});
