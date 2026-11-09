import { afterEach, expect, test } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDaemon, type LauncherLaunchd } from './daemon-launcher';
import { jobLabel, type JobState } from '../daemon/launchd';

// atelierd as a launchd job of its own: its own coalition, so a force quit of the Atelier
// window never takes the sessions with it. A fake launchd here: it starts the plist's program like launchd would.

const children: ChildProcess[] = [];
afterEach(() => { for (const c of children.splice(0)) c.kill('SIGKILL'); });

// A stand-in atelierd: listens on the socket and writes atelierd.json, as the real one does.
const FAKE = `const net=require('net'),fs=require('fs'),path=require('path');const home=process.env.ATELIER_HOME;
const sock=path.join(home,'atelierd.sock');try{fs.unlinkSync(sock)}catch{}
net.createServer(()=>{}).listen(sock,()=>fs.writeFileSync(path.join(home,'atelierd.json'),JSON.stringify({pid:process.pid,sock,token:'t',startedAt:Date.now(),version:process.argv[2]})));
setTimeout(()=>process.exit(0),5000);`;

function plistValues(plist: string): { program: string[]; env: Record<string, string> } {
  const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const program = [.../<key>ProgramArguments<\/key><array>(.*?)<\/array>/s.exec(plist)![1]!.matchAll(/<string>(.*?)<\/string>/g)].map((m) => unxml(m[1]!));
  const env = Object.fromEntries([.../<key>EnvironmentVariables<\/key><dict>(.*?)<\/dict>/s.exec(plist)![1]!.matchAll(/<key>(.*?)<\/key><string>(.*?)<\/string>/g)].map((m) => [unxml(m[1]!), unxml(m[2]!)]));
  return { program, env };
}

function setup(o: { fail?: boolean; states?: JobState[] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'atl-dl-'));
  const script = join(home, 'daemon.js');
  writeFileSync(script, FAKE);
  const calls: string[][] = [];
  let plist = '';
  const launchd: LauncherLaunchd = {
    jobState: async (label) => { calls.push(['jobState', label]); return (o.states && o.states.length > 1 ? o.states.shift() : o.states?.[0]) ?? 'stopped'; },
    bootout: async (label) => { calls.push(['bootout', label]); return true; },
    bootstrap: async (label, p) => {
      calls.push(['bootstrap', label]);
      plist = p;
      if (o.fail) throw new Error('Bootstrap failed: 5: Input/output error');
      const { program, env } = plistValues(p);
      children.push(spawn(program[0]!, program.slice(1), { env, stdio: 'ignore' }));
    }
  };
  return { home, script, calls, launchd, plist: () => plist };
}

test('starts atelierd as its own launchd job: label of this home, stale finished job booted out first', async () => {
  const s = setup();
  const info = await ensureDaemon({ execPath: process.execPath, script: s.script, version: '9.9.9', home: s.home, launchd: s.launchd });
  expect(info.version).toBe('--version=9.9.9');
  const label = jobLabel('atelierd', s.home);
  expect(s.calls).toEqual([['jobState', label], ['bootout', label], ['bootstrap', label]]);
  const { program, env } = plistValues(s.plist());
  expect(program).toEqual([process.execPath, s.script, '--version=9.9.9']);
  expect(env).toMatchObject({ ELECTRON_RUN_AS_NODE: '1', ATELIER_HOME: s.home });
  expect(s.plist()).toContain(`<key>StandardOutPath</key><string>${join(s.home, 'logs', 'atelierd.log')}</string>`);
  expect(s.plist()).toContain('<key>ProcessType</key><string>Interactive</string>');
});

test('a job of this home still running is never booted out (its sessions would close): plain spawn instead', async () => {
  const s = setup({ states: ['running'] });
  const info = await ensureDaemon({ execPath: process.execPath, script: s.script, version: '1', home: s.home, launchd: s.launchd });
  expect(s.calls.every((c) => c[0] === 'jobState')).toBe(true);
  children.push({ kill: (sig: NodeJS.Signals) => process.kill(info.pid, sig) } as unknown as ChildProcess);
  expect(info.pid).toBeGreaterThan(0);
});

test('launchd refusing the job falls back to the detached spawn (the job booted out first: never two atelierds), and the log says so', async () => {
  const s = setup({ fail: true });
  const info = await ensureDaemon({ execPath: process.execPath, script: s.script, version: '1', home: s.home, launchd: s.launchd });
  children.push({ kill: (sig: NodeJS.Signals) => process.kill(info.pid, sig) } as unknown as ChildProcess);
  expect(info.pid).toBeGreaterThan(0);
  const label = jobLabel('atelierd', s.home);
  expect(s.calls).toEqual([['jobState', label], ['bootout', label], ['bootstrap', label], ['bootout', label]]);
  expect(readFileSync(join(s.home, 'logs', 'atelierd.log'), 'utf8')).toMatch(/launchd.*Input\/output error.*spawned directly/);
});

test('launchd\'s state unknown (launchctl failed): nothing is booted out, plain spawn', async () => {
  const s = setup({ states: ['unknown'] });
  const info = await ensureDaemon({ execPath: process.execPath, script: s.script, version: '1', home: s.home, launchd: s.launchd });
  children.push({ kill: (sig: NodeJS.Signals) => process.kill(info.pid, sig) } as unknown as ChildProcess);
  expect(s.calls.map((c) => c[0])).toEqual(['jobState']);
});

test('after a restart the old atelierd may still be exiting: its job is waited for, then replaced through launchd', async () => {
  const s = setup({ states: ['running', 'running', 'stopped'] });
  await ensureDaemon({ execPath: process.execPath, script: s.script, version: '1', home: s.home, launchd: s.launchd });
  expect(s.calls.map((c) => c[0])).toEqual(['jobState', 'jobState', 'jobState', 'bootout', 'bootstrap']);
});

test('no job loaded at all: bootstrap without a bootout', async () => {
  const s = setup({ states: ['absent'] });
  await ensureDaemon({ execPath: process.execPath, script: s.script, version: '1', home: s.home, launchd: s.launchd });
  expect(s.calls.map((c) => c[0])).toEqual(['jobState', 'bootstrap']);
});

test('a variable launchd could not read (control characters) stays out of the plist; the others go in', async () => {
  const s = setup({ states: ['absent'] });
  process.env.ATL_TEST_CTRL = 'a\u0001b';
  process.env.ATL_TEST_CR = 'a\rb';
  process.env.ATL_TEST_OK = 'tab\there & <ok>';
  try {
    await ensureDaemon({ execPath: process.execPath, script: s.script, version: '1', home: s.home, launchd: s.launchd });
  } finally {
    delete process.env.ATL_TEST_CTRL; delete process.env.ATL_TEST_CR; delete process.env.ATL_TEST_OK;
  }
  const { env } = plistValues(s.plist());
  expect(env.ATL_TEST_CTRL).toBeUndefined();
  expect(env.ATL_TEST_CR).toBeUndefined();
  expect(env.ATL_TEST_OK).toBe('tab\there & <ok>');
});
