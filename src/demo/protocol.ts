import type { MenuCommand } from '../shared/api';

// The messages between the website and the live demo it frames, shared by both sides: the site's
// scripts/live-demo*.ts and the demo's shell. Pure TypeScript, no DOM or Node: it compiles for the site, the demo
// build and the tests alike. The page and the iframe are same-origin (the demo is served from /demo-app/); each side
// checks `event.origin` and `event.source` itself, then these guards check the shape, strictly: a message with an
// unknown type, a missing or extra field, or a field of the wrong type is ignored, so neither side acts on something
// it did not mean to receive (another script's postMessage, a browser extension, an older demo build).

/** Every message carries it: the first thing a listener checks. */
export const DEMO_SOURCE = 'atelier-demo';
/** Where the demo build lives on the site; the manifest's paths are relative to it. */
export const DEMO_BASE = '/demo-app/';
/** The iframe's address: the folder on the built site (Cloudflare Pages redirects index.html to it, a round trip);
 *  astro dev serves only the files in public/, so there it names index.html. */
export const demoEntry = (dev: boolean): string => (dev ? `${DEMO_BASE}index.html` : DEMO_BASE);

type Msg<T> = { source: typeof DEMO_SOURCE } & T;

/**
 * Views of the demo itself, beyond the menu's commands (src/demo/shell/open-view.ts), for a feature row no command
 * shows: `demo:editor` is Files with a changed file open in the editor; `demo:json` is package.json with its tree;
 * `demo:ask` is Ask open on a session at work.
 */
export const DEMO_VIEWS = ['demo:editor', 'demo:json', 'demo:ask'] as const;
/** What the page's `open` asks for: a command the native menu sends, or a demo view. */
export type DemoView = MenuCommand | (typeof DEMO_VIEWS)[number];

/** A keydown the page re-dispatches into the demo (focus was on the page): exactly what the app's handlers read. */
export interface DemoKey { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; repeat: boolean }

/** Demo → page. `ready`: its first frame is painted (the page cross-fades from the poster). `exit`: a way out (lights,
 *  "Exit demo"). `failed`: it cannot run (a script error before `ready`). `checklist`: "Things to try" progress.
 *  `fullscreen`: the green light (the page owns the iframe element, so it asks for full screen). */
export type DemoToPage =
  | Msg<{ type: 'ready' }>
  | Msg<{ type: 'exit' }>
  | Msg<{ type: 'failed'; reason: string }>
  | Msg<{ type: 'checklist'; done: number; total: number }>
  | Msg<{ type: 'fullscreen' }>;

/** Page → demo. `focus`: the iframe has the focus again (the app focuses its pane). `key`: a re-dispatched keydown.
 *  `pause`/`resume`: the demo is hidden/shown again (its clock stops). `open`: start on this view (a feature row). */
export type PageToDemo =
  | Msg<{ type: 'focus' }>
  | Msg<{ type: 'key'; key: DemoKey }>
  | Msg<{ type: 'pause' }>
  | Msg<{ type: 'resume' }>
  | Msg<{ type: 'open'; view: DemoView }>;

export type DemoMessage = DemoToPage | PageToDemo;
/** A message as written by its sender, before demoMessage() stamps the source on. */
export type MessageBody<M> = M extends unknown ? Omit<M, 'source'> : never;

/** What the demo build writes to demo-app/manifest.json and the site inlines at build time for its intent prefetch:
 *  the entry chunk, the other files the first paint needs and the fonts it loads before it, as paths relative to
 *  DEMO_BASE. Other keys are allowed (the build may record more). */
export interface DemoManifest { entry: string; firstPaint: string[]; fonts?: string[] }

const bool = (v: unknown) => typeof v === 'boolean';
const text = (max: number) => (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= max;
const count = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 100;
const exact = (o: unknown, fields: Record<string, (v: unknown) => boolean>): o is Record<string, unknown> => {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return false;
  const keys = Object.keys(o);
  return keys.length === Object.keys(fields).length && keys.every((k) => Object.hasOwn(fields, k) && fields[k]!((o as Record<string, unknown>)[k]));
};
const KEY = { key: text(32), code: text(32), metaKey: bool, ctrlKey: bool, altKey: bool, shiftKey: bool, repeat: bool };
// A MenuCommand's shape (`view-docker`, `new-terminal-profile:zsh`, a demo view's `demo:editor`); whether the demo knows
// it is the demo's call.
const view = (v: unknown) => typeof v === 'string' && v.length <= 64 && /^[a-z][a-z0-9-]*(?::[a-z0-9-]+)?$/.test(v);

const FROM_DEMO: Record<DemoToPage['type'], Record<string, (v: unknown) => boolean>> = {
  ready: {}, exit: {}, fullscreen: {}, failed: { reason: text(500) }, checklist: { done: count, total: count }
};
const TO_DEMO: Record<PageToDemo['type'], Record<string, (v: unknown) => boolean>> = {
  focus: {}, pause: {}, resume: {}, key: { key: (v) => exact(v, KEY) }, open: { view }
};

function check(data: unknown, shapes: Record<string, Record<string, (v: unknown) => boolean>>): boolean {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
  const { source, type, ...rest } = data as Record<string, unknown>;
  if (source !== DEMO_SOURCE || typeof type !== 'string' || !Object.hasOwn(shapes, type)) return false;
  return exact(rest, shapes[type]!) && (type !== 'checklist' || (rest.done as number) <= (rest.total as number));
}

export const isDemoToPage = (data: unknown): data is DemoToPage => check(data, FROM_DEMO);
export const isPageToDemo = (data: unknown): data is PageToDemo => check(data, TO_DEMO);

/** A message with its source stamped on. */
export const demoMessage = <M extends MessageBody<DemoMessage>>(m: M): M & { source: typeof DEMO_SOURCE } => ({ source: DEMO_SOURCE, ...m });

/** The fields of a KeyboardEvent the demo needs to replay it (an event itself cannot cross postMessage). */
export const keyFromEvent = (e: DemoKey): DemoKey =>
  ({ key: e.key, code: e.code, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, repeat: e.repeat });

// A relative path of plain segments: no scheme, no leading slash, no `.`/`..` segment, no backslash.
const safePath = (p: unknown) => typeof p === 'string' && p.length <= 200 && /^[\w-][\w.-]*(?:\/[\w-][\w.-]*)*$/.test(p);
const paths = (v: unknown) => Array.isArray(v) && v.every(safePath);
export const isDemoManifest = (m: unknown): m is DemoManifest =>
  typeof m === 'object' && m !== null && safePath((m as DemoManifest).entry) && paths((m as DemoManifest).firstPaint)
  && ((m as DemoManifest).fonts === undefined || paths((m as DemoManifest).fonts));
