import type { MotionPref } from './settings';

const ARG = '--atelier-intro=';

/** The launch argument that tells a window's page to play the launch animation, holding at least `holdMs` (the preload reads it). */
export function introArg(holdMs = 0): string {
  return `${ARG}${holdMs}`;
}

/** The hold in ms of the launch animation a page was opened with; null when it plays none. Garbage holds 0. */
export function introFromArgv(argv: readonly string[]): number | null {
  const a = argv.find((x) => x.startsWith(ARG));
  if (a === undefined) return null;
  const n = Number(a.slice(ARG.length));
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/**
 * Lets the launch animation through for the first window of an app start only: the first `take` uses the chance up,
 * whether or not it says yes, so a window opened later never plays it.
 */
export class IntroGate {
  private used = false;

  take(o: { launchAnimation: boolean; motion: MotionPref; hidden: boolean; testIntro: boolean }): boolean {
    if (this.used) return false;
    this.used = true;
    return o.launchAnimation && o.motion !== 'reduced' && (!o.hidden || o.testIntro);
  }
}
