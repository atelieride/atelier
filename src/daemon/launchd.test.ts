import { describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Launchd, homeHash, jobLabel, jobPlist, parseLaunchctlList } from './launchd';

// launchd jobs for atelierd and each terminal.

describe('labels', () => {
  test('carry the kind and a hash of ATELIER_HOME, so a test home never names the user\'s real jobs', () => {
    const real = jobLabel('session', '/Users/u/Library/Application Support/Atelier', 'abc');
    const test = jobLabel('session', '/tmp/atl-run-x/home', 'abc');
    expect(real).toMatch(/^dev\.useatelier\.session\.[0-9a-f]{12}\.abc$/);
    expect(real).not.toBe(test);
    expect(jobLabel('atelierd', '/h')).toBe(`dev.useatelier.atelierd.${homeHash('/h')}`);
    expect(homeHash('/h')).toBe(homeHash('/h'));
  });

  test('only plain ids are accepted in a label', () => {
    expect(() => jobLabel('session', '/h', 'a b')).toThrow();
    expect(() => jobLabel('session', '/h', '../x')).toThrow();
  });
});

describe('plist', () => {
  const plist = jobPlist({ label: 'dev.useatelier.session.0123456789ab.t1', program: ['/A/Atelier', '/h/bin/pty-host.js', 'a&b<c>"d\''], env: { ELECTRON_RUN_AS_NODE: '1', X: '<&>' }, stderr: '/h/logs/atelierd.log' });

  test('sets the keys the spec requires: interactive priority, attributed to Atelier, one-shot', () => {
    expect(plist).toContain('<key>Label</key><string>dev.useatelier.session.0123456789ab.t1</string>');
    expect(plist).toContain('<key>ProcessType</key><string>Interactive</string>');
    expect(plist).toContain('<key>AssociatedBundleIdentifiers</key><array><string>app.atelier.desktop</string></array>');
    expect(plist).toContain('<key>KeepAlive</key><false/>');
    expect(plist).toContain('<key>RunAtLoad</key><true/>');
    expect(plist).toContain('<key>StandardErrorPath</key><string>/h/logs/atelierd.log</string>');
    expect(plist).not.toContain('StandardOutPath');
  });

  test('escapes every value as XML text', () => {
    expect(plist).toContain('<string>a&amp;b&lt;c&gt;&quot;d&apos;</string>');
    expect(plist).toContain('<key>X</key><string>&lt;&amp;&gt;</string>');
    expect(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });
});

test('parses `launchctl list` into labels', () => {
  const out = 'PID\tStatus\tLabel\n-\t0\tcom.apple.x\n123\t0\tdev.useatelier.session.0123456789ab.t1\n-\t7\tdev.useatelier.session.0123456789ab.t2\n';
  expect(parseLaunchctlList(out)).toEqual(['com.apple.x', 'dev.useatelier.session.0123456789ab.t1', 'dev.useatelier.session.0123456789ab.t2']);
});

describe('Launchd', () => {
  const setup = (reply: (args: string[]) => { code: number; stdout?: string; stderr?: string }) => {
    const runDir = join(mkdtempSync(join(tmpdir(), 'atl-ld-')), 'run');
    const calls: { args: string[]; plist?: { mode: number; text: string } }[] = [];
    const ld = new Launchd({
      runDir, uid: 501,
      run: async (args) => {
        const call: (typeof calls)[number] = { args };
        if (args[0] === 'bootstrap') { const f = args[2]!; call.plist = { mode: statSync(f).mode & 0o777, text: readFileSync(f, 'utf8') }; }
        calls.push(call);
        const r = reply(args);
        return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      }
    });
    return { ld, calls, runDir };
  };

  test('bootstrap writes the plist privately in run/, hands it to the gui domain, then removes it', async () => {
    const { ld, calls, runDir } = setup(() => ({ code: 0 }));
    await ld.bootstrap('dev.useatelier.session.0123456789ab.t1', '<plist/>');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.slice(0, 2)).toEqual(['bootstrap', 'gui/501']);
    expect(calls[0]!.args[2]).toBe(join(runDir, 'dev.useatelier.session.0123456789ab.t1.plist'));
    expect(calls[0]!.plist).toEqual({ mode: 0o600, text: '<plist/>' });
    expect(statSync(runDir).mode & 0o777).toBe(0o700);
    expect(existsSync(calls[0]!.args[2]!)).toBe(false);
  });

  test('a failed bootstrap throws with launchctl\'s message and still removes the plist', async () => {
    const { ld, calls } = setup(() => ({ code: 5, stderr: 'Bootstrap failed: 5: Input/output error' }));
    await expect(ld.bootstrap('dev.useatelier.session.0123456789ab.t1', '<plist/>')).rejects.toThrow(/Input\/output error/);
    expect(existsSync(calls[0]!.args[2]!)).toBe(false);
  });

  test('bootout targets the label in the gui domain; a job already gone is not an error', async () => {
    const { ld, calls } = setup((a) => ({ code: a[1]!.endsWith('.gone') ? 3 : 0, stderr: 'Boot-out failed: 3: No such process' }));
    expect(await ld.bootout('dev.useatelier.session.0123456789ab.t1')).toBe(true);
    expect(await ld.bootout('dev.useatelier.session.0123456789ab.gone')).toBe(false);
    expect(calls.map((c) => c.args)).toEqual([['bootout', 'gui/501/dev.useatelier.session.0123456789ab.t1'], ['bootout', 'gui/501/dev.useatelier.session.0123456789ab.gone']]);
  });

  test('ownLabels lists only the labels under one exact prefix', async () => {
    const { ld } = setup(() => ({ code: 0, stdout: 'PID\tStatus\tLabel\n-\t0\tdev.useatelier.session.aaaaaaaaaaaa.1\n-\t0\tdev.useatelier.session.aaaaaaaaaaaab.2\n-\t0\tdev.useatelier.session.bbbbbbbbbbbb.3\n' }));
    expect(await ld.ownLabels('dev.useatelier.session.aaaaaaaaaaaa')).toEqual(['dev.useatelier.session.aaaaaaaaaaaa.1']);
  });

  test('jobState: running with a pid, stopped without, absent when not loaded, unknown when launchctl fails', async () => {
    const { ld } = setup(() => ({ code: 0, stdout: 'PID\tStatus\tLabel\n123\t0\tdev.useatelier.atelierd.aaaaaaaaaaaa\n-\t0\tdev.useatelier.atelierd.bbbbbbbbbbbb\n' }));
    expect(await ld.jobState('dev.useatelier.atelierd.aaaaaaaaaaaa')).toBe('running');
    expect(await ld.jobState('dev.useatelier.atelierd.bbbbbbbbbbbb')).toBe('stopped');
    expect(await ld.jobState('dev.useatelier.atelierd.cccccccccccc')).toBe('absent');
    const failing = setup(() => ({ code: 1, stderr: 'timed out' }));
    expect(await failing.ld.jobState('dev.useatelier.atelierd.aaaaaaaaaaaa')).toBe('unknown');
  });

  test('refuses labels outside dev.useatelier', async () => {
    const { ld, calls } = setup(() => ({ code: 0 }));
    await expect(ld.bootstrap('com.apple.Finder', '<plist/>')).rejects.toThrow();
    await expect(ld.bootout('com.apple.Finder')).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
