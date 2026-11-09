import { devEnv } from './dev-env';

interface Muteable { setAudioMuted(muted: boolean): void }
interface AppEvents { on(event: 'web-contents-created', listener: (e: unknown, wc: Muteable) => void): unknown }

/**
 * e2e pages are muted: the chime (chime.ts) and the dictation tones (dictation/sounds.ts) still run, so the tests cover
 * them, but whoever is using the Mac doesn't hear every run. Only under the test flag, which is inert in the packaged app.
 */
export function muteTestAudio(app: AppEvents): void {
  if (!devEnv('ATELIER_TEST_MUTED')) return;
  app.on('web-contents-created', (_e, wc) => wc.setAudioMuted(true));
}
