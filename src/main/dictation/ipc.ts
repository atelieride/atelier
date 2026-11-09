import { BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { IPC } from '@shared/api';
import { dictationTranscribeSchema } from '../ipc-schemas';
import type { DictationService } from './service';

// Dictation channels: all from the app's pages; transcription with a strict schema (size-limited PCM, short lists).
/** accountDir: a window's terminal's Claude account dir, when it is a configured account other than the default. */
export function installDictationIpc(service: DictationService, trusted: (e: IpcMainInvokeEvent) => boolean, projectOf: (wcId: number) => string | null, testWav: string | null = null, accountDir: (project: string | null, terminalId: string | undefined) => string | undefined = () => undefined): void {
  const on = (channel: string, fn: (e: IpcMainInvokeEvent, arg: unknown) => unknown) =>
    ipcMain.handle(channel, (e, arg) => (trusted(e) ? fn(e, arg) : undefined));
  on(IPC.dictationStatus, () => service.status());
  on(IPC.dictationDownload, () => { void service.download(); });
  on(IPC.dictationCancel, () => service.cancelDownload());
  on(IPC.dictationRemove, () => service.removeModel());
  on(IPC.dictationRestart, () => service.restartEngine());
  on(IPC.dictationMic, () => service.requestMic());
  on(IPC.dictationPrivacy, () => shell.openExternal(process.platform === 'win32' ? 'ms-settings:privacy-microphone' : 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'));
  // Test only: the PCM of a WAV (16 kHz mono 16 bit, 44-byte header) in place of the microphone.
  on(IPC.dictationTestAudio, () => (testWav ? new Uint8Array(readFileSync(testWav).subarray(44)) : null));
  on(IPC.dictationTranscribe, (e, arg) => {
    const r = dictationTranscribeSchema.safeParse(arg);
    if (!r.success) return { text: '', polished: false, warning: 'engine-error' };
    // Aligned copy: the received buffer may not start at an even offset.
    const bytes = r.data.pcm;
    const pcm = new Int16Array(bytes.byteLength / 2);
    new Uint8Array(pcm.buffer).set(bytes);
    const root = projectOf(e.sender.id);
    return service.transcribe(pcm, r.data.raw, r.data.context, root ? basename(root) : null, accountDir(root, r.data.terminalId));
  });
}

export function broadcastDictation(status: unknown): void {
  for (const b of BrowserWindow.getAllWindows()) b.webContents.send(IPC.evDictation, status);
}
