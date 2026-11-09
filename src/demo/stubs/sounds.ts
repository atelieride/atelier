// The demo build's stand-in for src/renderer/dictation/sounds.ts (swapped in by compile/build.ts): dictation's start and
// end tones stay silent on the site, like the chime (stubs/chime.ts).
import type * as App from '../../renderer/dictation/sounds';

export const startSound: typeof App.startSound = () => {};

export const stopSound: typeof App.stopSound = () => {};

/** The app's module's exports, every one: a new one is a type error here. */
const _surface: { [K in keyof typeof App]: unknown } = { startSound, stopSound };
void _surface;
