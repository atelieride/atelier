import w400 from '@fontsource/poppins/files/poppins-latin-400-normal.woff2?url';
import w400ext from '@fontsource/poppins/files/poppins-latin-ext-400-normal.woff2?url';
import w500 from '@fontsource/poppins/files/poppins-latin-500-normal.woff2?url';
import w500ext from '@fontsource/poppins/files/poppins-latin-ext-500-normal.woff2?url';
import w600 from '@fontsource/poppins/files/poppins-latin-600-normal.woff2?url';
import w600ext from '@fontsource/poppins/files/poppins-latin-ext-600-normal.woff2?url';
import w700 from '@fontsource/poppins/files/poppins-latin-700-normal.woff2?url';
import w700ext from '@fontsource/poppins/files/poppins-latin-ext-700-normal.woff2?url';

/**
 * Poppins, the Docsy themes' typeface: the weights the interface uses, Latin and Latin Extended.
 * A module of its own, imported only when a theme asks for it (fonts.ts), so other themes and the live demo never
 * fetch it.
 */
export const POPPINS: readonly { weight: number; latin: string; latinExt: string }[] = [
  { weight: 400, latin: w400, latinExt: w400ext },
  { weight: 500, latin: w500, latinExt: w500ext },
  { weight: 600, latin: w600, latinExt: w600ext },
  { weight: 700, latin: w700, latinExt: w700ext }
];
