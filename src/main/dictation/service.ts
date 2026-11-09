import { join } from 'node:path';
import { cleanTranscript, speechText, type DictationStatus } from '@shared/dictation';
import type { Settings } from '@shared/settings';
import { WhisperEngine, type EngineState } from './engine';
import { ModelStore, type ModelSpec } from './model';
import { polish, type Runner } from './polish';
import { buildVocabulary } from './vocabulary';

// Dictation in the main process: state of the four steps (microphone, model, engine, polish), model download and
// transcription. No exceptions toward the renderer: every problem becomes a warning, and the spoken text is never lost.

export interface DictationContext { sessions: string[]; branch: string | null; files: string[]; identifiers: string[] }
export interface DictationResult { text: string; polished: boolean; warning?: 'no-speech' | 'not-polished' | 'engine-error' }

export interface ServiceDeps {
  home: string;
  settings: () => Settings;
  /** atelier-whisper (or the fake engine in tests); null if missing from the app. */
  binPath: string | null;
  modelSpec?: ModelSpec;
  micStatus: () => DictationStatus['mic'];
  askMic: () => Promise<boolean>;
  claudeBin: () => string | null;
  polishRun?: Runner;
  onStatus: (s: DictationStatus) => void;
}

export class DictationService {
  private readonly model: ModelStore;
  private engine: WhisperEngine | null = null;
  private engineState: EngineState = 'off';
  private engineError: string | undefined;
  private downloading: { received: number; total: number; abort: AbortController; verifying: boolean } | null = null;
  private downloadError: string | undefined;

  constructor(private readonly d: ServiceDeps) {
    this.model = new ModelStore({ dir: join(d.home, 'models'), spec: d.modelSpec });
  }

  status(): DictationStatus {
    const state = this.downloading ? (this.downloading.verifying ? 'verifying' : 'downloading') : this.model.state();
    const model: DictationStatus['model'] = { state };
    if (this.downloading) { model.received = this.downloading.received; model.total = this.downloading.total; }
    if (this.downloadError && !this.downloading) model.error = this.downloadError;
    const s: DictationStatus = { mic: this.d.micStatus(), model, engine: this.engineState, polish: this.d.claudeBin() ? 'available' : 'unavailable' };
    if (this.engineError && this.engineState === 'error') s.engineError = this.engineError;
    return s;
  }

  private emit(): void { this.d.onStatus(this.status()); }

  async requestMic(): Promise<boolean> {
    const ok = await this.d.askMic();
    this.emit();
    return ok;
  }

  async download(): Promise<void> {
    if (this.downloading) return;
    this.downloadError = undefined;
    const abort = new AbortController();
    this.downloading = { received: 0, total: this.model.size, abort, verifying: false };
    this.emit();
    let last = 0;
    try {
      const r = await this.model.download((received, total) => {
        if (!this.downloading) return;
        this.downloading.received = received;
        this.downloading.total = total;
        if (received === total) this.downloading.verifying = true;
        // At most one update per ~1%: no flood of events.
        if (received - last > total / 100 || received === total) { last = received; this.emit(); }
      }, abort.signal);
      if (r === 'corrupted') this.downloadError = 'The downloaded model did not match its checksum. Try again.';
    } catch (err) {
      this.downloadError = `Download failed: ${(err as Error).message}`;
    } finally {
      this.downloading = null;
      this.emit();
    }
    this.warmIfReady();
  }

  cancelDownload(): void { this.downloading?.abort.abort(); }

  removeModel(): void {
    this.stopEngine();
    this.model.remove();
    this.emit();
  }

  restartEngine(): void {
    this.stopEngine();
    this.warmIfReady();
  }

  /** With dictation on and everything ready, the engine loads right away: the first key press doesn't wait. */
  warmIfReady(): void {
    const s = this.d.settings();
    if (!s.dictationEnabled) { this.stopEngine(); return; }
    if (this.model.state() !== 'ready' || !this.d.binPath) return;
    void this.ensureEngine().warm().catch(() => { /* the state already reports the error */ });
  }

  /** Settings changed: dictation off = engine stopped; different keep-loaded time = new engine. */
  settingsChanged(prev: Settings | null): void {
    const s = this.d.settings();
    if (prev && prev.dictationKeepLoaded !== s.dictationKeepLoaded) this.stopEngine();
    this.warmIfReady();
    this.emit();
  }

  /** configDir: the focused session's Claude account dir (a configured one only; absent: the default account). */
  async transcribe(pcm: Int16Array, raw: boolean, ctx: DictationContext, project: string | null = null, configDir?: string): Promise<DictationResult> {
    const s = this.d.settings();
    const vocabulary = buildVocabulary({ project, ...ctx });
    let text: string;
    try {
      const lang = s.dictationLanguage === 'auto' ? '' : s.dictationLanguage;
      const t = await this.ensureEngine().transcribe(pcm, lang, vocabulary);
      // Only the spoken segments: a silent window in a long dictation doesn't erase the rest.
      text = cleanTranscript(speechText(t.segments), 0);
    } catch {
      return { text: '', polished: false, warning: 'engine-error' };
    }
    if (!text) return { text: '', polished: false, warning: 'no-speech' };
    const claude = this.d.claudeBin();
    if (raw || !s.dictationPolish || !claude) return { text, polished: false };
    const p = await polish(text, vocabulary, { claudeBin: claude, run: this.d.polishRun, ...(configDir ? { configDir } : {}) });
    return p.polished ? { text: p.text, polished: true } : { text, polished: false, warning: 'not-polished' };
  }

  dispose(): void {
    this.cancelDownload();
    this.stopEngine();
  }

  private ensureEngine(): WhisperEngine {
    if (this.engine) return this.engine;
    if (!this.d.binPath) throw new Error('atelier-whisper missing');
    const idleMs = this.d.settings().dictationKeepLoaded === 'always' ? null : 10 * 60_000;
    this.engine = new WhisperEngine({
      bin: this.d.binPath, model: this.model.path(), idleMs,
      onState: (st, error) => { this.engineState = st; this.engineError = error; if (st === 'off') this.engine = null; this.emit(); }
    });
    return this.engine;
  }

  private stopEngine(): void {
    const e = this.engine;
    this.engine = null;
    e?.stop();
    this.engineState = 'off';
  }
}
