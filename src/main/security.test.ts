import { expect, test, vi } from 'vitest';
vi.mock('electron', () => ({}));
import { secureWebPreferences } from './security';

test('preferenze web blindate', () => {
  const p = secureWebPreferences('/x/preload.js');
  expect(p).toMatchObject({
    contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false, webSecurity: true, allowRunningInsecureContent: false,
    webviewTag: false, navigateOnDragDrop: false, spellcheck: false, preload: '/x/preload.js'
  });
});

import { allowedRequest } from './security';
test('network: file and devtools always; localhost only in development; external never', () => {
  expect(allowedRequest('file:///app/index.html', false)).toBe(true);
  expect(allowedRequest('http://localhost:5173/', false)).toBe(false);
  expect(allowedRequest('ws://localhost:5173/', false)).toBe(false);
  expect(allowedRequest('http://localhost:5173/', true)).toBe(true);
  expect(allowedRequest('https://example.com/', true)).toBe(false);
  // Videos stream from main through tokens: that host only.
  expect(allowedRequest(`atelier-media://v/${'a'.repeat(64)}`, false)).toBe(true);
  expect(allowedRequest('atelier-media://x/abc', false)).toBe(false);
  expect(allowedRequest('atelier-mediax://v/abc', false)).toBe(false);
});

test('microphone: audio only, only from app pages, only with dictation enabled; never the camera', async () => {
  const { mediaRequestAllowed, mediaCheckAllowed } = await import('./security');
  const app = (u: string) => u.startsWith('file:///Applications/');
  const url = 'file:///Applications/Atelier.app/index.html';
  expect(mediaRequestAllowed('media', ['audio'], url, app, true)).toBe(true);
  expect(mediaRequestAllowed('media', ['video'], url, app, true)).toBe(false);
  expect(mediaRequestAllowed('media', ['audio', 'video'], url, app, true)).toBe(false);
  expect(mediaRequestAllowed('media', ['audio'], 'https://evil.example/', app, true)).toBe(false);
  expect(mediaRequestAllowed('media', ['audio'], url, app, false)).toBe(false);
  expect(mediaRequestAllowed('geolocation', [], url, app, true)).toBe(false);
  expect(mediaCheckAllowed('media', 'audio', url, app, true)).toBe(true);
  expect(mediaCheckAllowed('media', 'video', url, app, true)).toBe(false);
  expect(mediaCheckAllowed('media', 'audio', url, app, false)).toBe(false);
  expect(mediaCheckAllowed('notifications', undefined, url, app, true)).toBe(false);
});

test('installed fonts: only app pages may list them; every other permission stays denied', async () => {
  const { hardenSession } = await import('./security');
  type Check = (wc: null, perm: string, origin: string, d: Record<string, unknown>) => boolean;
  type Request = (wc: null, perm: string, cb: (ok: boolean) => void, d: Record<string, unknown>) => void;
  let check: Check = () => true;
  let request: Request = () => {};
  const s = {
    setPermissionCheckHandler: (h: Check) => { check = h; },
    setPermissionRequestHandler: (h: Request) => { request = h; },
    webRequest: { onBeforeRequest: () => {} }
  };
  const isApp = (u: string) => u.startsWith('file:///Applications/');
  hardenSession(s as never, { isApp, enabled: () => false });
  const url = 'file:///Applications/Atelier.app/index.html';
  const asked = (perm: string, requestingUrl: string) => { let ok: boolean | null = null; request(null, perm, (v) => { ok = v; }, { requestingUrl }); return ok; };
  expect(check(null, 'local-fonts', 'file:///', { requestingUrl: url })).toBe(true);
  expect(asked('local-fonts', url)).toBe(true);
  expect(check(null, 'local-fonts', 'https://evil.example', { requestingUrl: 'https://evil.example/' })).toBe(false);
  expect(asked('local-fonts', 'https://evil.example/')).toBe(false);
  expect(check(null, 'local-fonts', '', {})).toBe(false);
  for (const perm of ['geolocation', 'notifications', 'clipboard-read', 'window-management', 'media']) {
    expect(check(null, perm, 'file:///', { requestingUrl: url })).toBe(false);
    expect(asked(perm, url)).toBe(false);
  }
});
