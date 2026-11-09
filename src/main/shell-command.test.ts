import { describe, expect, test } from 'vitest';
import { adminScript, installShellCommand, uninstallShellCommand, type ShellCommandDeps } from './shell-command';

const SCRIPT = '/Applications/Atelier.app/Contents/Resources/bin/atelier';
const LINK = '/usr/local/bin/atelier';
const errno = (code: string) => Object.assign(new Error(code), { code });

/** A fake disk: path → link target ('' = a regular file). */
function fake(disk: Record<string, string>, opts: { writable?: boolean; admin?: boolean } = {}) {
  const calls: string[] = [];
  const d: ShellCommandDeps = {
    packaged: true,
    script: SCRIPT,
    link: LINK,
    entry: (p) => (p in disk ? (disk[p] ? { link: disk[p]! } : { link: null }) : null),
    makeLink: (target, p) => { if (opts.writable === false) throw errno('EACCES'); calls.push(`ln ${target} ${p}`); disk[p] = target; },
    removeLink: (p) => { if (opts.writable === false) throw errno('EACCES'); calls.push(`rm ${p}`); delete disk[p]; },
    makeDir: (dir) => { if (opts.writable === false) throw errno('EACCES'); calls.push(`mkdir ${dir}`); },
    admin: async (script) => { calls.push(`admin ${script}`); return opts.admin ?? true; }
  };
  return { d, calls, disk };
}

describe('install', () => {
  test('a link to the script in the app, made directly when the folder is writable', async () => {
    const { d, calls, disk } = fake({});
    expect(await installShellCommand(d)).toEqual({ ok: 'installed' });
    expect(calls).toEqual(['mkdir /usr/local/bin', `ln ${SCRIPT} ${LINK}`]);
    expect(disk[LINK]).toBe(SCRIPT);
  });

  test('already ours: nothing to do', async () => {
    const { d, calls } = fake({ [LINK]: SCRIPT });
    expect(await installShellCommand(d)).toEqual({ ok: 'already' });
    expect(calls).toEqual([]);
  });

  test("a link to another copy of Atelier is replaced; anything else named atelier is never touched", async () => {
    const other = fake({ [LINK]: '/Users/me/Old/Atelier.app/Contents/Resources/bin/atelier' });
    expect(await installShellCommand(other.d)).toEqual({ ok: 'installed' });
    expect(other.calls).toEqual(['mkdir /usr/local/bin', `rm ${LINK}`, `ln ${SCRIPT} ${LINK}`]);
    const file = fake({ [LINK]: '' });
    expect(await installShellCommand(file.d)).toEqual({ error: 'foreign', detail: LINK });
    const elsewhere = fake({ [LINK]: '/opt/homebrew/bin/atelier' });
    expect(await installShellCommand(elsewhere.d)).toEqual({ error: 'foreign', detail: LINK });
    expect([...file.calls, ...elsewhere.calls]).toEqual([]);
  });

  test('a folder only root can write: macOS asks for an administrator password; cancelling is not an error', async () => {
    const ok = fake({}, { writable: false, admin: true });
    expect(await installShellCommand(ok.d)).toEqual({ ok: 'installed' });
    expect(ok.calls).toEqual([`admin ${adminScript('install', SCRIPT, LINK)}`]);
    const no = fake({}, { writable: false, admin: false });
    expect(await installShellCommand(no.d)).toEqual({ error: 'cancelled' });
  });

  test('a development build never installs (the link would lead into the repository)', async () => {
    const { d, calls } = fake({});
    expect(await installShellCommand({ ...d, packaged: false })).toEqual({ error: 'dev' });
    expect(calls).toEqual([]);
  });
});

describe('uninstall', () => {
  test('removes our link only', async () => {
    const ours = fake({ [LINK]: SCRIPT });
    expect(await uninstallShellCommand(ours.d)).toEqual({ ok: 'uninstalled' });
    expect(ours.calls).toEqual([`rm ${LINK}`]);
    expect(await uninstallShellCommand(fake({}).d)).toEqual({ error: 'not-installed' });
    const foreign = fake({ [LINK]: '' });
    expect(await uninstallShellCommand(foreign.d)).toEqual({ error: 'foreign', detail: LINK });
    expect(foreign.calls).toEqual([]);
  });

  test('a development build never removes anything, not even a link to the installed Atelier', async () => {
    const { d, calls, disk } = fake({ [LINK]: SCRIPT });
    expect(await uninstallShellCommand({ ...d, packaged: false, script: '/repo/node_modules/electron/dist/Electron.app/Contents/Resources/bin/atelier' })).toEqual({ error: 'dev' });
    expect(calls).toEqual([]);
    expect(disk[LINK]).toBe(SCRIPT);
  });

  test('a root-owned folder: through the administrator password', async () => {
    const { d, calls } = fake({ [LINK]: SCRIPT }, { writable: false });
    expect(await uninstallShellCommand(d)).toEqual({ ok: 'uninstalled' });
    expect(calls).toEqual([`admin ${adminScript('uninstall', SCRIPT, LINK)}`]);
  });
});

test('the administrator script quotes both paths for the shell and for AppleScript', () => {
  const s = adminScript('install', '/Apps/My "Q" App\\x.app/Contents/Resources/bin/atelier', LINK);
  expect(s).toBe('do shell script "/bin/mkdir -p " & quoted form of "/usr/local/bin" & " && /bin/ln -sfn " & quoted form of "/Apps/My \\"Q\\" App\\\\x.app/Contents/Resources/bin/atelier" & " " & quoted form of "/usr/local/bin/atelier" with administrator privileges');
  expect(adminScript('uninstall', SCRIPT, LINK)).toBe('do shell script "/bin/rm -f " & quoted form of "/usr/local/bin/atelier" with administrator privileges');
});
