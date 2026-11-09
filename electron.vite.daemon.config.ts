import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';

// atelierd alone: electron.vite.config.ts (standaloneDaemon) builds it after the main process, into the same out/main.
export default defineConfig({
  main: {
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
    build: {
      emptyOutDir: false,
      rollupOptions: {
        input: {
          daemon: resolve(__dirname, 'src/daemon/index.ts'),
          // The terminals' launchd jobs run it; atelierd copies it into ATELIER_HOME/bin, so it
          // must come out as one file: it shares no module with the daemon (pty-host-entry.test.ts keeps it built-ins only).
          'pty-host': resolve(__dirname, 'src/daemon/pty-host-main.ts')
        }
      }
    }
  }
});
