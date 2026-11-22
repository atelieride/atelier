// The pairing QR code as one SVG path: each run of dark modules in a row is one rectangle, in module units (the
// sheet's viewBox adds the quiet zone). lean-qr's nano build (MIT, no dependencies) encodes it; it comes with the
// pairing sheet's chunk, never the first paint.
import { correction, generate } from 'lean-qr/nano';

/** The QR code of `text` (medium error correction: still read with a glare or a smudge on the screen). */
export function qrPath(text: string): { size: number; d: string } {
  const code = generate(text, { minCorrectionLevel: correction.M });
  const n = code.size;
  let d = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n;) {
      if (!code.get(x, y)) { x++; continue; }
      let w = 1;
      while (x + w < n && code.get(x + w, y)) w++;
      d += `M${x} ${y}h${w}v1h-${w}z`;
      x += w;
    }
  }
  return { size: n, d };
}
