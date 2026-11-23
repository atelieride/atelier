import { expect, test } from 'vitest';
import { DEFAULT_RELAY, relayBase, relayToDial } from './remote';

test('https anywhere, normalised without a trailing slash', () => {
  expect(relayBase(DEFAULT_RELAY)).toBe('https://relay.useatelier.dev');
  expect(relayBase('https://relay.useatelier.dev/')).toBe('https://relay.useatelier.dev');
  expect(relayBase('https://relay.test:8443/prefix/')).toBe('https://relay.test:8443/prefix');
  expect(relayBase('HTTPS://Relay.Test')).toBe('https://relay.test');
});

test('http only to loopback and private addresses', () => {
  for (const ok of ['http://localhost:8787', 'http://127.0.0.1:8787', 'http://127.9.9.9', 'http://[::1]:8787', 'http://10.1.2.3', 'http://172.16.0.1', 'http://172.31.255.254', 'http://192.168.1.20:8787', 'http://[fd12:3456::1]', 'http://[fc00::5]']) {
    expect(relayBase(ok), ok).not.toBeNull();
  }
  for (const bad of ['http://relay.test', 'http://8.8.8.8', 'http://172.32.0.1', 'http://172.15.0.1', 'http://192.169.0.1', 'http://[2001:db8::1]', 'http://[fe80::1]', 'http://localhost.relay.test']) {
    expect(relayBase(bad), bad).toBeNull();
  }
});

test('nothing else: other schemes, credentials, queries, fragments, garbage', () => {
  for (const bad of ['ws://localhost:8787', 'wss://relay.test', 'ftp://relay.test', 'https://user:pass@relay.test', 'https://relay.test/?a=1', 'https://relay.test/#x', 'relay.test', '', ' https://relay.test', 'https://']) {
    expect(relayBase(bad), bad).toBeNull();
  }
  expect(relayBase('https://relay.test/' + 'a'.repeat(600))).toBeNull();
});

test('a test relay stands in for the default relay only: a relay typed in Settings is dialed as it is', () => {
  expect(relayToDial(DEFAULT_RELAY, 'http://127.0.0.1:9')).toBe('http://127.0.0.1:9');
  expect(relayToDial('http://127.0.0.1:8787', 'http://127.0.0.1:9')).toBe('http://127.0.0.1:8787');
  expect(relayToDial('https://relay.test', undefined)).toBe('https://relay.test');
  expect(relayToDial(DEFAULT_RELAY, undefined)).toBe(DEFAULT_RELAY);
});
