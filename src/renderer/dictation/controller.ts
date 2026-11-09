import { dictationReady } from '@shared/dictation';
import { useApp } from '../store';
import { bracketedPaste } from '../terminal/registry';
import { pasteSequence } from '../terminal/paste';
import { t } from '../i18n/en';
import { onKey, matchesShortcut, type KeyEventKind, type KeyState } from './keys';
import { Recorder } from './recorder';
import { trimSilence } from './audio';
import { dictationTarget } from './target';
import { startSound, stopSound } from './sounds';
import { sendInput } from '../terminal/drafts';
import { isImeComposing } from '@shared/keys';

// Dictation orchestration in the renderer: shortcut (hold/tap/Esc), microphone, transcription in main, text into the
// Claude session prompt. The microphone level does not go through React (the pill reads it every frame).

let state: KeyState = 'idle';
let downAt = 0;
let raw = false;
let recorder: Recorder | null = null;
let lastPcm: Int16Array | null = null;
let lastClaudeId: string | null = null;
let currentLevel = 0;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
// Esc during transcription: the result arriving later belongs to an old generation and is discarded.
let generation = 0;

export const micLevel = () => currentLevel;

const st = () => useApp.getState();
const show = (phase: 'idle' | 'listening' | 'transcribing' | 'inserted' | 'error', extra: { message?: string; canRetry?: boolean } = {}) => {
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
  st().setDictation({ phase, startedAt: phase === 'listening' ? Date.now() : st().dictation.startedAt, ...extra });
};
const closeSoon = (ms: number) => { closeTimer = setTimeout(() => { closeTimer = null; show('idle'); }, ms); };

/** Last selected Claude session (the text goes there if a plain terminal is selected now). */
export function noteSelection(id: string | null): void {
  const term = st().terminals.find((x) => x.id === id);
  if (term?.session) lastClaudeId = term.id;
}

/** The session the dictated text would go to right now (the pill sits over its pane in the split view). */
export function currentDictationTarget(): string | null {
  const s = st();
  return dictationTarget(s.terminals, s.selectedId, lastClaudeId);
}

function context() {
  const s = st();
  return {
    sessions: s.terminals.filter((x) => x.session).map((x) => x.title).slice(0, 50),
    branch: s.repos[0]?.detached ? null : s.repos[0]?.branch ?? null,
    files: [...new Set([...s.openFiles.map((f) => f.rel), ...s.recentFiles.map((f) => f.rel)])].slice(0, 100),
    identifiers: [] as string[]
  };
}

async function begin(): Promise<boolean> {
  const s = st();
  if (!s.dictationStatus || !dictationReady(s.dictationStatus)) {
    // Something is missing (microphone, model…): open Settings at the missing step instead of showing an error.
    s.setSettingsOpen('dictation');
    return false;
  }
  const r = new Recorder();
  recorder = r;
  try {
    await r.start((l) => { currentLevel = l; }, () => dispatch({ type: 'limit', at: Date.now() }));
  } catch (err) {
    if (recorder === r) recorder = null;
    // Stopped or cancelled while the microphone was opening: no error, the Recorder already closed everything.
    if ((err as Error).message !== 'cancelled') show('error', { message: t.dictationNoMic });
    return false;
  }
  // Meanwhile it was stopped (release, Esc, window lost focus): no "Listening".
  if (recorder !== r) return false;
  if (s.settings.dictationSounds) startSound();
  show('listening');
  return true;
}

async function finish(): Promise<void> {
  const r = recorder;
  recorder = null;
  currentLevel = 0;
  if (!r) { state = 'idle'; return; }
  if (st().settings.dictationSounds) stopSound();
  show('transcribing');
  const g = generation;
  const { pcm, speech } = trimSilence(await r.stop());
  if (g !== generation) return;
  if (!speech) { state = 'idle'; show('error', { message: t.dictationNoSpeech }); closeSoon(1400); return; }
  lastPcm = pcm;
  await send(pcm);
}

async function send(pcm: Int16Array): Promise<void> {
  show('transcribing');
  const g = generation;
  // The session the text will go to: its Claude account polishes it.
  const res = await window.atelier.dictation.transcribe(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), raw, context(), currentDictationTarget() ?? undefined);
  if (g !== generation) return;
  state = 'idle';
  if (res.warning === 'engine-error') { show('error', { message: t.dictationFailed, canRetry: true }); return; }
  if (res.warning === 'no-speech' || !res.text) { show('error', { message: t.dictationNoSpeech }); closeSoon(1400); return; }
  lastPcm = null;
  insert(res.text);
  if (res.warning === 'not-polished') st().showToast(t.dictationNotPolished, undefined, 'info');
  show('inserted');
  closeSoon(700);
}

function insert(text: string): void {
  const s = st();
  const id = dictationTarget(s.terminals, s.selectedId, lastClaudeId);
  if (!id) {
    void window.atelier.clipboard.write(text);
    s.showToast(t.dictationNoSession);
    return;
  }
  for (const part of pasteSequence(text, bracketedPaste(id), 512 * 1024)) sendInput(id, part);
  if (s.settings.dictationAutoSend) sendInput(id, '\r');
  if (s.selectedId !== id) s.select(id);
}

function dispatch(ev: KeyEventKind): void {
  const r = onKey(state, ev);
  state = r.state;
  if (r.action === 'start') {
    // If it did not start and nobody already stopped it, go back to idle (not during a transcription in progress).
    void begin().then((ok) => { if (!ok && (state === 'holding' || state === 'handsfree')) state = 'idle'; });
  } else if (r.action === 'stop') {
    void finish();
  } else if (r.action === 'cancel') {
    recorder?.cancel();
    recorder = null;
    currentLevel = 0;
    show('idle');
  }
}

/** Microphone button and the pill's "Stop": same as a tap of the shortcut. */
export function toggleDictation(): void {
  if (state === 'busy') return;
  raw = false;
  dispatch({ type: 'click', at: Date.now() });
}

export function cancelDictation(): void { dispatch({ type: 'escape', at: Date.now() }); }

/** "Try again": the same audio, still in memory. */
export function retryDictation(): void {
  if (!lastPcm || state !== 'idle') return;
  state = 'busy';
  void send(lastPcm);
}

export function closeDictation(): void { lastPcm = null; show('idle'); }

/** Window listeners, in capture phase (before the terminal and the editor). Returns the function that removes them. */
export function installDictationKeys(): () => void {
  const isKey = (e: KeyboardEvent) => matchesShortcut(e, st().settings.dictationShortcut);
  const onDown = (e: KeyboardEvent) => {
    if (!st().settings.dictationEnabled) return;
    // Enter and Esc of an IME composition are the input method's (a candidate picked, the composition dropped).
    if (e.key === 'Escape' && !isImeComposing(e) && (state === 'holding' || state === 'handsfree')) {
      e.preventDefault(); e.stopPropagation();
      dispatch({ type: 'escape', at: Date.now() });
      return;
    }
    // Enter while listening: stop and transcribe instead of reaching Claude as the send-message Enter.
    if (e.key === 'Enter' && !isImeComposing(e) && !e.metaKey && !e.ctrlKey && !e.altKey && (state === 'holding' || state === 'handsfree')) {
      e.preventDefault(); e.stopPropagation();
      dispatch({ type: 'enter', at: Date.now() });
      return;
    }
    // Esc while transcribing: cancel (the result will be discarded) and do not forward it to the terminal or Claude.
    if (e.key === 'Escape' && !isImeComposing(e) && state === 'busy' && st().dictation.phase === 'transcribing') {
      e.preventDefault(); e.stopPropagation();
      generation++;
      state = 'idle';
      lastPcm = null;
      show('idle');
      return;
    }
    if (!isKey(e)) return;
    e.preventDefault(); e.stopPropagation();
    if (e.repeat) return;
    if (state === 'idle') raw = e.shiftKey;
    downAt = Date.now();
    dispatch({ type: 'down', at: downAt });
  };
  const onUp = (e: KeyboardEvent) => {
    if (!st().settings.dictationEnabled || state !== 'holding') return;
    const code = st().settings.dictationShortcut === 'f5' ? 'F5' : 'Space';
    if (e.code !== code) return;
    e.preventDefault(); e.stopPropagation();
    dispatch({ type: 'up', at: Date.now(), downAt });
  };
  const onBlur = () => dispatch({ type: 'blur', at: Date.now() });
  window.addEventListener('keydown', onDown, true);
  window.addEventListener('keyup', onUp, true);
  window.addEventListener('blur', onBlur);
  return () => {
    window.removeEventListener('keydown', onDown, true);
    window.removeEventListener('keyup', onUp, true);
    window.removeEventListener('blur', onBlur);
  };
}
