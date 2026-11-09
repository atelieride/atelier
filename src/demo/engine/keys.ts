// What a terminal's input means (the demo's programs read keys, not bytes): xterm.js sends raw sequences — ESC [ A for
// ↑, \r for Enter, \x7f for Backspace, ESC CR for Shift+Enter (the app's own), a lone ESC for Esc — and a paste between
// ESC [200~ and ESC [201~, which may come split over several writes (the renderer sends a long paste in pieces).

export type Key =
  | { t: 'text'; text: string }
  | { t: 'paste'; text: string }
  | { t: 'enter' } | { t: 'newline' } | { t: 'backspace' } | { t: 'delete' } | { t: 'tab' } | { t: 'esc' }
  | { t: 'up' } | { t: 'down' } | { t: 'left' } | { t: 'right' } | { t: 'home' } | { t: 'end' }
  | { t: 'ctrl'; key: string };

const CSI: Record<string, Key['t']> = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' };
const PASTE_START = '\u001b[200~';
const PASTE_END = '\u001b[201~';

/** A stateful reader: feed it each input chunk, it returns the keys (a paste is held until its end arrives). */
export function createKeyReader(): (chunk: string) => Key[] {
  let paste: string | null = null;
  return (chunk) => {
    const keys: Key[] = [];
    let text = '';
    const flush = () => { if (text) { keys.push({ t: 'text', text }); text = ''; } };
    let i = 0;
    while (i < chunk.length) {
      if (paste !== null) {
        const end = chunk.indexOf(PASTE_END, i);
        if (end < 0) { paste += chunk.slice(i); break; }
        keys.push({ t: 'paste', text: paste + chunk.slice(i, end) });
        paste = null;
        i = end + PASTE_END.length;
        continue;
      }
      if (chunk.startsWith(PASTE_START, i)) { flush(); paste = ''; i += PASTE_START.length; continue; }
      const c = chunk[i]!;
      if (c === '\u001b') {
        flush();
        const next = chunk[i + 1];
        if (next === undefined) { keys.push({ t: 'esc' }); i++; continue; }
        if (next === '\r') { keys.push({ t: 'newline' }); i += 2; continue; }
        if (next === '[' || next === 'O') {
          // CSI or SS3: parameters, then a final letter or ~.
          const m = /^[0-9;]*[A-Za-z~]/.exec(chunk.slice(i + 2));
          if (m) {
            const seq = m[0];
            const fin = seq.at(-1)!;
            if (CSI[fin]) keys.push({ t: CSI[fin] } as Key);
            else if (seq === '3~') keys.push({ t: 'delete' });
            else if (seq === '1~' || seq === '7~') keys.push({ t: 'home' });
            else if (seq === '4~' || seq === '8~') keys.push({ t: 'end' });
            i += 2 + seq.length;
            continue;
          }
        }
        // Alt+key and anything unknown: the escape alone.
        keys.push({ t: 'esc' });
        i++;
        continue;
      }
      const code = c.charCodeAt(0);
      if (c === '\r' || c === '\n') { flush(); keys.push({ t: 'enter' }); }
      else if (code === 0x7f || code === 0x08) { flush(); keys.push({ t: 'backspace' }); }
      else if (c === '\t') { flush(); keys.push({ t: 'tab' }); }
      else if (code < 0x20) { flush(); keys.push({ t: 'ctrl', key: String.fromCharCode(code + 0x60) }); }
      else text += c;
      i++;
    }
    flush();
    return keys;
  };
}
