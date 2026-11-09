// Build-time inputs of the demo bundle (vite.demo.config.ts): the compiled world as a virtual module, the app version.
declare module 'virtual:demo-world' {
  import type { DemoWorld } from './types';
  const world: DemoWorld;
  export default world;
}

/** package.json's version, defined by the demo build. */
declare const __ATELIER_VERSION__: string;
