import sans from '@fontsource-variable/instrument-sans/files/instrument-sans-latin-wght-normal.woff2?url';
import sansExt from '@fontsource-variable/instrument-sans/files/instrument-sans-latin-ext-wght-normal.woff2?url';
import mono from '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url';
import monoExt from '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-ext-wght-normal.woff2?url';

// Fontsource subset ranges: Latin and Latin Extended are enough for the interface and the code.
const LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT = 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';

/** Loads the fonts before the first render: xterm measures the cells when it opens. */
export async function loadFonts(): Promise<void> {
  const faces = [
    new FontFace('Instrument Sans', `url(${sans})`, { weight: '400 700', unicodeRange: LATIN }),
    new FontFace('Instrument Sans', `url(${sansExt})`, { weight: '400 700', unicodeRange: LATIN_EXT }),
    new FontFace('JetBrains Mono', `url(${mono})`, { weight: '100 800', unicodeRange: LATIN }),
    new FontFace('JetBrains Mono', `url(${monoExt})`, { weight: '100 800', unicodeRange: LATIN_EXT })
  ];
  // Each face on its own: a missing one must not start the terminal before the others are ready.
  await Promise.allSettled([...faces.map(async (f) => { document.fonts.add(await f.load()); }), loadThemeFonts()]);
}

let poppins: Promise<void> | null = null;

/**
 * The faces the theme on screen asks for beyond Atelier's own (Poppins for Docsy), read from its
 * --font. Fetched once, on demand: Latin before resolving, Latin Extended only when some text needs it. Call it after
 * every theme change; for a theme that asks for nothing it does nothing.
 */
export function loadThemeFonts(root: Element = document.documentElement): Promise<void> {
  if (!getComputedStyle(root).getPropertyValue('--font').includes('Poppins')) return Promise.resolve();
  return (poppins ??= import('./fonts-poppins').then(async ({ POPPINS }) => {
    for (const w of POPPINS) document.fonts.add(new FontFace('Poppins', `url(${w.latinExt})`, { weight: String(w.weight), unicodeRange: LATIN_EXT }));
    const latin = POPPINS.map((w) => new FontFace('Poppins', `url(${w.latin})`, { weight: String(w.weight), unicodeRange: LATIN }));
    await Promise.allSettled(latin.map(async (f) => { document.fonts.add(await f.load()); }));
  }).catch(() => { poppins = null; /* the system font meanwhile; the next theme change tries again */ }));
}
