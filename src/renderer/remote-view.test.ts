import { expect, test } from 'vitest';
import { remoteUrl } from './remote-view';

test('remoteUrl: a Remote Control session opens on claude.ai/code; anything else is no link', () => {
  expect(remoteUrl('session_01TestRemoteCtl4Kp9Zq')).toBe('https://claude.ai/code/session_01TestRemoteCtl4Kp9Zq');
  expect(remoteUrl(undefined)).toBeNull();
  expect(remoteUrl('')).toBeNull();
  expect(remoteUrl('session_')).toBeNull();
  expect(remoteUrl('https://example.invalid/x')).toBeNull();
  expect(remoteUrl('session_01/../../x')).toBeNull();
});
