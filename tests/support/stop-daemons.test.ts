import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { bootOutRunJobs, stopRunDaemons } from './stop-daemons';
import { homeHash } from '../../src/daemon/launchd';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (f: () => boolean) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 20)); };

test('the run\'s leftover test atelierds are stopped; a pid that is not an atelierd is never touched', async () => {
  const run = mkdtempSync(join(tmpdir(), 'atl-stop-'));
  const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'daemon.js'], { stdio: 'ignore' });
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'other.js'], { stdio: 'ignore' });
  try {
    for (const [name, pid] of [['atl-e2e-a', daemon.pid], ['atl-e2e-b', other.pid]] as const) {
      mkdirSync(join(run, name));
      writeFileSync(join(run, name, 'atelierd.json'), JSON.stringify({ pid }));
    }
    mkdirSync(join(run, 'atl-e2e-c'));
    writeFileSync(join(run, 'atl-e2e-c', 'atelierd.json'), 'not json');
    expect(stopRunDaemons(run)).toEqual([daemon.pid]);
    await until(() => !alive(daemon.pid!));
    expect(alive(daemon.pid!)).toBe(false);
    expect(alive(other.pid!)).toBe(true);
  } finally {
    daemon.kill('SIGKILL');
    other.kill('SIGKILL');
  }
});

test('the run\'s launchd jobs (atelierd and sessions of its homes) are booted out; nobody else\'s', () => {
  const run = mkdtempSync(join(tmpdir(), 'atl-stop-'));
  mkdirSync(join(run, 'atl-e2e-a'));
  mkdirSync(join(run, 'atl-e2e-b'));
  const a = homeHash(join(run, 'atl-e2e-a'));
  const b = homeHash(join(run, 'atl-e2e-b'));
  const loaded = [`dev.useatelier.atelierd.${a}`, `dev.useatelier.session.${a}.t1`, `dev.useatelier.session.${b}.t2`,
    'dev.useatelier.atelierd.0123456789ab', 'dev.useatelier.session.0123456789ab.mine', 'com.apple.Finder'];
  const booted: string[] = [];
  expect(bootOutRunJobs(run, { list: () => loaded, bootout: (l) => { booted.push(l); } }))
    .toEqual([`dev.useatelier.atelierd.${a}`, `dev.useatelier.session.${a}.t1`, `dev.useatelier.session.${b}.t2`]);
  expect(booted).toEqual([`dev.useatelier.atelierd.${a}`, `dev.useatelier.session.${a}.t1`, `dev.useatelier.session.${b}.t2`]);
});
