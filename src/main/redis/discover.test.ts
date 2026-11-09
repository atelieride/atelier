import { describe, expect, test } from 'vitest';
import { gatherCandidates, viewFor, type DiscoverInputs } from './discover';
import type { DockerContainer } from '@shared/docker';

const container = (o: Partial<DockerContainer>): DockerContainer => ({
  id: 'a'.repeat(64), name: 'redis', containerName: 'acme-store-redis-1', project: 'acme-store', service: 'redis', workingDir: '/code/acme', configFiles: [],
  image: 'redis:7', state: 'running', health: null, exitCode: null, restarts: 0, startedAt: 1, finishedAt: null, ports: [{ host: 6380, container: 6379, proto: 'tcp' }],
  exposed: [6379], tty: false, oomKilled: false, restartPolicy: 'no', ...o
});

const base = (o: Partial<DiscoverInputs> = {}): DiscoverInputs => ({ projects: ['/code/acme'], env: () => ({}), containers: [], terminals: [], ports: [6379], custom: [], ...o });

describe('gatherCandidates', () => {
  test('.env URL on loopback, a compose service host mapped to its published port, remote hosts ignored', () => {
    const c = gatherCandidates(base({
      env: () => ({ REDIS_URL: 'redis://:pw@localhost:6379/2', REDIS_HOST: 'redis', REDIS_PORT: '6379', CACHE_URL: 'redis://10.1.1.1:6379' }),
      containers: [container({})]
    }));
    expect(c.map((x) => [x.key, x.sources.sort().join('+'), x.env?.var ?? null])).toEqual([
      ['tcp:6379', 'env+port', 'REDIS_URL'],
      ['tcp:6380', 'docker+env', 'REDIS_HOST']
    ]);
    expect(c[0]!.env).toMatchObject({ db: 2, password: 'pw', project: '/code/acme' });
    expect(c[1]!.container).toMatchObject({ name: 'acme-store-redis-1', service: 'redis', running: true, project: '/code/acme' });
  });
  test('Docker Redis-like images by their 6379 mapping; terminal redis-server ports; custom sockets; tls listed as unsupported', () => {
    const c = gatherCandidates(base({
      env: () => ({ REDIS_URL: 'rediss://127.0.0.1:6390' }),
      containers: [container({ image: 'redis/redis-stack:latest', ports: [{ host: 6385, container: 6379, proto: 'tcp' }, { host: 8001, container: 8001, proto: 'tcp' }], workingDir: '/elsewhere', project: 'other' }), container({ id: 'b'.repeat(64), image: 'postgres:16', ports: [{ host: 5432, container: 5432, proto: 'tcp' }] })],
      terminals: [{ project: '/code/acme', port: 7000, name: 'redis-server', title: 'Terminal 2' }, { project: '/code/acme', port: 3000, name: 'node', title: 'dev' }],
      custom: ['/tmp/redis.sock'], ports: []
    }));
    expect(c.map((x) => [x.key, x.sources.join('+')])).toEqual([
      ['tcp:6385', 'docker'], ['tcp:6390', 'env'], ['tcp:7000', 'terminal'], ['unix:/tmp/redis.sock', 'custom']
    ]);
    expect(c.find((x) => x.key === 'tcp:6390')!.tls).toBe(true);
    expect(c.find((x) => x.key === 'tcp:7000')!.terminal).toEqual({ name: 'redis-server', title: 'Terminal 2', project: '/code/acme' });
  });
  test('a stopped compose Redis of the project attaches to the endpoint the project expects', () => {
    const c = gatherCandidates(base({ env: () => ({ REDIS_HOST: '127.0.0.1' }), containers: [container({ state: 'exited', ports: [], finishedAt: 5 })] }));
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ key: 'tcp:6379', container: { running: false, finishedAt: 5 } });
  });
});

describe('viewFor (a window project)', () => {
  test('hint, mine, labels and order: the project config first, then its containers, then the rest', () => {
    const c = gatherCandidates(base({
      projects: ['/code/acme', '/code/other'],
      env: (root): Record<string, string> => (root === '/code/acme' ? { REDIS_URL: 'redis://127.0.0.1:6380' } : {}),
      containers: [container({})],
      ports: [6379]
    }));
    const v = viewFor(c, '/code/acme');
    expect(v.map((x) => [x.key, x.label, x.hint, x.mine])).toEqual([
      ['tcp:6380', 'Docker · acme-store-redis-1', "this project's .env (REDIS_URL)", true],
      ['tcp:6379', 'local', null, false]
    ]);
    const o = viewFor(c, '/code/other');
    expect(o.map((x) => [x.key, x.hint, x.mine])).toEqual([['tcp:6379', null, false], ['tcp:6380', null, false]]);
  });
});
