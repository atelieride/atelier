import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { candidates, detect, type DetectDeps } from './detect';

const HOME = '/Users/me';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function deps(over: Partial<DetectDeps> & { sockets?: Record<string, 'ok' | 'gone' | 'denied'>; files?: Record<string, string> } = {}): DetectDeps {
  const sockets = over.sockets ?? {};
  const files = over.files ?? {};
  return {
    home: HOME, custom: '', testSocket: undefined,
    readFile: (p) => files[p] ?? null,
    isSocket: (p) => (p in sockets ? true : null),
    ping: async (s) => sockets[s] ?? 'gone',
    version: async () => ({ Version: '27.3.1', ApiVersion: '1.47', Os: 'linux', Arch: 'arm64' }),
    info: async () => ({ OperatingSystem: 'OrbStack', NCPU: 4, MemTotal: 8589934592 }),
    ...over
  };
}

describe('candidates', () => {
  test('known sockets in order when nothing is configured', () => {
    expect(candidates(deps())).toEqual([
      `${HOME}/.docker/run/docker.sock`, `${HOME}/.orbstack/run/docker.sock`, `${HOME}/.colima/default/docker.sock`, `${HOME}/.rd/docker.sock`, '/var/run/docker.sock'
    ]);
  });
  test('the current docker context first (unix only), without repeating it', () => {
    const files = {
      [`${HOME}/.docker/config.json`]: JSON.stringify({ currentContext: 'colima' }),
      [`${HOME}/.docker/contexts/meta/${sha('colima')}/meta.json`]: JSON.stringify({ Name: 'colima', Endpoints: { docker: { Host: `unix://${HOME}/.colima/default/docker.sock` } } })
    };
    expect(candidates(deps({ files }))[0]).toBe(`${HOME}/.colima/default/docker.sock`);
    expect(candidates(deps({ files })).filter((c) => c.includes('.colima'))).toHaveLength(1);
  });
  test('a tcp:// or ssh:// context is ignored; a broken config too', () => {
    const files = {
      [`${HOME}/.docker/config.json`]: JSON.stringify({ currentContext: 'remote' }),
      [`${HOME}/.docker/contexts/meta/${sha('remote')}/meta.json`]: JSON.stringify({ Endpoints: { docker: { Host: 'tcp://10.0.0.2:2375' } } })
    };
    expect(candidates(deps({ files }))[0]).toBe(`${HOME}/.docker/run/docker.sock`);
    expect(candidates(deps({ files: { [`${HOME}/.docker/config.json`]: '{nope' } }))[0]).toBe(`${HOME}/.docker/run/docker.sock`);
  });
  test('a custom path is the only candidate; the test socket overrides everything', () => {
    expect(candidates(deps({ custom: '/tmp/x.sock' }))).toEqual(['/tmp/x.sock']);
    expect(candidates(deps({ custom: '/tmp/x.sock', testSocket: '/t/d.sock' }))).toEqual(['/t/d.sock']);
  });
});

describe('candidates on Windows (named pipes)', () => {
  const WHOME = 'C:/Users/me';
  test('Docker Desktop\'s pipes; an npipe:// context first, as a pipe name', () => {
    expect(candidates(deps({ home: WHOME, platform: 'win32' }))).toEqual(['\\\\.\\pipe\\docker_engine', '\\\\.\\pipe\\dockerDesktopLinuxEngine']);
    const files = {
      [`${WHOME}/.docker/config.json`]: JSON.stringify({ currentContext: 'desktop-linux' }),
      [`${WHOME}/.docker/contexts/meta/${sha('desktop-linux')}/meta.json`]: JSON.stringify({ Endpoints: { docker: { Host: 'npipe:////./pipe/dockerDesktopLinuxEngine' } } })
    };
    expect(candidates(deps({ home: WHOME, platform: 'win32', files }))).toEqual(['\\\\.\\pipe\\dockerDesktopLinuxEngine', '\\\\.\\pipe\\docker_engine']);
  });
  test('a docker context on another machine\'s pipe is ignored (an SMB connection, the user\'s credentials)', () => {
    const files = {
      [`${WHOME}/.docker/config.json`]: JSON.stringify({ currentContext: 'remote' }),
      [`${WHOME}/.docker/contexts/meta/${sha('remote')}/meta.json`]: JSON.stringify({ Endpoints: { docker: { Host: 'npipe:////evil-host/pipe/docker_engine' } } })
    };
    expect(candidates(deps({ home: WHOME, platform: 'win32', files }))).toEqual(['\\\\.\\pipe\\docker_engine', '\\\\.\\pipe\\dockerDesktopLinuxEngine']);
  });
  test('a custom pipe, written either way', () => {
    expect(candidates(deps({ platform: 'win32', custom: 'npipe:////./pipe/podman-machine-default' }))).toEqual(['\\\\.\\pipe\\podman-machine-default']);
    expect(candidates(deps({ platform: 'win32', custom: '\\\\.\\pipe\\x' }))).toEqual(['\\\\.\\pipe\\x']);
  });
});

describe('detect', () => {
  test('absent: no socket file anywhere', async () => {
    expect(await detect(deps())).toEqual({ state: 'absent' });
  });
  test('stopped: a socket file nobody answers on', async () => {
    expect(await detect(deps({ sockets: { [`${HOME}/.docker/run/docker.sock`]: 'gone' } }))).toEqual({ state: 'stopped', socket: `${HOME}/.docker/run/docker.sock` });
  });
  test('the first answering socket wins, after a silent one', async () => {
    const r = await detect(deps({ sockets: { [`${HOME}/.docker/run/docker.sock`]: 'gone', [`${HOME}/.orbstack/run/docker.sock`]: 'ok' } }));
    expect(r).toEqual({ state: 'running', socket: `${HOME}/.orbstack/run/docker.sock`, name: 'OrbStack', version: '27.3.1', apiVersion: '1.47', os: 'linux', arch: 'arm64', cpus: 4, memory: 8589934592 });
  });
  test('denied', async () => {
    expect(await detect(deps({ sockets: { '/var/run/docker.sock': 'denied' } }))).toEqual({ state: 'denied', socket: '/var/run/docker.sock' });
  });
  test('unsupported: API older than 1.41', async () => {
    const r = await detect(deps({ sockets: { '/var/run/docker.sock': 'ok' }, version: async () => ({ Version: '19.03.1', ApiVersion: '1.40' }) }));
    expect(r).toEqual({ state: 'unsupported', socket: '/var/run/docker.sock', version: '19.03.1' });
  });
  test('a version reply that fails: stopped, not a crash', async () => {
    const r = await detect(deps({ sockets: { '/var/run/docker.sock': 'ok' }, version: async () => { throw new Error('gone'); } }));
    expect(r).toEqual({ state: 'stopped', socket: '/var/run/docker.sock' });
  });
});
