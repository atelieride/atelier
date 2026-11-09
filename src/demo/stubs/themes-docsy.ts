// The demo build's stand-in for src/shared/themes-docsy.ts (swapped in by compile/build.ts): the website never names
// the company, so its two themes are not in the demo's list (their stylesheet is swapped for stubs/themes-docsy.css).
import type * as App from '../../shared/themes-docsy';

export const DOCSY_THEMES: typeof App.DOCSY_THEMES = [];

/** The app's module's exports, every one: a new one is a type error here. */
const _surface: { [K in keyof typeof App]: unknown } = { DOCSY_THEMES };
void _surface;
