import type { TerminalInfo } from './protocol';

/**
 * A terminal just created or resumed, before atelierd's next list (sent ~100 ms later): added at the end, unless the
 * list already brought it (then the listed entry wins and the same array comes back, so nothing re-renders).
 */
/**
 * A terminal as atelierd sent it, made safe for code that reads it as typed. node-pty's `process` is undefined on
 * macOS while the foreground process group's leader is gone (`base64 -i missing | gh secret set …`: base64 exits,
 * gh still runs), so atelierd's JSON can lack `foreground`: it becomes '' (no name known, neither a shell nor an
 * editor). A well-formed entry comes back as the same object.
 */
export function wellFormedTerminal(info: TerminalInfo): TerminalInfo {
  return typeof info.foreground === 'string' ? info : { ...info, foreground: '' };
}

export function withTerminal(list: TerminalInfo[], info: TerminalInfo): TerminalInfo[] {
  return list.some((t) => t.id === info.id) ? list : [...list, info];
}
