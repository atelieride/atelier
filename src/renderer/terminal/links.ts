import type { ILink, Terminal } from '@xterm/xterm';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { linkClickAction } from '@shared/links';
import { foldersAbove, linksAt, rowFromCells, type CellRow, type Row, type WrappedLink } from '@shared/wrapped-paths';
import { useApp } from '../store';
import { isAbsPath, toCanonical } from '@shared/paths';
import { isMod } from '@shared/keys';
import { windowModKey, type ModKey } from './mod-key';

type Found = { path: string; rel: string; folder?: true } | null;
const cache = new Map<string, Promise<Found>>();

/** New files must become clickable: the cache is short-lived. */
function cached(key: string, ask: () => Promise<Found>): Promise<Found> {
  let p = cache.get(key);
  if (!p) {
    p = ask().catch(() => null);
    cache.set(key, p);
    setTimeout(() => cache.delete(key), 10000);
  }
  return p;
}

const resolveCached = (candidate: string, cwd: string) => cached(`${cwd}\u0000${candidate}`, () => window.atelier.files.resolve(candidate, cwd));
const claudeCached = (path: string) => cached(`claude\u0000${path}`, () => window.atelier.files.claudeTemp.resolve(path));
const outsideCached = (path: string) => cached(`outside\u0000${path}`, () => window.atelier.files.outside.resolve(path));

/**
 * Where a terminal path leads: a project file (at a line), a file in Claude's temp folder (read-only), a folder in it
 * (opened in Finder), or, outside both, a path main hasn't checked yet (`outside`: checked only while ⌘ is held,
 * opened read-only; `path` as written, `~/` included).
 */
export interface LinkTarget { path: string; rel: string; line: number | null; claude: boolean; folder?: true; outside?: true }
export interface TargetDeps {
  resolve(candidate: string): Promise<Found>;
  /** Only asked for absolute paths, files or folders, the project doesn't hold. */
  claudeResolve(path: string): Promise<Found>;
}

const isHomePath = (p: string) => p.startsWith('~/') || p.startsWith('~\\');

async function targetOf(l: WrappedLink, deps: TargetDeps, above: () => string[], outside = true): Promise<LinkTarget | null> {
  if (l.kind === 'folder') {
    const c = await deps.claudeResolve(l.path);
    return c?.folder ? { path: c.path, rel: c.rel, line: null, claude: true, folder: true } : null;
  }
  const r = await deps.resolve(l.path);
  if (r) return { path: r.path, rel: r.rel, line: l.line, claude: false };
  // In the form IPC carries (C:/… and ~/… on Windows, where Claude prints backslashes).
  const unchecked: LinkTarget | null = outside ? { path: toCanonical(l.path), rel: '', line: l.line, claude: false, outside: true } : null;
  if (isHomePath(l.path)) return unchecked;
  if (!isAbsPath(l.path)) {
    // A bare name Claude listed under a folder it wrote above: tried there, nearest folder first; never an
    // outside guess (the first folder would always win, checked or not).
    for (const dir of above()) {
      const t = await targetOf({ ...l, path: dir + l.path }, deps, () => [], false);
      if (t) return t;
    }
    return null;
  }
  // Any file kind; main refuses, without touching the disk, a path not written under the temp folder.
  const c = await deps.claudeResolve(l.path);
  return c && !c.folder ? { path: c.path, rel: c.rel, line: l.line, claude: true } : unchecked;
}

/**
 * The links on row y (0-based) and where they lead: paths found in the row's logical line (rows Claude or xterm
 * wrapped), each reported by its piece on this row. A joined path that leads nowhere, or
 * only to an unchecked outside path, gives way to the row's own candidates when one of them leads somewhere known.
 */
export async function linkTargets(row: (y: number) => Row | undefined, y: number, cols: number, deps: TargetDeps): Promise<{ start: number; end: number; target: LinkTarget }[]> {
  let folders: string[] | null = null;
  const above = () => (folders ??= foldersAbove(row, y, cols));
  const out = await Promise.all(linksAt(row, y, cols).map(async (l) => {
    const t = await targetOf(l, deps, above);
    if (t && !t.outside) return [{ l, t }];
    const alone = (await Promise.all((l.alone ?? []).map(async (a) => ({ l: a, t: await targetOf(a, deps, above) }))))
      .filter((x): x is { l: WrappedLink; t: LinkTarget } => x.t !== null);
    return t && !alone.some((x) => !x.t.outside) ? [{ l, t }] : alone;
  }));
  return out.flat().map(({ l, t }) => {
    const p = l.pieces.find((x) => x.y === y)!;
    return { start: p.start, end: p.end, target: t };
  });
}

/** The link under the pointer, from any provider (OSC 8, URLs, files): what a ⌘-click opens. */
export class HoveredLink {
  current: (() => void) | null = null;
  // xterm leaves the current link before hovering the next one: a leave always concerns the current link.
  hover(open: () => void): void { this.current = open; }
  leave(): void { this.current = null; }
}

export interface OutsideLinkDeps {
  mod: ModKey;
  hovered: HoveredLink;
  /** Main's check (cached): a regular file it may open. Asked only while ⌘ is held (it touches the disk). */
  check(): Promise<boolean>;
  open(): void;
  /**
   * The terminal's hovered outside links, each by its stop: a terminal closed under the pointer gets no leave from
   * xterm, so its registry stops them.
   */
  active: Set<() => void>;
}

/**
 * A path outside the project and Claude's temp folder: a link shown only while ⌘ is held
 * over it and main says it is a file. A plain click is the program's or the selection's. Only once main said it is a
 * file does a ⌘-click belong to it (interceptLinkClicks, through the hovered link), so one on any other token is left
 * to the program; xterm's own activation with ⌘ opens it too. xterm applies decoration changes to the link
 * it holds as hovered, so they change only between hover and leave, and are reset at leave for the next hover.
 */
export function outsideLink(base: Pick<ILink, 'range' | 'text'>, d: OutsideLinkDeps): ILink {
  let over = false;
  let off: (() => void) | null = null;
  const set = (on: boolean) => {
    const dec = link.decorations;
    if (!over || !dec) return;
    dec.pointerCursor = on;
    dec.underline = on;
    if (on) d.hovered.hover(d.open); else d.hovered.leave();
  };
  const show = (held: boolean) => {
    if (!held) { set(false); return; }
    void d.check().then((ok) => { if (ok && over && d.mod.held) set(true); }, () => {});
  };
  const stop = () => {
    over = false;
    off?.();
    off = null;
    d.active.delete(stop);
  };
  const link: ILink = {
    ...base,
    decorations: { pointerCursor: false, underline: false },
    activate: (e) => { if (isMod(e)) d.open(); },
    hover: () => {
      over = true;
      off?.();
      off = d.mod.on(show);
      d.active.add(stop);
      show(d.mod.held);
    },
    leave: () => {
      if (over) set(false);
      stop();
    }
  };
  return link;
}

const mouseTracking = (term: Terminal) => term.modes.mouseTrackingMode !== 'none';

/** Releases that moved the shell's cursor (click to move, in the command being typed): no link opens on them. */
const claimed = new WeakSet<MouseEvent>();
export function claimClick(e: MouseEvent): void { claimed.add(e); }

/** A link's activation by xterm (click released on it): never while the program captures the mouse, unless ⌘. */
export function linkActivate(term: Terminal, open: () => void): (e: MouseEvent) => void {
  return (e) => {
    if (claimed.has(e)) return;
    if (linkClickAction({ metaKey: isMod(e), mouseTracking: mouseTracking(term) }) !== 'ignore') open();
  };
}

/**
 * ⌘-click on a hovered link: Atelier opens it on release and neither the program (mouse report) nor xterm sees the
 * click. Capture phase on the host, before xterm's own listeners.
 */
export function interceptLinkClicks(host: HTMLElement, term: Terminal, hovered: HoveredLink): void {
  host.addEventListener('mousedown', (e) => {
    const open = hovered.current;
    if (e.button !== 0 || !open || linkClickAction({ metaKey: isMod(e), mouseTracking: mouseTracking(term) }) !== 'intercept') return;
    e.preventDefault();
    e.stopPropagation();
    // The release may come after a redraw has dropped the hover: the link pressed is the one opened.
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mouseup', up, true);
      if (!host.contains(ev.target as Node)) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.button === 0) open();
    };
    window.addEventListener('mouseup', up, true);
  }, true);
}

/** Links in the terminal; the returned function stops what they still follow once the terminal is disposed. */
export function registerLinks(term: Terminal, terminalId: string, hovered: HoveredLink): () => void {
  const active = new Set<() => void>();
  const openUrl = (url: string) => { void window.atelier.openUrl(url); };
  term.loadAddon(new WebLinksAddon((e, url) => linkActivate(term, () => openUrl(url))(e), {
    hover: (_e, url) => hovered.hover(() => openUrl(url)),
    leave: () => hovered.leave()
  }));
  term.registerLinkProvider({
    provideLinks(y, callback) {
      // xterm counts rows from 1; the buffer from 0.
      const buf = term.buffer.active;
      // Read from cells: wide characters take two, so fullness and underlines line up with the screen.
      const rows = new Map<number, CellRow | undefined>();
      const row = (i: number): CellRow | undefined => {
        if (rows.has(i)) return rows.get(i);
        const l = buf.getLine(i);
        const cells: { chars: string; width: number }[] = [];
        if (l) for (let x = 0; x < l.length; x++) { const c = l.getCell(x); if (c) cells.push({ chars: c.getChars(), width: c.getWidth() }); }
        const r = l ? rowFromCells(cells, l.isWrapped) : undefined;
        rows.set(i, r);
        return r;
      };
      const here = row(y - 1);
      const text = here?.text ?? '';
      const st = useApp.getState();
      const cwd = st.terminals.find((x) => x.id === terminalId)?.cwd ?? st.project?.root ?? '/';
      void linkTargets(row, y - 1, term.cols, { resolve: (c) => resolveCached(c, cwd), claudeResolve: claudeCached }).then((found) => {
        callback(found.length ? found.map(({ start, end, target: t }) => {
          // String columns to cells; xterm's range is 1-based and its end inclusive.
          const range = { start: { x: (here?.startCell[start] ?? start) + 1, y }, end: { x: here?.endCell[end - 1] ?? end, y } };
          if (t.outside) {
            // Checked and granted (read-only) by main only now, on the ⌘-click.
            const openOutside = () => {
              void window.atelier.files.outside.open(t.path)
                .then((o) => { if (o) useApp.getState().openFile(o.path, o.rel, t.line, undefined, { preview: true }); })
                .catch(() => {});
            };
            return outsideLink({ range, text: text.slice(start, end) }, { mod: windowModKey(), hovered, active, check: () => outsideCached(t.path).then((f) => f !== null), open: openOutside });
          }
          const open = () => {
            if (!t.claude) { useApp.getState().openFile(t.path, t.rel, t.line, undefined, { preview: true }); return; }
            // A folder in Claude's temp folder: main checks it again and opens it in Finder. A refusal (the folder went
            // away since the hover) leaves nothing to say, like a file that no longer opens.
            if (t.folder) { void window.atelier.files.claudeTemp.reveal(t.path).catch(() => false); return; }
            // Granted (read-only) only now, on the click: hovering never grants.
            void window.atelier.files.claudeTemp.open(t.path)
              .then((o) => { if (o) useApp.getState().openFile(o.path, o.rel, t.line, undefined, { preview: true }); })
              .catch(() => {});
          };
          const link: ILink = {
            range,
            text: text.slice(start, end),
            decorations: { pointerCursor: true, underline: true },
            activate: linkActivate(term, open),
            hover: () => hovered.hover(open),
            leave: () => hovered.leave()
          };
          return link;
        }) : undefined);
      });
    }
  });
  // The terminal goes: its hovered outside links stop following ⌘ (xterm sends them no leave).
  return () => { for (const stop of [...active]) stop(); };
}
