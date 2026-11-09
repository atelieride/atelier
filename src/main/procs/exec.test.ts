import { describe, expect, test } from 'vitest';
import { LSOF, PS, PS_ARGS, cwdArgs, descendants, establishedArgs, lsofArgs, parseEstablished, parseCwd, readCwd, parseLsof, parsePsArgs, parsePsGroups, parsePsTree, pgrpArgs, psArgsArgs, readArgs, runProc, validateProcCommand, type ExecFileLike } from './exec';

describe('validateProcCommand', () => {
  test('accepts only the fixed ps and lsof shapes', () => {
    expect(() => validateProcCommand(PS, PS_ARGS)).not.toThrow();
    expect(() => validateProcCommand(LSOF, lsofArgs([1]))).not.toThrow();
    expect(() => validateProcCommand(LSOF, lsofArgs([123, 45678901]))).not.toThrow();
    // minor 8: -b (never block on stat/readlink of a hung mount) and -w (no warnings that -b would print).
    expect(lsofArgs([10, 20])).toEqual(['-b', '-w', '-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p', '10,20', '-F', 'pcn']);
    expect(() => validateProcCommand(LSOF, ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p', '10', '-F', 'pcn'])).toThrow();
    expect(() => validateProcCommand(LSOF, ['-w', '-b', '-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p', '10', '-F', 'pcn'])).toThrow();
  });

  test('refuses other binaries, other paths, extra or changed arguments', () => {
    expect(() => validateProcCommand('ps', PS_ARGS)).toThrow();
    expect(() => validateProcCommand('/usr/bin/ps', PS_ARGS)).toThrow();
    expect(() => validateProcCommand('/bin/sh', ['-c', 'ps'])).toThrow();
    expect(() => validateProcCommand(PS, ['-A', '-o', 'pid=,ppid=,command='])).toThrow();
    expect(() => validateProcCommand(PS, [...PS_ARGS, '-E'])).toThrow();
    expect(() => validateProcCommand(LSOF, ['-nP', '-iTCP'])).toThrow();
    expect(() => validateProcCommand(LSOF, [...lsofArgs([1]), '-b'])).toThrow();
    expect(() => validateProcCommand(LSOF, [...lsofArgs([1]), '+c', '0'])).toThrow();
    expect(() => validateProcCommand(LSOF, lsofArgs([1]).map((a) => (a === 'pcn' ? 'pcnL' : a)))).toThrow();
    expect(() => validateProcCommand(PS, lsofArgs([1]))).toThrow();
  });

  test('pid lists: 1 to 8 digits each, never 0, at most 512, nothing else', () => {
    const withPids = (p: string) => ['-b', '-w', '-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p', p, '-F', 'pcn'];
    for (const bad of ['', '0', '-1', '1,', ',1', '1,,2', '123456789', '1;2', '1 2', '^1', '1,a', '01x']) {
      expect(() => validateProcCommand(LSOF, withPids(bad)), bad).toThrow();
    }
    expect(() => validateProcCommand(LSOF, withPids(Array.from({ length: 512 }, (_, i) => i + 1).join(',')))).not.toThrow();
    expect(() => validateProcCommand(LSOF, withPids(Array.from({ length: 513 }, (_, i) => i + 1).join(',')))).toThrow();
    expect(() => lsofArgs([])).toThrow();
    expect(() => lsofArgs([1.5])).toThrow();
  });
});

describe('established connections form', () => {
  test('one port, ESTABLISHED, given pids; nothing else', () => {
    expect(establishedArgs(6379, [10, 20])).toEqual(['-b', '-w', '-nP', '-a', '-iTCP:6379', '-sTCP:ESTABLISHED', '-p', '10,20', '-F', 'pcn']);
    expect(() => validateProcCommand(LSOF, establishedArgs(6379, [10]))).not.toThrow();
    expect(() => establishedArgs(0, [1])).toThrow();
    expect(() => establishedArgs(70000, [1])).toThrow();
    expect(() => validateProcCommand(LSOF, ['-b', '-w', '-nP', '-a', '-iTCP:6379', '-sTCP:LISTEN', '-p', '10', '-F', 'pcn'])).toThrow();
    expect(() => validateProcCommand(LSOF, ['-b', '-w', '-nP', '-a', '-iTCP:6379;x', '-sTCP:ESTABLISHED', '-p', '10', '-F', 'pcn'])).toThrow();
    expect(() => validateProcCommand(LSOF, ['-b', '-w', '-nP', '-a', '-iTCP@10.0.0.1:6379', '-sTCP:ESTABLISHED', '-p', '10', '-F', 'pcn'])).toThrow();
  });
  test('parseEstablished: the client side of each connection to the port, by local port', () => {
    const out = 'p501\ncnode\nf21\nn127.0.0.1:51234->127.0.0.1:6379\nf22\nn[::1]:51240->[::1]:6379\np502\ncredis-server\nf8\nn127.0.0.1:6379->127.0.0.1:51234\n';
    expect([...parseEstablished(out, 6379)]).toEqual([[51234, 501], [51240, 501]]);
  });
});

describe('ps arguments form', () => {
  test('exactly ps -ww -o pid=,args= -p <pids>: wide output, so long argument lists are never cut', () => {
    expect(psArgsArgs([10, 20])).toEqual(['-ww', '-o', 'pid=,args=', '-p', '10,20']);
    expect(() => validateProcCommand(PS, psArgsArgs([1]))).not.toThrow();
    expect(() => validateProcCommand(PS, psArgsArgs(Array.from({ length: 512 }, (_, i) => i + 1)))).not.toThrow();
  });

  test('anything else throws: extra or changed arguments, bad pids, more than 512', () => {
    const withPids = (p: string) => ['-ww', '-o', 'pid=,args=', '-p', p];
    expect(() => validateProcCommand(PS, ['-o', 'pid=,args=', '-p', '10'])).toThrow();
    expect(() => validateProcCommand(PS, ['-w', '-o', 'pid=,args=', '-p', '10'])).toThrow();
    expect(() => validateProcCommand(PS, [...withPids('10'), '-E'])).toThrow();
    expect(() => validateProcCommand(PS, ['-ww', '-o', 'pid=,args=,user=', '-p', '10'])).toThrow();
    expect(() => validateProcCommand(PS, ['-ww', '-o', 'pid=,command=', '-p', '10'])).toThrow();
    expect(() => validateProcCommand(PS, ['-ww', '-o', 'pid=,args=', '-U', '10'])).toThrow();
    expect(() => validateProcCommand(LSOF, withPids('10'))).toThrow();
    for (const bad of ['', '0', '-1', '1,', ',1', '1,,2', '123456789', '1;2', '1 2', '1,a', 'all']) {
      expect(() => validateProcCommand(PS, withPids(bad)), bad).toThrow();
    }
    expect(() => validateProcCommand(PS, withPids(Array.from({ length: 513 }, (_, i) => i + 1).join(',')))).toThrow();
    expect(() => psArgsArgs([])).toThrow();
    expect(() => psArgsArgs([2.5])).toThrow();
  });

  test('parsePsArgs: one process per line, the pid then the arguments (spaces kept); garbage skipped', () => {
    const out = "  101 /bin/zsh -c source /tmp/snap && eval 'npm run dev -- --port 5173' < /dev/null\n" +
      '  102 node  /x/vite.js   --host\n' +
      'garbage\n\n   0 zero\n  103\n  104 sleep 90  \n';
    expect(parsePsArgs(out)).toEqual([
      { pid: 101, ppid: 0, args: "/bin/zsh -c source /tmp/snap && eval 'npm run dev -- --port 5173' < /dev/null" },
      { pid: 102, ppid: 0, args: 'node  /x/vite.js   --host' },
      { pid: 104, ppid: 0, args: 'sleep 90' }
    ]);
    expect(parsePsArgs('')).toEqual([]);
  });

  test('readArgs: runs the validated form; ps exiting 1 with no output (every pid gone) is no process', async () => {
    const calls: string[][] = [];
    const exec = (code: number, stdout: string, stderr = ''): ExecFileLike => (file, args, _o, cb) => {
      calls.push([file, ...args]);
      cb(code === 0 ? null : Object.assign(new Error('failed'), { code }), stdout, stderr);
    };
    await expect(readArgs([7, 8], exec(0, '  7 sleep 1\n'))).resolves.toEqual([{ pid: 7, ppid: 0, args: 'sleep 1' }]);
    expect(calls[0]).toEqual([PS, '-ww', '-o', 'pid=,args=', '-p', '7,8']);
    await expect(readArgs([9], exec(1, ''))).resolves.toEqual([]);
    await expect(readArgs([9], exec(1, '', 'ps: illegal option'))).rejects.toThrow();
    await expect(readArgs([9], exec(2, ''))).rejects.toThrow();
    // The tree form keeps failing on any error.
    await expect(runProc(PS, PS_ARGS, exec(1, ''))).rejects.toThrow();
    expect(await readArgs([])).toEqual([]);
  });
});

describe('parsePsTree / descendants', () => {
  const out = '    1     0\n  100     1\n  200   100\n  201   100\n  300   200\n  999     1\n garbage line\n\n  400   300\n';

  test('children per parent pid', () => {
    const tree = parsePsTree(out);
    expect(tree.get(100)).toEqual([200, 201]);
    expect(tree.get(200)).toEqual([300]);
    expect(tree.get(300)).toEqual([400]);
    expect(tree.has(400)).toBe(false);
  });

  test('a root and all its descendants (root first); an unknown root is itself only', () => {
    const tree = parsePsTree(out);
    expect(descendants(tree, 100).sort((a, b) => a - b)).toEqual([100, 200, 201, 300, 400]);
    expect(descendants(tree, 100)[0]).toBe(100);
    expect(descendants(tree, 999)).toEqual([999]);
    expect(descendants(tree, 4242)).toEqual([4242]);
  });

  test('a cycle (pid reuse between two reads) never loops', () => {
    const tree = parsePsTree('  10    20\n  20    10\n');
    expect(descendants(tree, 10).sort()).toEqual([10, 20]);
  });
});

describe('parseLsof', () => {
  test('IPv4, IPv6, wildcard; duplicates (v4 + v6 on one port) once; the process name kept', () => {
    const out = 'p55243\ncnode\nf12\nn127.0.0.1:58358\nf13\nn[::1]:58358\nf14\nn*:3000\np600\ncvite\nf20\nn[::1]:5173\n';
    const m = parseLsof(out);
    expect(m.get(55243)).toEqual({ name: 'node', ports: [3000, 58358] });
    expect(m.get(600)).toEqual({ name: 'vite', ports: [5173] });
  });

  test('garbage, other fields and connected sockets are ignored', () => {
    const out = 'hello\np7\ncpython3\nf3\nn127.0.0.1:8000\nn127.0.0.1:8000->127.0.0.1:5555\nnbad\nn*:99999\nn*:0\nn*:abc\nxyz\np\npNaN\nn*:9\n';
    const m = parseLsof(out);
    expect(m.get(7)).toEqual({ name: 'python3', ports: [8000] });
    expect([...m.keys()]).toEqual([7]);
  });

  test('empty output: no ports', () => {
    expect(parseLsof('').size).toBe(0);
  });
});

describe('runProc', () => {
  const fake = (code: number | string | null, stdout: string, stderr = ''): { exec: ExecFileLike; calls: { file: string; args: string[]; opts: Record<string, unknown> }[] } => {
    const calls: { file: string; args: string[]; opts: Record<string, unknown> }[] = [];
    const exec: ExecFileLike = (file, args, opts, cb) => {
      calls.push({ file, args, opts: opts as Record<string, unknown> });
      const err = code === 0 ? null : Object.assign(new Error('failed'), { code });
      cb(err, stdout, stderr);
    };
    return { exec, calls };
  };

  test('runs with a 2 s timeout and a 1 MB cap, never through a shell', async () => {
    const f = fake(0, '1 0\n');
    await expect(runProc(PS, PS_ARGS, f.exec)).resolves.toBe('1 0\n');
    expect(f.calls[0]).toMatchObject({ file: PS, args: PS_ARGS, opts: { timeout: 2000, maxBuffer: 1024 * 1024 } });
    expect(f.calls[0]!.opts.shell).toBeFalsy();
  });

  test('lsof exiting 1 (nothing matched, or a pid gone) is its output, not an error', async () => {
    await expect(runProc(LSOF, lsofArgs([1, 2]), fake(1, 'p1\ncnode\nn*:3000\n').exec)).resolves.toContain('n*:3000');
    await expect(runProc(LSOF, lsofArgs([1]), fake(1, '').exec)).resolves.toBe('');
  });

  test('other failures reject (ps exit 1, timeouts, missing binary); a bad argv never runs', async () => {
    await expect(runProc(PS, PS_ARGS, fake(1, '').exec)).rejects.toThrow();
    await expect(runProc(LSOF, lsofArgs([1]), fake(2, '').exec)).rejects.toThrow();
    await expect(runProc(LSOF, lsofArgs([1]), fake('ENOENT', '').exec)).rejects.toThrow();
    await expect(runProc(LSOF, lsofArgs([1]), fake(null, '').exec)).rejects.toThrow();
    const f = fake(0, '');
    await expect(runProc('/bin/sh', ['-c', 'true'], f.exec)).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
});

describe('a terminal shell\'s current folder (Open in Finder)', () => {
  test('one fixed lsof form for one pid: `lsof -b -w -a -d cwd -p <pid> -F n`', () => {
    expect(cwdArgs(4321)).toEqual(['-b', '-w', '-a', '-d', 'cwd', '-p', '4321', '-F', 'n']);
    expect(() => validateProcCommand(LSOF, cwdArgs(1))).not.toThrow();
    expect(() => cwdArgs(0)).toThrow();
    expect(() => cwdArgs(1.5)).toThrow();
    // One pid only, nothing added or swapped.
    expect(() => validateProcCommand(LSOF, ['-b', '-w', '-a', '-d', 'cwd', '-p', '1,2', '-F', 'n'])).toThrow();
    expect(() => validateProcCommand(LSOF, ['-b', '-w', '-a', '-d', 'txt', '-p', '1', '-F', 'n'])).toThrow();
    expect(() => validateProcCommand(LSOF, ['-b', '-w', '-a', '-d', 'cwd', '-p', '1', '-F', 'pcn'])).toThrow();
    expect(() => validateProcCommand(LSOF, [...cwdArgs(1), '-n'])).toThrow();
  });

  test('parseCwd: the n line of the cwd entry, an absolute path; nothing else', () => {
    expect(parseCwd('p4321\nfcwd\nn/Users/me/repos/atelier/api\n')).toBe('/Users/me/repos/atelier/api');
    expect(parseCwd('p4321\nfcwd\nn/Users/me/a folder with spaces\n')).toBe('/Users/me/a folder with spaces');
    expect(parseCwd('')).toBeNull();
    expect(parseCwd('p1\nnrelative\n')).toBeNull();
  });

  test('readCwd: the shell\'s folder; null when the process is gone', async () => {
    const exec = (code: number, stdout: string): ExecFileLike => (_f, _a, _o, cb) => cb(code === 0 ? null : Object.assign(new Error('x'), { code }), stdout, '');
    await expect(readCwd(7, exec(0, 'p7\nfcwd\nn/tmp/x\n'))).resolves.toBe('/tmp/x');
    await expect(readCwd(7, exec(1, ''))).resolves.toBeNull();
  });
});

test('readCwd runs lsof in a UTF-8 locale: an app opened from the Dock has none, and lsof would escape "città"', async () => {
  let env: Record<string, string | undefined> | undefined;
  const exec: ExecFileLike = (_f, _a, o, cb) => { env = (o as { env?: Record<string, string | undefined> }).env; cb(null, 'p7\nfcwd\nn/tmp/città\n', ''); };
  await expect(readCwd(7, exec)).resolves.toBe('/tmp/città');
  expect(env?.LC_ALL).toBe('en_US.UTF-8');
});

describe('process groups form', () => {
  test('`ps -o pid=,pgid=,tpgid= -p <pids>` only, validated', () => {
    expect(pgrpArgs([10, 20])).toEqual(['-o', 'pid=,pgid=,tpgid=', '-p', '10,20']);
    expect(() => validateProcCommand(PS, pgrpArgs([1]))).not.toThrow();
    expect(() => validateProcCommand(PS, ['-o', 'pid=,pgid=,tpgid=,args=', '-p', '1'])).toThrow();
    expect(() => validateProcCommand(PS, ['-o', 'pid=,pgid=,tpgid=', '-p', '1;2'])).toThrow();
    expect(() => pgrpArgs([])).toThrow();
  });
  test('parsed: pid, pgid, tpgid per line; garbage skipped', () => {
    expect(parsePsGroups(' 100   100   100\n 200   200   250\nbad line\n 300 300\n')).toEqual([{ pid: 100, pgid: 100, tpgid: 100 }, { pid: 200, pgid: 200, tpgid: 250 }]);
  });
  test('none of the pids left: ps exits 1 silently, read as no process', async () => {
    const exec: ExecFileLike = (_f, _a, _o, cb) => cb(Object.assign(new Error('exit 1'), { code: 1 }), '', '');
    await expect(runProc(PS, pgrpArgs([5]), exec)).resolves.toBe('');
  });
});
