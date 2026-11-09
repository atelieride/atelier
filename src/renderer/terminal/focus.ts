// Focus a terminal from modules that must not load xterm (the registry sets the real focuser at startup).
let focuser: (id: string) => void = () => {};

export function setTerminalFocuser(fn: (id: string) => void): void {
  focuser = fn;
}

export function focusTerminal(id: string): void {
  focuser(id);
}

// Whether the program in front of a terminal enabled bracketed paste (Claude and zsh do); false until the registry says.
let pasteProbe: (id: string) => boolean = () => false;

export function setBracketedProbe(fn: (id: string) => boolean): void {
  pasteProbe = fn;
}

export function isBracketed(id: string): boolean {
  return pasteProbe(id);
}

// When a terminal last received output (ms since the epoch; 0: never, or not mounted). The registry sets it.
let outputProbe: (id: string) => number = () => 0;

export function setOutputProbe(fn: (id: string) => number): void {
  outputProbe = fn;
}

export function lastOutputAt(id: string): number {
  return outputProbe(id);
}
