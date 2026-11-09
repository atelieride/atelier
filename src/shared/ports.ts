/**
 * Listening TCP ports of terminals. Main reads them over each terminal's process tree and sends every
 * window `PortsMap` for its project: terminal id → its ports (sorted, once, at most MAX_PORTS). Terminals without ports
 * are absent.
 */
export interface PortInfo {
  port: number;
  /** The listening process's command name (e.g. "node"), when lsof reported it. */
  name?: string;
}
export type PortsMap = Record<string, PortInfo[]>;

export const MAX_PORTS = 8;
/** How many port chips a row or bar shows before a "+N" chip that lists the rest. */
export const SHOWN_PORTS = 2;

/** The chips to show and the rest folded into "+N". */
export function chipPorts(list: readonly PortInfo[], shown = SHOWN_PORTS): { shown: PortInfo[]; rest: PortInfo[] } {
  return { shown: list.slice(0, shown), rest: list.slice(shown) };
}

/** The URL a port chip opens (always localhost, built by main from a port it listed). */
export const portUrl = (port: number) => `http://localhost:${port}/`;

/** The first port of the OS's ephemeral range: the random ports of test runs and outgoing connections. */
export const EPHEMERAL_MIN = 49152;
export const isEphemeralPort = (p: number) => p >= EPHEMERAL_MIN;
/** The ports to show: ephemeral ones (49152–65535) only when the user asked for them. */
export function visiblePorts<T extends { port: number }>(list: readonly T[], showEphemeral: boolean): T[] {
  return showEphemeral ? [...list] : list.filter((p) => !isEphemeralPort(p.port));
}
