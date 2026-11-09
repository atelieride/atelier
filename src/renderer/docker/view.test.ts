import { describe, expect, test } from 'vitest';
import type { DockerContainer, DockerDetail } from '@shared/docker';
import type { DockerLogLine } from '@shared/docker-logs';
import { crashPrompt, dockerShown, filterLines, fmtBytes, fmtRate, fmtUptime, levelCounts, logsPrompt, mergeStack, shortImage, stackLabels, stateText, subline, svcColor, terminalPorts, tildePath } from './view';

const base: DockerContainer = {
  id: 'a'.repeat(64), name: 'api', containerName: 'acme-api-1', project: 'acme', service: 'api', workingDir: '/w', configFiles: ['/w/compose.yml'],
  image: 'ghcr.io/acme/api:dev', state: 'running', health: 'healthy', exitCode: null, restarts: 0, startedAt: 0, finishedAt: null,
  ports: [{ host: 3000, container: 3000, proto: 'tcp' }], exposed: [3000], tty: false, oomKilled: false, restartPolicy: 'unless-stopped'
};
const c = (over: Partial<DockerContainer>): DockerContainer => ({ ...base, ...over });
const L = (seq: number, text: string, at: number | null = seq * 1000, err = false): DockerLogLine => ({ seq, at, err, text });

test('dockerShown: Always, Never, Auto (an engine of any state but absent)', () => {
  expect(dockerShown('always', 'absent')).toBe(true);
  expect(dockerShown('never', 'running')).toBe(false);
  expect(dockerShown('auto', 'absent')).toBe(false);
  for (const s of ['stopped', 'denied', 'unsupported', 'running'] as const) expect(dockerShown('auto', s)).toBe(true);
});

describe('formats', () => {
  test('bytes and rates', () => {
    expect(fmtBytes(0)).toBe('0 B');
    expect(fmtBytes(912)).toBe('912 B');
    expect(fmtBytes(18 * 1024 * 1024)).toBe('18 MB');
    expect(fmtBytes(182.4 * 1024 * 1024)).toBe('182 MB');
    expect(fmtBytes(2 * 1024 ** 3)).toBe('2 GB');
    expect(fmtBytes(12.4e9)).toBe('11.5 GB');
    expect(fmtRate(1.2 * 1024 * 1024)).toBe('1.2 MB/s');
    expect(fmtRate(840 * 1024)).toBe('840 KB/s');
    expect(fmtRate(0)).toBe('0 B/s');
  });
  test('uptime', () => {
    expect(fmtUptime(45_000)).toBe('45s');
    expect(fmtUptime(12 * 60_000)).toBe('12m');
    expect(fmtUptime((3 * 60 + 12) * 60_000)).toBe('3h 12m');
    expect(fmtUptime(2 * 86_400_000 + 3_600_000)).toBe('2d 1h');
  });
  test('tildePath', () => {
    expect(tildePath('/Users/me/.orbstack/run/docker.sock')).toBe('~/.orbstack/run/docker.sock');
    expect(tildePath('/Users/me')).toBe('~');
    expect(tildePath('/var/run/docker.sock')).toBe('/var/run/docker.sock');
  });
  test('short image: no registry, the tag kept', () => {
    expect(shortImage('ghcr.io/acme/api:dev')).toBe('acme/api:dev');
    expect(shortImage('docker.io/library/postgres:16-alpine')).toBe('postgres:16-alpine');
    expect(shortImage('redis:7')).toBe('redis:7');
    expect(shortImage('localhost:5000/app')).toBe('app');
    expect(shortImage('sha256:abcdef0123456789abcdef')).toBe('sha256:abcdef012345');
  });
});

describe('stateText and subline', () => {
  const now = 10 * 3_600_000;
  test.each([
    [{ health: 'healthy', startedAt: now - (3 * 60 + 12) * 60_000 }, 'Healthy · up 3h 12m'],
    [{ health: null, startedAt: now - 60_000 }, 'Running · up 1m'],
    [{ health: 'unhealthy', startedAt: now - 60_000 }, 'Unhealthy · up 1m'],
    [{ health: 'starting', startedAt: now - 20_000 }, 'Starting · up 20s'],
    [{ state: 'exited', exitCode: 1, finishedAt: now - 120_000 }, 'Exited (1) · 2 min ago'],
    [{ state: 'exited', exitCode: 0, finishedAt: now - 3 * 86_400_000 }, 'Stopped · 3 days ago'],
    [{ state: 'exited', exitCode: 137, oomKilled: true, finishedAt: now - 1000 }, 'Out of memory · just now'],
    [{ state: 'restarting' }, 'Restarting'],
    [{ state: 'paused' }, 'Paused'],
    [{ state: 'created' }, 'Created'],
    [{ state: 'dead', exitCode: 1 }, 'Dead']
  ] as [Partial<DockerContainer>, string][])('%o → %s', (over, text) => {
    expect(stateText(c(over), now)).toBe(text);
  });
  test('subline', () => {
    expect(subline(c({}), now)).toBe('acme/api:dev · :3000');
    expect(subline(c({ ports: [] }), now)).toBe('acme/api:dev');
    expect(subline(c({ state: 'exited', exitCode: 1, finishedAt: now - 120_000 }), now)).toBe('exited (1) · 2m ago');
    expect(subline(c({ state: 'exited', exitCode: 0, finishedAt: now - 3_600_000 }), now)).toBe('stopped · 1h ago');
  });
});

describe('mergeStack: the whole stack, in time order, each line tagged', () => {
  test('interleaved by time; a line without a time stays after the one before it', () => {
    const merged = mergeStack([
      { id: 'i-api', name: 'api', lines: [L(1, 'a1', 1000), L(2, '  at x', null), L(3, 'a3', 5000)] },
      { id: 'i-redis', name: 'redis', lines: [L(1, 'r1', 2000), L(2, 'r2', 6000)] }
    ]);
    expect(merged.map((l) => `${l.svc}:${l.text}`)).toEqual(['api:a1', 'api:  at x', 'redis:r1', 'api:a3', 'redis:r2']);
    expect(new Set(merged.map((l) => l.key)).size).toBe(5);
  });
  test('scaled replicas of one service: unique keys, each tagged with its replica', () => {
    const merged = mergeStack([
      { id: 'a', name: 'worker-1', lines: [L(1, 'x', 1000)] },
      { id: 'b', name: 'worker-2', lines: [L(1, 'y', 2000)] }
    ]);
    expect(merged.map((l) => [l.svc, l.key, l.cid])).toEqual([['worker-1', 'a:1', 'a'], ['worker-2', 'b:1', 'b']]);
  });
  test('stackLabels: the service, or service-N when replicas share it', () => {
    expect(stackLabels([c({ id: 'a', name: 'api', containerName: 'p-api-1' }), c({ id: 'b', name: 'worker', containerName: 'p-worker-1' }), c({ id: 'c', name: 'worker', containerName: 'p-worker-2' })]))
      .toEqual({ a: 'api', b: 'worker-1', c: 'worker-2' });
  });
});

describe('filterLines and levelCounts', () => {
  const lines = [L(1, 'INFO up'), L(2, 'WARN slow'), L(3, 'Error: boom'), L(4, '    at a (x.ts:1:1)'), L(5, 'GET /x 200 3 ms'), L(6, 'POST /y 500 3 ms')];
  test('counts (frames are not counted)', () => {
    expect(levelCounts(lines)).toEqual({ warn: 1, err: 2 });
  });
  test('errors keep their frames; warnings are warnings only (as their count says)', () => {
    expect(filterLines(lines, 'err', '').map((l) => l.seq)).toEqual([3, 4, 6]);
    expect(filterLines(lines, 'warn', '').map((l) => l.seq)).toEqual([2]);
  });
  test('text and /regex/ filters (case-insensitive); a bad regex is plain text', () => {
    expect(filterLines(lines, 'all', 'SLOW').map((l) => l.seq)).toEqual([2]);
    expect(filterLines(lines, 'all', '/^(get|post)/').map((l) => l.seq)).toEqual([5, 6]);
    expect(filterLines([L(1, 'a[b'), L(2, 'ab')], 'all', '/a[b/').map((l) => l.seq)).toEqual([]);
    expect(filterLines([L(1, 'x /a[b/ y'), L(2, 'ab')], 'all', '/a[b/').map((l) => l.seq)).toEqual([1]);
  });
});

describe('terminalPorts: a terminal running docker compose in a compose project\'s folder', () => {
  const list = [
    c({ name: 'api', workingDir: '/w', ports: [{ host: 3000, container: 3000, proto: 'tcp' }] }),
    c({ id: 'b'.repeat(64), name: 'db', workingDir: '/w', ports: [{ host: 5432, container: 5432, proto: 'tcp' }, { host: 9999, container: 9999, proto: 'udp' }] }),
    c({ id: 'c'.repeat(64), name: 'old', workingDir: '/w', state: 'exited', exitCode: 0, ports: [{ host: 8080, container: 80, proto: 'tcp' }] }),
    c({ id: 'd'.repeat(64), name: 'x', workingDir: '/other', ports: [{ host: 4000, container: 4000, proto: 'tcp' }] })
  ];
  test('docker in front, in that folder: its running containers\' tcp ports', () => {
    expect(terminalPorts({ foreground: 'docker', cwd: '/w' }, list)).toEqual([{ name: 'api', port: 3000 }, { name: 'db', port: 5432 }]);
    expect(terminalPorts({ foreground: '/usr/local/bin/docker-compose', cwd: '/w/' }, list)).toHaveLength(2);
  });
  test('the real path of the project folder counts as the folder', () => {
    expect(terminalPorts({ foreground: 'docker', cwd: '/private/w' }, list, { root: '/w', realRoot: '/private/w' })).toHaveLength(2);
    expect(terminalPorts({ foreground: 'docker', cwd: '/private/w' }, list)).toEqual([]);
  });
  test('anything else: none', () => {
    expect(terminalPorts({ foreground: 'zsh', cwd: '/w' }, list)).toEqual([]);
    expect(terminalPorts({ foreground: 'docker', cwd: '/elsewhere' }, list)).toEqual([]);
  });
});

test('svcColor: stable per service in a stack, cycling the palette', () => {
  const names = ['web', 'api', 'redis'];
  expect(svcColor('api', names)).toBe(0);
  expect(svcColor('redis', names)).toBe(1);
  expect(svcColor('web', names)).toBe(2);
  expect(svcColor('zzz', names)).toBe(0);
});

describe('prompts for Claude: context, lines, secrets never', () => {
  test('logsPrompt', () => {
    const p = logsPrompt(c({}), ['Error: jwt expired eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij', '    at verify (src/auth/session.ts:42:11)']);
    expect(p).toContain('Docker container `api` (compose service `api` of project `acme`, image `ghcr.io/acme/api:dev`)');
    expect(p).toContain('```\nError: jwt expired …\n    at verify (src/auth/session.ts:42:11)\n```');
    expect(p).not.toContain('eyJhbGci');
  });
  test('crashPrompt: state, env masked, compose block, last lines', () => {
    const detail = { env: [{ key: 'REDIS_URL', value: 'redis://127.0.0.1:6379' }, { key: 'JWT_SECRET', value: 'hunter2' }, { key: 'DATABASE_URL', value: 'postgres://u:pw@db/x' }], restartPolicy: { name: 'on-failure', max: 3 }, error: '' } as unknown as DockerDetail;
    const p = crashPrompt(c({ state: 'exited', exitCode: 1, restarts: 3 }), detail, ['boom'], '  worker:\n    image: acme/api:dev');
    expect(p).toContain('It exited with code 1 after 3 restarts (restart policy on-failure:3).');
    expect(p).toContain('REDIS_URL=redis://127.0.0.1:6379');
    expect(p).toContain('JWT_SECRET=••••••••');
    expect(p).toContain('DATABASE_URL=postgres://u:••••••••@db/x');
    expect(p).not.toContain('hunter2');
    expect(p).toContain('```yaml\n  worker:\n    image: acme/api:dev\n```');
    expect(p).toContain('Why did it stop, and how do I fix it?');
  });
  test('crashPrompt: secrets never reach Claude, from the compose file or under an innocent key', () => {
    const detail = { env: [{ key: 'STRIPE', value: 'sk_live_0123456789abcdefghij' }, { key: 'GH', value: 'ghp_0123456789abcdefghij0123456789' }], restartPolicy: { name: 'no', max: 0 }, error: '' } as unknown as DockerDetail;
    const block = ['  worker:', '    environment:', '      POSTGRES_PASSWORD: hunter2', '      - API_TOKEN=abc123', '      DATABASE_URL: postgres://u:pw@db/x', '      LOG_LEVEL: info'].join('\n');
    const p = crashPrompt(c({ state: 'exited', exitCode: 1 }), detail, [], block);
    for (const secret of ['hunter2', 'abc123', ':pw@', 'sk_live_0123', 'ghp_0123']) expect(p).not.toContain(secret);
    expect(p).toContain('POSTGRES_PASSWORD: ••••••••');
    expect(p).toContain('- API_TOKEN=••••••••');
    expect(p).toContain('DATABASE_URL: postgres://u:••••••••@db/x');
    expect(p).toContain('LOG_LEVEL: info');
  });
});
