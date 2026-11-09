import { describe, expect, test } from 'vitest';
import {
  containerFromInspect, cpuPercent, crashKind, detailFromInspect, dotOf, engineName, groupContainers, isSecretKey, isStopExit,
  dfSummary, eventEntry, loopbackHint, maskValue, memoryOf, netTotals, serviceBlock, serviceLine, sortForList, type DockerContainer
} from './docker';

const inspect = (over: Record<string, unknown> = {}) => ({
  Id: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6abcd',
  Name: '/acme-store-api-1',
  Created: '2026-10-15T07:39:57.123Z',
  RestartCount: 0,
  State: { Status: 'running', Running: true, Paused: false, Restarting: false, OOMKilled: false, Dead: false, ExitCode: 0, Error: '', StartedAt: '2026-10-15T07:39:58.000Z', FinishedAt: '0001-01-01T00:00:00Z', Health: { Status: 'healthy', FailingStreak: 0, Log: [] } },
  Image: 'sha256:3f1c9a0000000000000000000000000000000000000000000000000000000000',
  Config: {
    Image: 'acme/api:dev', Tty: false, Env: ['NODE_ENV=development', 'REDIS_URL=redis://127.0.0.1:6379'], Cmd: ['node', 'dist/server.js'], Entrypoint: null, WorkingDir: '/app',
    ExposedPorts: { '3000/tcp': {} },
    Labels: { 'com.docker.compose.project': 'acme-store', 'com.docker.compose.service': 'api', 'com.docker.compose.project.working_dir': '/Users/me/code/acme-store', 'com.docker.compose.project.config_files': '/Users/me/code/acme-store/compose.yml,/Users/me/code/acme-store/compose.override.yml' }
  },
  HostConfig: { RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 }, NetworkMode: 'acme-store_default' },
  NetworkSettings: {
    Ports: { '3000/tcp': [{ HostIp: '0.0.0.0', HostPort: '3000' }, { HostIp: '::', HostPort: '3000' }], '9229/tcp': null },
    Networks: { 'acme-store_default': { IPAddress: '172.19.0.4', Aliases: ['acme-store-api-1', 'api'] } }
  },
  Mounts: [
    { Type: 'bind', Source: '/Users/me/code/acme-store/src', Destination: '/app/src', RW: true },
    { Type: 'volume', Name: 'acme_node_modules', Source: '/var/lib/docker/volumes/acme_node_modules/_data', Destination: '/app/node_modules', RW: true }
  ],
  ...over
});

describe('containerFromInspect', () => {
  test('a composed, healthy, running container', () => {
    const c = containerFromInspect(inspect())!;
    expect(c).toMatchObject({
      id: inspect().Id, name: 'api', containerName: 'acme-store-api-1', project: 'acme-store', service: 'api',
      workingDir: '/Users/me/code/acme-store', configFiles: ['/Users/me/code/acme-store/compose.yml', '/Users/me/code/acme-store/compose.override.yml'],
      image: 'acme/api:dev', state: 'running', health: 'healthy', exitCode: null, restarts: 0, tty: false, oomKilled: false,
      restartPolicy: 'unless-stopped', exposed: [3000, 9229]
    });
    // Published once though bound on v4 and v6; an unpublished exposed port is not listed.
    expect(c.ports).toEqual([{ host: 3000, container: 3000, proto: 'tcp' }]);
    // Bound to one address of this machine: that address (every address — 0.0.0.0, :: or none — says nothing).
    const bound = containerFromInspect(inspect({
      NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '192.168.1.20', HostPort: '5433' }], '6379/tcp': [{ HostIp: '127.0.0.1', HostPort: '6380' }], '80/tcp': [{ HostIp: '', HostPort: '8080' }] }, Networks: {} }
    }))!;
    expect(bound.ports).toEqual([{ host: 5433, container: 5432, proto: 'tcp', ip: '192.168.1.20' }, { host: 6380, container: 6379, proto: 'tcp', ip: '127.0.0.1' }, { host: 8080, container: 80, proto: 'tcp' }]);
    expect(c.startedAt).toBe(Date.parse('2026-10-15T07:39:58.000Z'));
    expect(c.finishedAt).toBeNull();
  });

  test('a standalone exited container: its own name, the exit code and the finish time', () => {
    const c = containerFromInspect(inspect({
      Name: '/localstack', RestartCount: 3,
      State: { Status: 'exited', Running: false, ExitCode: 1, OOMKilled: false, StartedAt: '2026-10-15T07:40:33.000Z', FinishedAt: '2026-10-15T07:40:33.290Z' },
      Config: { Image: 'localstack/localstack', Labels: {}, Tty: true }
    }))!;
    expect(c).toMatchObject({ name: 'localstack', project: null, service: null, workingDir: null, configFiles: [], state: 'exited', health: null, exitCode: 1, restarts: 3, tty: true });
    expect(c.finishedAt).toBe(Date.parse('2026-10-15T07:40:33.290Z'));
  });

  test('garbage is refused', () => {
    expect(containerFromInspect(null)).toBeNull();
    expect(containerFromInspect({ Id: 'not-hex' })).toBeNull();
    expect(containerFromInspect({ Id: 'a'.repeat(64), Name: 5 })).toBeNull();
  });

  test('a health status Docker may add later reads as none', () => {
    expect(containerFromInspect(inspect({ State: { Status: 'running', Health: { Status: 'weird' } } }))!.health).toBeNull();
  });
});

describe('detailFromInspect', () => {
  test('env, command, mounts, networks, health log, restart policy', () => {
    const d = detailFromInspect(inspect({
      State: { Status: 'running', Health: { Status: 'healthy', Log: [{ Start: '2026-10-15T07:41:00Z', End: '2026-10-15T07:41:01Z', ExitCode: 0, Output: 'ok\n' }] } }
    }))!;
    expect(d.env).toEqual([{ key: 'NODE_ENV', value: 'development' }, { key: 'REDIS_URL', value: 'redis://127.0.0.1:6379' }]);
    expect(d.command).toBe('node dist/server.js');
    expect(d.workingDir).toBe('/app');
    expect(d.imageId).toBe('sha256:3f1c9a0000000000000000000000000000000000000000000000000000000000');
    expect(d.mounts).toEqual([
      { type: 'bind', name: null, source: '/Users/me/code/acme-store/src', target: '/app/src', rw: true },
      { type: 'volume', name: 'acme_node_modules', source: '/var/lib/docker/volumes/acme_node_modules/_data', target: '/app/node_modules', rw: true }
    ]);
    expect(d.networks).toEqual([{ name: 'acme-store_default', ip: '172.19.0.4', aliases: ['acme-store-api-1', 'api'] }]);
    expect(d.healthLog).toEqual([{ at: Date.parse('2026-10-15T07:41:01Z'), exitCode: 0, output: 'ok' }]);
    expect(d.restartPolicy).toEqual({ name: 'unless-stopped', max: 0 });
    expect(d.hostNetwork).toBe(false);
    expect(d.error).toBe('');
  });

  test('an env entry without "=" is a key with an empty value', () => {
    expect(detailFromInspect(inspect({ Config: { Env: ['FLAG'], Labels: {} } }))!.env).toEqual([{ key: 'FLAG', value: '' }]);
  });
});

describe('dotOf: the row dot', () => {
  const c = (over: Partial<DockerContainer>): DockerContainer => ({ ...containerFromInspect(inspect())!, ...over });
  test.each([
    [{ state: 'running', health: 'healthy' }, 'ok'],
    [{ state: 'running', health: null }, 'ok'],
    [{ state: 'running', health: 'starting' }, 'warn'],
    [{ state: 'restarting' }, 'warn'],
    [{ state: 'paused' }, 'warn'],
    [{ state: 'running', health: 'unhealthy' }, 'err'],
    [{ state: 'exited', exitCode: 1 }, 'err'],
    [{ state: 'dead', exitCode: 0 }, 'err'],
    [{ state: 'exited', exitCode: 0 }, 'off'],
    // Stopped by a signal (docker stop, Ctrl-C): not a failure.
    [{ state: 'exited', exitCode: 143 }, 'off'],
    [{ state: 'exited', exitCode: 137 }, 'off'],
    [{ state: 'exited', exitCode: 137, oomKilled: true }, 'err'],
    [{ state: 'created' }, 'off']
  ] as [Partial<DockerContainer>, string][])('%o → %s', (over, dot) => {
    expect(dotOf(c(over))).toBe(dot);
  });
  test('stop exits', () => {
    expect([0, 130, 137, 143].every(isStopExit)).toBe(true);
    expect(isStopExit(1)).toBe(false);
  });
});

describe('groupContainers', () => {
  const base = containerFromInspect(inspect())!;
  const mk = (name: string, project: string | null, dir: string | null, over: Partial<DockerContainer> = {}): DockerContainer =>
    ({ ...base, id: name.padEnd(64, '0').replace(/[^0-9a-f]/g, 'a').slice(0, 64), name, containerName: name, project, service: project ? name : null, workingDir: dir, ...over });
  const root = { root: '/Users/me/code/acme-store', realRoot: '/Users/me/code/acme-store' };

  test('this project first (root and subfolders), then other compose projects, then standalone', () => {
    const list = [
      mk('db', 'billing', '/Users/me/code/billing', { state: 'exited', exitCode: 0 }),
      mk('api', 'acme-store', '/Users/me/code/acme-store'),
      mk('localstack', null, null),
      mk('infra-db', 'acme-infra', '/Users/me/code/acme-store/infra'),
      mk('web', 'acme-store', '/Users/me/code/acme-store')
    ];
    const g = groupContainers(list, root, true);
    expect(g.mine.map((x) => [x.project, x.containers.map((c) => c.name)])).toEqual([['acme-store', ['api', 'web']], ['acme-infra', ['infra-db']]]);
    expect(g.others.map((x) => [x.project, x.running, x.total])).toEqual([['billing', 0, 1]]);
    expect(g.standalone.map((c) => c.name)).toEqual(['localstack']);
  });

  test('a sibling folder sharing a prefix is not this project; the real root counts too', () => {
    const list = [mk('a', 'p', '/Users/me/code/acme-store-old'), mk('b', 'q', '/private/var/acme')];
    const g = groupContainers(list, { root: '/var/acme', realRoot: '/private/var/acme' }, true);
    expect(g.mine.map((x) => x.project)).toEqual(['q']);
    expect(g.others.map((x) => x.project)).toEqual(['p']);
  });

  test('others hidden when the setting is off', () => {
    const g = groupContainers([mk('x', 'p', '/elsewhere'), mk('y', null, null)], root, false);
    expect(g.others).toEqual([]);
    expect(g.standalone).toEqual([]);
  });

  test('order inside a group: problems first, then by name', () => {
    const list = [mk('web', 'acme-store', root.root), mk('worker', 'acme-store', root.root, { state: 'exited', exitCode: 1 }), mk('api', 'acme-store', root.root)];
    expect(sortForList(list).map((c) => c.name)).toEqual(['worker', 'api', 'web']);
  });
});

describe('crashKind: what a stop means for notifications', () => {
  test('exit ≠ 0 without a kill before it is a crash; OOM is one too', () => {
    expect(crashKind({ exitCode: 1, killed: false, oom: false })).toBe('crash');
    expect(crashKind({ exitCode: 137, killed: false, oom: true })).toBe('oom');
    expect(crashKind({ exitCode: 137, killed: false, oom: false })).toBe('crash');
  });
  test('a kill (docker stop, compose down) or exit 0 is not', () => {
    expect(crashKind({ exitCode: 143, killed: true, oom: false })).toBeNull();
    expect(crashKind({ exitCode: 0, killed: false, oom: false })).toBeNull();
  });
});

describe('stats formulas', () => {
  const sample = (total: number, system: number, over: Record<string, unknown> = {}) => ({
    cpu_stats: { cpu_usage: { total_usage: total }, system_cpu_usage: system, online_cpus: 4 },
    precpu_stats: { cpu_usage: { total_usage: 1_000_000 }, system_cpu_usage: 100_000_000 },
    memory_stats: { usage: 200 * 1024 * 1024, limit: 2 * 1024 * 1024 * 1024, stats: { inactive_file: 18 * 1024 * 1024 } },
    networks: { eth0: { rx_bytes: 1000, tx_bytes: 500 }, eth1: { rx_bytes: 24, tx_bytes: 12 } },
    pids_stats: { current: 23 },
    ...over
  });
  test('CPU % over all cores', () => {
    // 3.1M of 100M system time on 4 CPUs → 12.4 %.
    expect(cpuPercent(sample(4_100_000, 200_000_000))).toBeCloseTo(12.4, 5);
  });
  test('CPU % is 0 on the first sample or a counter reset', () => {
    expect(cpuPercent(sample(4_100_000, 100_000_000))).toBe(0);
    expect(cpuPercent({})).toBe(0);
  });
  test('memory without the page cache (cgroup v2, then v1)', () => {
    expect(memoryOf(sample(0, 0))).toEqual({ used: 182 * 1024 * 1024, limit: 2 * 1024 * 1024 * 1024 });
    expect(memoryOf(sample(0, 0, { memory_stats: { usage: 100, limit: 1000, stats: { total_inactive_file: 40 } } }))).toEqual({ used: 60, limit: 1000 });
    expect(memoryOf({})).toEqual({ used: 0, limit: 0 });
  });
  test('network totals over every interface', () => {
    expect(netTotals(sample(0, 0))).toEqual({ rx: 1024, tx: 512 });
  });
});

describe('secrets in env', () => {
  test.each(['JWT_SECRET', 'API_TOKEN', 'DB_PASSWORD', 'PGPASSWORD', 'MYSQL_PWD', 'STRIPE_KEY', 'AWS_SECRET_ACCESS_KEY', 'GOOGLE_CREDENTIALS', 'AUTH_HEADER', 'PRIVATE_KEY_PATH', 'PASSWORD_SALT', 'api_key'])('%s is secret', (k) => {
    expect(isSecretKey(k)).toBe(true);
  });
  test.each(['NODE_ENV', 'PORT', 'LOG_LEVEL', 'KEYBOARD_LAYOUT', 'MONKEY', 'TZ', 'PATH'])('%s is not', (k) => {
    expect(isSecretKey(k)).toBe(false);
  });
  test('a secret key masks the whole value', () => {
    expect(maskValue('JWT_SECRET', 'abc')).toEqual([{ text: 'abc', secret: true }]);
  });
  test('a URL password is masked, the rest stays', () => {
    expect(maskValue('DATABASE_URL', 'postgres://acme:hunter2@postgres:5432/acme')).toEqual([
      { text: 'postgres://acme:', secret: false }, { text: 'hunter2', secret: true }, { text: '@postgres:5432/acme', secret: false }
    ]);
  });
  test('a password holding "@" is masked whole, up to the host', () => {
    expect(maskValue('DATABASE_URL', 'postgres://u:p@ss@db:5432/x')).toEqual([
      { text: 'postgres://u:', secret: false }, { text: 'p@ss', secret: true }, { text: '@db:5432/x', secret: false }
    ]);
  });
  test('a plain value is one clear part; an empty secret is no part to reveal', () => {
    expect(maskValue('NODE_ENV', 'development')).toEqual([{ text: 'development', secret: false }]);
    expect(maskValue('JWT_SECRET', '')).toEqual([]);
  });
});

describe('loopbackHint', () => {
  const services = [{ name: 'redis', exposed: [6379] }, { name: 'postgres', exposed: [5432] }, { name: 'worker', exposed: [] }];
  test('localhost with a port another service exposes: the suggestion', () => {
    expect(loopbackHint('redis://127.0.0.1:6379', false, services, 'worker')).toEqual({ host: '127.0.0.1', port: 6379, suggestion: 'redis:6379' });
    expect(loopbackHint('localhost:5432', false, services, 'worker')).toEqual({ host: 'localhost', port: 5432, suggestion: 'postgres:5432' });
  });
  test('a URL without a port takes its scheme default', () => {
    expect(loopbackHint('redis://localhost', false, services, 'worker')).toEqual({ host: 'localhost', port: 6379, suggestion: 'redis:6379' });
  });
  test('no service for that port: the note without a suggestion', () => {
    expect(loopbackHint('http://localhost:8080/x', false, services, 'worker')).toEqual({ host: 'localhost', port: 8080, suggestion: null });
  });
  test('0.0.0.0 as a listen address (HOST=0.0.0.0) is right in a container: no hint; in a URL it is', () => {
    expect(loopbackHint('0.0.0.0', false, services, 'worker', 'HOST')).toBeNull();
    expect(loopbackHint('0.0.0.0:3000', false, services, 'worker', 'BIND_ADDRESS')).toBeNull();
    expect(loopbackHint('localhost', false, services, 'worker', 'LISTEN_HOST')).toBeNull();
    expect(loopbackHint('http://0.0.0.0:5432', false, services, 'worker', 'DB_URL')).toEqual({ host: '0.0.0.0', port: 5432, suggestion: 'postgres:5432' });
  });
  test('host networking, the service itself, or no loopback: nothing', () => {
    expect(loopbackHint('redis://127.0.0.1:6379', true, services, 'worker')).toBeNull();
    expect(loopbackHint('redis://127.0.0.1:6379', false, services, 'redis')).toEqual({ host: '127.0.0.1', port: 6379, suggestion: null });
    expect(loopbackHint('redis://redis:6379', false, services, 'worker')).toBeNull();
    expect(loopbackHint('localhostname', false, services, 'worker')).toBeNull();
  });
});

describe('serviceLine: where a service is defined in a compose file', () => {
  const yml = ['name: acme', 'x-common: &common', '  restart: unless-stopped', 'services:', '  api:', '    image: acme/api', '  # worker:', '  worker:', '    <<: *common', 'volumes:', '  worker:', ''].join('\n');
  test('the line of the service key under services:', () => {
    expect(serviceLine(yml, 'api')).toBe(5);
    expect(serviceLine(yml, 'worker')).toBe(8);
  });
  test('quoted keys and CRLF', () => {
    expect(serviceLine('services:\r\n  "web":\r\n    image: x\r\n', 'web')).toBe(2);
  });
  test('serviceBlock: the service with its body, up to the next service or top-level key', () => {
    expect(serviceBlock(yml, 'api')).toBe('  api:\n    image: acme/api');
    expect(serviceBlock(yml, 'worker')).toBe('  worker:\n    <<: *common');
    expect(serviceBlock(yml, 'redis')).toBeNull();
    const long = `services:\n  big:\n${Array.from({ length: 200 }, (_, i) => `    k${i}: v`).join('\n')}\n`;
    expect(serviceBlock(long, 'big')!.split('\n')).toHaveLength(80);
  });
  test('missing: null', () => {
    expect(serviceLine(yml, 'redis')).toBeNull();
    expect(serviceLine('volumes:\n  api:\n', 'api')).toBeNull();
  });
});

describe('engineName', () => {
  test('from /version and /info, then the socket path', () => {
    expect(engineName({ Platform: { Name: 'Docker Desktop 4.36.0 (175267)' } }, {}, '/x')).toBe('Docker Desktop');
    expect(engineName({}, { OperatingSystem: 'OrbStack' }, '/x')).toBe('OrbStack');
    expect(engineName({}, { Name: 'colima' }, '/x')).toBe('Colima');
    expect(engineName({}, { Name: 'lima-rancher-desktop' }, '/x')).toBe('Rancher Desktop');
    expect(engineName({}, {}, '/Users/me/.orbstack/run/docker.sock')).toBe('OrbStack');
    expect(engineName({}, {}, '/Users/me/.colima/default/docker.sock')).toBe('Colima');
    expect(engineName({}, {}, '/Users/me/.rd/docker.sock')).toBe('Rancher Desktop');
    expect(engineName({}, {}, '/Users/me/.docker/run/docker.sock')).toBe('Docker Desktop');
    expect(engineName({}, {}, '/var/run/docker.sock')).toBe('Docker');
  });
});

describe('dfSummary: GET /system/df in four numbers', () => {
  test('images, build cache, volumes, containers; reclaimable', () => {
    const df = {
      LayersSize: 12_400_000_000,
      Images: [{ Id: 'a', Size: 9e9, SharedSize: 0, Containers: 2, RepoTags: ['acme/api:dev'] }, { Id: 'b', Size: 3.4e9, Containers: 0, RepoTags: ['<none>:<none>'] }, { Id: 'c', Size: 1, Containers: 0, RepoTags: null }],
      Containers: [{ Id: 'x', SizeRw: 2e8, State: 'running' }, { Id: 'y', SizeRw: 2e7, State: 'exited' }],
      Volumes: [{ Name: 'v1', UsageData: { Size: 4e8, RefCount: 1 } }, { Name: 'v2', UsageData: { Size: 3.4e9, RefCount: 0 } }],
      BuildCache: [{ Size: 6e9, InUse: false }, { Size: 1e8, InUse: true }]
    };
    expect(dfSummary(df)).toEqual({
      images: { size: 12_400_000_000, count: 3, dangling: 2, reclaimable: 3.4e9 + 1 },
      buildCache: { size: 6.1e9, reclaimable: 6e9 },
      volumes: { size: 3.8e9, count: 2, unused: 1, reclaimable: 3.4e9 },
      containers: { size: 2.2e8, count: 2, stopped: 1, reclaimable: 2e7 }
    });
  });
  test('an empty or odd reply is zeros', () => {
    expect(dfSummary({})).toEqual({ images: { size: 0, count: 0, dangling: 0, reclaimable: 0 }, buildCache: { size: 0, reclaimable: 0 }, volumes: { size: 0, count: 0, unused: 0, reclaimable: 0 }, containers: { size: 0, count: 0, stopped: 0, reclaimable: 0 } });
  });
});

describe('eventEntry: what the overview lists', () => {
  const ev = (Type: string, Action: string, Attributes: Record<string, string> = {}) => ({ Type, Action, Actor: { ID: 'abc', Attributes }, timeNano: 1_760_000_000_123_000_000 });
  test('container lifecycle with its detail', () => {
    expect(eventEntry(ev('container', 'die', { name: 'acme-worker-1', exitCode: '1' }))).toEqual({ at: 1_760_000_000_123, type: 'container', action: 'die', name: 'acme-worker-1', detail: 'exit 1', id: 'abc' });
    expect(eventEntry(ev('container', 'health_status: unhealthy', { name: 'api' }))).toMatchObject({ action: 'health', detail: 'unhealthy' });
    expect(eventEntry(ev('container', 'start', { name: 'web', image: 'node:22' }))).toMatchObject({ action: 'start', detail: 'node:22' });
  });
  test('images, volumes, networks', () => {
    expect(eventEntry(ev('image', 'pull', { name: 'redis:7' }))).toMatchObject({ type: 'image', action: 'pull', name: 'redis:7' });
    expect(eventEntry(ev('volume', 'create', {}))).toMatchObject({ type: 'volume', name: 'abc' });
    expect(eventEntry(ev('network', 'create', { name: 'acme_default' }))).toMatchObject({ name: 'acme_default' });
  });
  test('noise is dropped: exec (health checks), attach, resize, volume mounts, network connects', () => {
    for (const [ty, a] of [['container', 'exec_start: redis-cli ping'], ['container', 'exec_die'], ['container', 'attach'], ['container', 'resize'], ['container', 'top'], ['volume', 'mount'], ['network', 'connect'], ['network', 'disconnect'], ['container', 'archive-path']]) {
      expect(eventEntry(ev(ty!, a!))).toBeNull();
    }
    expect(eventEntry({})).toBeNull();
  });
});
