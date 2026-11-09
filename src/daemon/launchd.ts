import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, writeFileAtomic } from './fsutil';

/**
 * launchd jobs: only launchd gives a process a coalition of its own, and a Dock force
 * quit ends a whole coalition. atelierd and every terminal's shell run as one-shot jobs in the user's gui domain.
 *
 * Labels are `dev.useatelier.<kind>.<hash of ATELIER_HOME>[.<id>]`: a test home never names the user's real jobs,
 * and atelierd finds its own stale jobs by prefix. Only `bootstrap` / `bootout` / `list`, through
 * /bin/launchctl with an argv (never a shell); plists are written 0600 in ATELIER_HOME/run and removed once launchd
 * holds the job. Nothing secret goes in a plist: a session's environment travels over atelierd's host socket.
 */
export const JOB_PREFIX = 'dev.useatelier';
const ID = /^[A-Za-z0-9-]{1,64}$/;
const BUNDLE_ID = 'app.atelier.desktop';

export function homeHash(home: string): string {
  return createHash('sha256').update(home).digest('hex').slice(0, 12);
}

export function jobLabel(kind: 'atelierd' | 'session', home: string, id?: string): string {
  const base = `${JOB_PREFIX}.${kind}.${homeHash(home)}`;
  if (id === undefined) return base;
  if (!ID.test(id)) throw new Error(`invalid job id: ${id}`);
  return `${base}.${id}`;
}

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const str = (s: string): string => `<string>${xml(s)}</string>`;

/**
 * A one-shot job: interactive priority (left out, launchd throttles CPU and I/O: measured priority 20 instead of 31),
 * attributed to Atelier in System Settings (AssociatedBundleIdentifiers, Apple's advice for self-bootstrapped plists).
 */
export function jobPlist(o: { label: string; program: string[]; env: Record<string, string>; stdout?: string; stderr?: string }): string {
  const env = Object.entries(o.env).map(([k, v]) => `<key>${xml(k)}</key>${str(v)}`).join('');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `<key>Label</key>${str(o.label)}`,
    `<key>ProgramArguments</key><array>${o.program.map(str).join('')}</array>`,
    `<key>EnvironmentVariables</key><dict>${env}</dict>`,
    ...(o.stdout ? [`<key>StandardOutPath</key>${str(o.stdout)}`] : []),
    ...(o.stderr ? [`<key>StandardErrorPath</key>${str(o.stderr)}`] : []),
    '<key>ProcessType</key><string>Interactive</string>',
    `<key>AssociatedBundleIdentifiers</key><array>${str(BUNDLE_ID)}</array>`,
    '<key>RunAtLoad</key><true/>',
    '<key>KeepAlive</key><false/>',
    '</dict></plist>',
    ''
  ].join('\n');
}

export function parseLaunchctlList(out: string): string[] {
  return out.split('\n').slice(1).map((l) => l.split('\t')[2]?.trim() ?? '').filter(Boolean);
}

export type JobState = 'running' | 'stopped' | 'absent' | 'unknown';

export type LaunchctlRunner = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const runLaunchctl: LaunchctlRunner = (args) => new Promise((resolve) => {
  execFile('/bin/launchctl', args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
    const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
    resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
  });
});

export class Launchd {
  private readonly domain: string;
  private readonly run: LaunchctlRunner;

  constructor(private readonly o: { runDir: string; uid?: number; run?: LaunchctlRunner }) {
    this.domain = `gui/${o.uid ?? process.getuid?.() ?? 0}`;
    this.run = o.run ?? runLaunchctl;
  }

  private check(label: string): void {
    if (!label.startsWith(`${JOB_PREFIX}.`)) throw new Error(`not an Atelier job: ${label}`);
  }

  async bootstrap(label: string, plist: string): Promise<void> {
    this.check(label);
    ensureDir(this.o.runDir, 0o700);
    const file = join(this.o.runDir, `${label}.plist`);
    writeFileAtomic(file, plist, 0o600);
    try {
      const r = await this.run(['bootstrap', this.domain, file]);
      if (r.code !== 0) throw new Error(`launchctl bootstrap ${label}: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
    } finally {
      try { unlinkSync(file); } catch { /* already gone */ }
    }
  }

  /** true if a job was booted out; false if launchd had none by that label. */
  async bootout(label: string): Promise<boolean> {
    this.check(label);
    return (await this.run(['bootout', `${this.domain}/${label}`])).code === 0;
  }

  /**
   * running: loaded with a live process; stopped: loaded, its process gone; absent: not loaded; unknown: launchctl
   * could not tell (an error or a timeout under load). Callers that boot out act only on an explicit "stopped".
   */
  async jobState(label: string): Promise<JobState> {
    this.check(label);
    const r = await this.run(['list']);
    if (r.code !== 0) return 'unknown';
    for (const line of r.stdout.split('\n').slice(1)) {
      const [pid, , name] = line.split('\t');
      if (name?.trim() === label) return /^\d+$/.test(pid ?? '') ? 'running' : 'stopped';
    }
    return 'absent';
  }

  /** The labels loaded in the gui domain under `prefix.` (this home's jobs of one kind). */
  async ownLabels(prefix: string): Promise<string[]> {
    this.check(`${prefix}.`);
    const r = await this.run(['list']);
    return r.code === 0 ? parseLaunchctlList(r.stdout).filter((l) => l.startsWith(`${prefix}.`)) : [];
  }
}
