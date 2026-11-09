// Which atelierd code is running. atelierd only
// echoes the --version it was started with, so the app puts its own version there plus, as semver build metadata, a
// fingerprint of the code atelierd runs (main/daemon-fingerprint.ts). The app version alone says nothing: most updates
// leave atelierd unchanged, and a restart closes every session.

export interface DaemonBuild { version: string; build: string }

/** The --version an app passes to the atelierd it starts. */
export function daemonVersionArg(appVersion: string, fingerprint: string): string {
  return `${appVersion}+${fingerprint}`;
}

/** What atelierd echoes: the version of the app that started it and, from apps that send one, its fingerprint. */
export function parseDaemonVersion(reported: string): { version: string; build: string | null } {
  const i = reported.indexOf('+');
  if (i < 0) return { version: reported, build: null };
  return { version: reported.slice(0, i), build: reported.slice(i + 1) || null };
}

/**
 * Whether restarting atelierd would run different code. One started before fingerprints can only be compared by
 * version: different, it may be older code (once, after the first update that sends fingerprints).
 */
export function daemonOutdated(reported: string, app: DaemonBuild): boolean {
  const d = parseDaemonVersion(reported);
  return d.build === null ? d.version !== app.version : d.build !== app.build;
}
