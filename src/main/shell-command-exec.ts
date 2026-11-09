import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { execFile } from 'node:child_process';
import { lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { IPC, type ShellCommandResult } from '@shared/api';
import { SHELL_COMMAND_LINK, installShellCommand, uninstallShellCommand, type ShellCommandDeps } from './shell-command';

// The real disk and administrator prompt behind "Install 'atelier' Command". Only on a user's
// click; only /usr/local/bin/atelier, only a link to this app's script; osascript with a fixed program and the script
// built by adminScript (both paths quoted).

export function shellCommandDeps(packaged: boolean, resourcesPath: string): ShellCommandDeps {
  return {
    packaged,
    script: join(resourcesPath, 'bin', 'atelier'),
    link: SHELL_COMMAND_LINK,
    entry: (p) => {
      try {
        return lstatSync(p).isSymbolicLink() ? { link: readlinkSync(p) } : { link: null };
      } catch {
        return null;
      }
    },
    makeLink: (target, p) => symlinkSync(target, p),
    removeLink: (p) => unlinkSync(p),
    makeDir: (dir) => { mkdirSync(dir, { recursive: true }); },
    admin: (script) => new Promise((done) => {
      execFile('/usr/bin/osascript', ['-e', script], { timeout: 120_000 }, (err) => done(!err));
    })
  };
}

export function installShellCommandIpc(isTrusted: (e: IpcMainInvokeEvent) => boolean, deps: () => ShellCommandDeps): void {
  ipcMain.handle(IPC.shellCommandInstall, (e): Promise<ShellCommandResult> | ShellCommandResult => (isTrusted(e) ? installShellCommand(deps()) : { error: 'failed' }));
  ipcMain.handle(IPC.shellCommandUninstall, (e): Promise<ShellCommandResult> | ShellCommandResult => (isTrusted(e) ? uninstallShellCommand(deps()) : { error: 'failed' }));
}
