import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { AtelierApi } from '@shared/api';
import { IPC } from '@shared/api';

// Files dropped from File Explorer to open in tabs (drag and drop is an edge): the preload hands
// main canonical paths, which IPC requires on Windows. A drop on a terminal keeps the OS's form (it is typed there).

let api: AtelierApi;
const invoked: unknown[][] = [];
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_k: string, v: AtelierApi) => { api = v; } },
  ipcRenderer: { invoke: (...a: unknown[]) => { invoked.push(a); return Promise.resolve(); }, send: () => {}, on: () => {}, off: () => {} },
  webUtils: { getPathForFile: (f: { native: string }) => f.native }
}));
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeAll(async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  await import('./index');
});
afterAll(() => { Object.defineProperty(process, 'platform', platform); });

test('Windows: dropped files reach main as C:/…; a terminal still gets C:\\…', async () => {
  const file = { native: 'c:\\Users\\me\\notes.txt' } as unknown as File;
  await api.files.openDropped([file]);
  expect(invoked.find((a) => a[0] === IPC.filesOpenDropped)?.[1]).toEqual(['C:/Users/me/notes.txt']);
  expect(api.pathForFile(file)).toBe('c:\\Users\\me\\notes.txt');
});
