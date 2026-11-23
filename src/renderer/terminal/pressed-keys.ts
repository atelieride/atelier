// xterm.js hands over a terminal's input in one stream: the keys the user presses and the answers the terminal gives
// its program by itself (device attributes, cursor position and mode reports, colors, focus reports). Told apart at
// the source, not by their bytes: for a key pressed, xterm fires its key event and then the same string as data, in
// one go; an answer, or text from an input method, comes as data alone.

interface KeyedTerminal {
  onKey(listener: (e: { key: string }) => void): unknown;
  onData(listener: (data: string) => void): unknown;
}

/** Sends each piece of the terminal's input on, with whether a key pressed in the terminal produced it. */
export function followPressedKeys(term: KeyedTerminal, send: (data: string, pressed: boolean) => void): void {
  let key: string | null = null;
  term.onKey((e) => {
    key = e.key;
    // Its data follows within the same call: a key xterm sends nothing for never marks what comes after it.
    queueMicrotask(() => { key = null; });
  });
  term.onData((data) => {
    const pressed = key !== null && data === key;
    key = null;
    send(data, pressed);
  });
}
