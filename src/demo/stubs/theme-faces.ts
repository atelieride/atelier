// The demo build's stand-in for src/renderer/fonts-poppins.ts (swapped in by compile/build.ts): the only themes whose
// face it is are out of the demo (stubs/themes-docsy.ts), so their font files stay out of the site too. Named apart
// so its chunk's name doesn't carry the face's either.
import type * as App from '../../renderer/fonts-poppins';

export const POPPINS: typeof App.POPPINS = [];

/** The app's module's exports, every one: a new one is a type error here. */
const _surface: { [K in keyof typeof App]: unknown } = { POPPINS };
void _surface;
