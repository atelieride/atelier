import path from 'node:path';
import { daemonPaths, type DaemonPaths } from '@shared/paths.node';
import { currentPlatform } from '@shared/platform';
import { installPtyHost } from './install';
import { createLogger } from './log';
import { runDaemon } from './main';

// An unexpected error must not bring down all sessions: log it and carry on.
const crashLog = createLogger(daemonPaths().log);
process.on('uncaughtException', (err) => crashLog(`uncaught exception: ${err.stack ?? String(err)}`));
process.on('unhandledRejection', (err) => crashLog(`unhandled promise rejection: ${String(err)}`));

// Started by the app with ELECTRON_RUN_AS_NODE=1: argv = [electron, daemon.js, --version=x.y.z]
const version = process.argv.find((a) => a.startsWith('--version='))?.slice('--version='.length) ?? '0.0.0';

// Each terminal in a launchd job of its own: the job starts as this executable (Atelier's,
// which keeps the terminals' privacy grants) and runs atelierd's own copies of pty-host.js and the native host.
const isolation = (paths: DaemonPaths) => installPtyHost(paths, {
  execPath: process.execPath,
  hostScript: path.join(__dirname, 'pty-host.js'),
  nativeHosts: [
    path.join(path.dirname(process.execPath), '..', 'Resources', 'bin', 'atelier-pty-host'),
    path.join(__dirname, '..', '..', 'vendor', 'bin', 'atelier-pty-host')
  ]
});

// Windows: ConPTY terminals from node-pty (no launchd jobs) and no capture of a login
// shell's environment (GUI apps inherit the registry's).
const mac = currentPlatform() === 'darwin';
// Windows: the bridge from the runtime's resources (packaged), else a dev build's vendor/bin.
const bridges = [
  path.join(path.dirname(process.execPath), 'resources', 'bin', 'atelier-bridge.exe'),
  path.join(__dirname, '..', '..', 'vendor', 'bin', 'atelier-bridge.exe')
];
runDaemon({ version, captureShellEnv: mac, isolation: mac ? isolation : undefined, bridges: mac ? undefined : bridges, onStopped: () => process.exit(0) })
  .then((d) => {
    const shutdown = () => { void d.stop().then(() => process.exit(0)); };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    process.on('SIGHUP', () => { /* app detached: stay alive */ });
  })
  .catch((err: Error) => {
    // Another atelierd is already alive: exiting quietly is the correct behavior.
    process.stderr.write(`atelierd: ${err.message}\n`);
    process.exit(err.message.includes('already running') ? 0 : 1);
  });
